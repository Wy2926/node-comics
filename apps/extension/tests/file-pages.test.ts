import {mergeJobs} from '../src/reader/jobs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Api} from '../src/api';
import {StaleOperation} from '../src/concurrency';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';
import {needsTranslation} from '../src/translation/automatic';
import {applyMatch, matchFilePages, pageSource, sourceKey} from '../src/reader/recovery';
import type {FilePageMatch, Job, Page} from '../src/types';

const origin = 'https://api.example';
const page = (index: number): Page => ({...emptyPage(`${index}.png`, 100, 200), fileHash: index.toString(16).padStart(64, '0'), pageIndex: 0, blobKey: `original:${index}`});
const job = (status: Job['status'] = 'succeeded', extra: Partial<Job> = {}): Job => ({id: 'job',input_asset_id:'asset',output_asset_id:status==='succeeded'?'result':null,mode:'classic',target_language:'zh-Hans',status,phase:'',quota_pages:1,created_at:'2026-09-14T00:00:00Z',version:1,cache_hit:false,...extra});
const match = (p: Page, jobs: Job[] = []): FilePageMatch => ({...pageSource(p)!,asset:{id:`asset-${p.name}`,width:999,height:999,expires_at:'2099-01-01T00:00:00Z'},jobs});
afterEach(() => vi.unstubAllGlobals());

describe('file-page API contract', () => {
  it('matches only identities and validates paired file fields',async()=>{
    const p=page(1),calls:RequestInit[]=[];vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{calls.push(init);return Response.json({items:[match(p)]});});
    const api=new Api(origin,'token');await api.matchPages([pageSource(p)!],'classic','zh-Hans');
    expect(JSON.parse(calls[0].body as string)).toEqual({pages:[{file_hash:p.fileHash,page_index:0}],mode:'classic',target_language:'zh-Hans',include_display:true});
    await expect(api.matchPages([{file_hash:p.fileHash!,page_index:undefined as never}],'classic','zh-Hans')).rejects.toThrow('成对');
  });
  it('rejects oversized and reordered match responses', async () => {
    const api=new Api(origin);const first=page(1), second=page(2);
    await expect(api.matchPages(Array.from({length:101},()=>pageSource(first)!),'classic','zh-Hans')).rejects.toThrow('100');
    vi.stubGlobal('fetch', async()=>Response.json({items:[match(second),match(first)]}));
    await expect(api.matchPages([pageSource(first)!,pageSource(second)!],'classic','zh-Hans')).rejects.toThrow('不一致');
  });
  it('sends normalized page bytes as a lookup hint without claiming them during upload',async()=>{
    const api=new Api(origin);const p={...page(0),imageSha256:'b'.repeat(64)};
    const calls:RequestInit[]=[];
    vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{calls.push(init);return Response.json({items:[match(p)]});});
    await api.matchPages([pageSource(p)!],'redraw','zh-Hans');
    expect(JSON.parse(calls[0].body as string).pages[0].image_sha256).toBe(p.imageSha256);
  });
  it('splits entire books at 100 identities and coalesces only overlapping in-flight matches', async () => {
    const api=new Api(origin);const pages=Array.from({length:205},(_,i)=>page(i));
    const requests=vi.spyOn(api,'matchPages').mockImplementation(async sources=>({items:sources.map(source=>({...source,asset:null,jobs:[]}))}));
    const a=matchFilePages(api,pages,'classic','zh-Hans');const b=matchFilePages(api,pages,'classic','zh-Hans');expect(a).toBe(b);
    expect((await a).matches.size).toBe(205);expect(requests.mock.calls.map(call=>call[0].length)).toEqual([100,100,5]);
    await matchFilePages(api,pages,'classic','zh-Hans');expect(requests).toHaveBeenCalledTimes(6);
  });
  it('keeps successful chunks usable without treating an unavailable chunk as a miss', async () => {
    const api=new Api(origin);const pages=Array.from({length:101},(_,i)=>page(i));
    vi.spyOn(api,'matchPages').mockRejectedValueOnce(Error('network unavailable')).mockImplementation(async sources=>({items:sources.map(source=>({...source,asset:null,jobs:[]}))}));
    const result=await matchFilePages(api,pages,'classic','zh-Hans');
    expect(result.errors.size).toBe(100);expect(result.matches.size).toBe(1);
  });
  it('keeps transfer concurrency independent of read-only account queue limits', async () => {
    const calls: {url:string;init:RequestInit}[]=[];
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({});});
    const api=new Api(origin);api.pool.setLimit(10);expect(calls).toHaveLength(0);
    await api.queues();
    expect(calls.map(c=>[c.url,c.init.method??'GET',c.init.body])).toEqual([[origin+'/v1/me/queues','GET',undefined]]);
  });
});

describe('reuse and safe recovery', () => {
  it.each(['succeeded','no_text','queued','running','outcome_unknown'] as const)('does not prepare another charge for a matched %s page, even without local results', async status => {
    const p=page(1);const found=match(p,[job(status)]);const restored=applyMatch(p,found,'alice',origin);

    expect(needsTranslation(restored,'classic','zh-Hans','alice',origin)).toBe(false);

  });
  it('prepares misses and expired/mismatched local versions while keeping those local versions', () => {
    const p={...page(1),ownerId:'alice',apiOrigin:origin,jobs:[job()],outputBlobs:{job:'local-copy'}};
    const found={...match(p),asset:null};const restored=applyMatch(p,found,'alice',origin);
    expect(restored.jobs).toEqual(p.jobs);expect(restored.outputBlobs).toEqual(p.outputBlobs);
    expect(needsTranslation(restored,'classic','zh-Hans','alice',origin)).toBe(false);
    expect(restored.assetId).toBeUndefined();
  });
  it('keeps page identity, dimensions and reader anchor unchanged while replacing another account’s remote data', () => {
    const p={...page(9),pageIndex:37,ownerId:'alice',apiOrigin:origin,jobs:[job()],outputBlobs:{job:'alice-result'}};
    const copy={...makeCopy('book',[p]),relativeOffset:0.42};const found=match(p,[job('queued',{id:'bob-job'})]);
    const updated={...copy,pages:copy.pages.map(item=>applyMatch(item,found,'bob',origin))};
    expect(updated.pageId).toBe(copy.pageId);expect(updated.relativeOffset).toBe(.42);
    expect(updated.pages[0]).toMatchObject({fileHash:p.fileHash,pageIndex:37,width:100,height:200,ownerId:'bob',outputBlobs:{}});
    expect(updated.pages[0].jobs.map(j=>j.id)).toEqual(['bob-job']);
  });
  it('never lets late queued/running results overwrite a later successful or unknown task', () => {
    expect(mergeJobs([job('succeeded')],[job('running')])[0].status).toBe('succeeded');
    expect(mergeJobs([job('outcome_unknown')],[job('queued')])[0].status).toBe('outcome_unknown');
    expect(mergeJobs([job('succeeded')],[job('succeeded',{output_asset_id:null})])[0].output_asset_id).toBeNull();
    expect(mergeJobs([job('succeeded',{output_asset_id:null})],[job('succeeded',{output_asset_id:'stale-result'})])[0])
      .toMatchObject({output_asset_id:null,result_available:false,result_expired:true});
    expect(mergeJobs([job('running')],[job('succeeded')])[0].status).toBe('succeeded');
  });
  it('keeps a newer configuration’s v1 after an older configuration’s v2',()=>{
    const old=job('succeeded',{id:'old-config',version:2,created_at:'2026-09-13T00:00:00Z'});
    const newer=job('succeeded',{id:'new-config',version:1,created_at:'2026-09-14T00:00:00Z'});
    expect(mergeJobs([old],[newer]).map(j=>j.id)).toEqual(['old-config','new-config']);
  });
  it('does not let an earlier match chunk erase an upload completed before the whole-book response',async()=>{
    const api=new Api(origin);const pages=Array.from({length:101},(_,i)=>page(i));const first=pages[0];
    let finish!: (value:{items:FilePageMatch[]})=>void;
    vi.spyOn(api,'matchPages').mockResolvedValueOnce({items:pages.slice(0,100).map(p=>({...pageSource(p)!,asset:null,jobs:[]}))}).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const response=matchFilePages(api,pages,'classic','zh-Hans');await vi.waitFor(()=>expect(finish).toBeDefined());
    const uploaded={...first,ownerId:'alice',apiOrigin:origin,assetId:'new-upload',assetExpiresAt:'2099-01-01'};
    finish({items:[{...pageSource(pages[100])!,asset:null,jobs:[]}]});
    const found=(await response).matches.get(sourceKey(pageSource(first)!))!;
    const restored=applyMatch(uploaded,found,'alice',origin,first);
    expect(restored.assetId).toBe('new-upload');expect(restored.assetExpiresAt).toBe('2099-01-01');
  });
  it('rejects late match responses from the previous account/service', async () => {
    let current=true;let resolve!: (value:{items:FilePageMatch[]})=>void;const api=new Api(origin,'token',undefined,()=>current);const p=page(1);
    vi.spyOn(api,'matchPages').mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const response=matchFilePages(api,[p],'classic','zh-Hans');current=false;resolve({items:[match(p,[job()])]});
    await expect(response).rejects.toBeInstanceOf(StaleOperation);
  });
});
