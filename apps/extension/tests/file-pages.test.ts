import {mergeJobs} from '../src/reader/jobs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Api} from '../src/api';
import {StaleOperation} from '../src/concurrency';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';
import {applyMatch, bindSubmission, matchFilePages, pageSource, planTranslation, rerunSource, sourceKey, submittedJobsForPage, uploadPages} from '../src/reader/recovery';
import type {FilePageMatch, Job, Page} from '../src/types';

const origin = 'https://api.example';
const page = (index: number): Page => ({...emptyPage(`${index}.png`, 100, 200), fileHash: index.toString(16).padStart(64, '0'), pageIndex: 0, blobKey: `original:${index}`});
const job = (status: Job['status'] = 'succeeded', extra: Partial<Job> = {}): Job => ({id: 'job',input_asset_id:'asset',output_asset_id:status==='succeeded'?'result':null,mode:'classic',target_language:'zh-Hans',status,phase:'',quota_pages:1,created_at:'2026-09-14T00:00:00Z',version:1,cache_hit:false,...extra});
const match = (p: Page, jobs: Job[] = []): FilePageMatch => ({...pageSource(p)!,asset:{id:`asset-${p.name}`,width:999,height:999,expires_at:'2099-01-01T00:00:00Z'},jobs});
afterEach(() => vi.unstubAllGlobals());

describe('file-page API contract', () => {
  it('pairs multipart source fields and sends only identities for match', async () => {
    const calls: {url:string;init:RequestInit}[]=[];const p=page(1);const found=match(p,[job()]);
    vi.stubGlobal('fetch', async (url:string,init:RequestInit) => {calls.push({url,init});return Response.json(url.endsWith('/match')?{items:[found]}:found.asset);});
    const api=new Api(origin,'token');await api.upload(new Blob(['image']),p.name,pageSource(p));await api.matchPages([pageSource(p)!],'classic','zh-Hans');await api.upload(new Blob(['image']),p.name);
    const body=calls[0].init.body as FormData;
    expect(body.get('file_hash')).toBe(p.fileHash);expect(body.get('page_index')).toBe('0');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({pages:[{file_hash:p.fileHash,page_index:0}],mode:'classic',target_language:'zh-Hans',include_display:true});
    expect((calls[2].init.body as FormData).has('file_hash')).toBe(false);expect((calls[2].init.body as FormData).has('page_index')).toBe(false);
    expect(()=>api.upload(new Blob(),p.name,{file_hash:p.fileHash!,page_index:undefined as never})).toThrow('成对');
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
    await api.upload(new Blob(),p.name,pageSource(p));
    expect((calls[1].body as FormData).has('image_sha256')).toBe(false);
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
    const result=await matchFilePages(api,pages,'classic','zh-Hans');const plan=planTranslation(pages,result,'classic','zh-Hans');
    expect(plan.selected.map(p=>p.id)).toEqual([pages[100].id]);expect(plan.failures).toHaveLength(100);
  });
  it('keeps transfer concurrency independent of read-only account queue limits', async () => {
    const calls: {url:string;init:RequestInit}[]=[];
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({});});
    const api=new Api(origin);api.pool.setLimit(10);expect(calls).toHaveLength(0);
    await api.queue();
    expect(calls.map(c=>[c.url,c.init.method??'GET',c.init.body])).toEqual([[origin+'/v1/me/queue','GET',undefined]]);
  });
});

describe('reuse and safe recovery', () => {
  it.each(['succeeded','no_text','queued','running','outcome_unknown'] as const)('does not prepare another charge for a matched %s page, even without local results', async status => {
    const p=page(1);const found=match(p,[job(status)]);const restored=applyMatch(p,found,'alice',origin);
    const result={matches:new Map([[sourceKey(found),found]]),errors:new Map()};
    const planned=planTranslation([restored],result,'classic','zh-Hans');
    const api=new Api(origin);const upload=vi.spyOn(api,'upload');
    expect(planned.selected).toEqual([]);expect(planned.failures).toEqual([]);
    expect(await uploadPages(api,planned.selected,'alice',origin,2,async()=>new Blob(),vi.fn())).toEqual([]);expect(upload).not.toHaveBeenCalled();
    expect(planTranslation([restored],result,'classic','zh-Hans',true).selected).toEqual([restored]);
  });
  it('prepares misses and expired/mismatched local versions while keeping those local versions', () => {
    const p={...page(1),ownerId:'alice',apiOrigin:origin,jobs:[job()],outputBlobs:{job:'local-copy'}};
    const found={...match(p),asset:null};const restored=applyMatch(p,found,'alice',origin);
    expect(restored.jobs).toEqual(p.jobs);expect(restored.outputBlobs).toEqual(p.outputBlobs);
    expect(planTranslation([restored],{matches:new Map([[sourceKey(found),found]]),errors:new Map()},'classic','zh-Hans').selected).toEqual([restored]);
    expect(restored.assetId).toBeUndefined();
  });
  it('keeps page identity, dimensions and reader anchor unchanged while replacing another account’s remote data', () => {
    const p={...page(9),pageIndex:37,ownerId:'alice',apiOrigin:origin,jobs:[job()],outputBlobs:{job:'alice-result'},operationIds:{job:'alice-operation'}};
    const copy={...makeCopy('book',[p]),relativeOffset:0.42};const found=match(p,[job('queued',{id:'bob-job'})]);
    const updated={...copy,pages:copy.pages.map(item=>applyMatch(item,found,'bob',origin))};
    expect(updated.pageId).toBe(copy.pageId);expect(updated.relativeOffset).toBe(.42);
    expect(updated.pages[0]).toMatchObject({fileHash:p.fileHash,pageIndex:37,width:100,height:200,ownerId:'bob',outputBlobs:{},operationIds:{}});
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
    const submitted=job('queued',{input_asset_id:'new-upload'});
    expect(submittedJobsForPage(first.id,[uploaded],[submitted])).toEqual([submitted]);
    // Submission still binds the persistent page id even if its live asset was removed/changed.
    expect(submittedJobsForPage({...restored,assetId:undefined}.id,[uploaded],[submitted])).toEqual([submitted]);
  });
  it('binds shared jobs using requested asset aliases and persistent selected page ids',()=>{
    const first={...page(1),assetId:'preview-asset-a'},second={...page(2),assetId:'preview-asset-b'};
    const returned=[job('queued',{input_asset_id:'original-from-other-book',requested_asset_id:first.assetId}),job('queued',{input_asset_id:'original-from-other-book',requested_asset_id:second.assetId})];
    expect(submittedJobsForPage(first.id,[first,second],returned)).toEqual([returned[0]]);
    expect(submittedJobsForPage(second.id,[first,second],returned)).toEqual([returned[1]]);
    expect(submittedJobsForPage('unselected',[first,second],returned)).toEqual([]);
    const duplicate={...first,id:'duplicate-local-page'};
    expect(submittedJobsForPage(duplicate.id,[first,duplicate],[returned[0]])).toEqual([returned[0]]);
  });
  it('retains detached job IDs when selected pages were deleted or changed owners in an existing copy',()=>{
    const first={...page(1),assetId:'asset-a',ownerId:'alice',apiOrigin:origin};
    const removed={...page(2),assetId:'asset-b',ownerId:'alice',apiOrigin:origin};
    const changed={...page(3),assetId:'asset-c',ownerId:'bob',apiOrigin:origin};
    const jobs=[job('queued',{id:'a',input_asset_id:'asset-a'}),job('queued',{id:'b',input_asset_id:'asset-b'}),job('queued',{id:'c',input_asset_id:'asset-c'})];
    const result=bindSubmission(makeCopy('remaining copy',[first,changed]),[first,removed,changed],jobs,'alice',origin);
    expect(result.copy!.pages[0].jobs.map(j=>j.id)).toEqual(['a']);expect(result.copy!.pages[1].jobs).toEqual([]);
    expect(result.detachedJobIds).toEqual(['b','c']);
    expect(bindSubmission(undefined,[first],jobs,'alice',origin).detachedJobIds).toEqual(['a','b','c']);
  });
  it('attaches one returned task to all persisted duplicate local pages, even when live assets changed',()=>{
    const first={...page(1),assetId:'shared-source',ownerId:'alice',apiOrigin:origin};const duplicate={...first,id:'duplicate-page'};
    const jobResult=job('queued',{input_asset_id:'shared-source'});
    const live=makeCopy('duplicates',[{...first,assetId:undefined},{...duplicate,assetId:'newer-source'}]);
    const result=bindSubmission(live,[first,duplicate],[jobResult],'alice',origin);
    expect(result.copy!.pages.map(p=>p.jobs.map(j=>j.id))).toEqual([['job'],['job']]);expect(result.detachedJobIds).toEqual([]);
    expect(result.copy!.pages.map(p=>p.assetId)).toEqual([undefined,'newer-source']);
  });
  it('quotes a matched alias input for rerun without replacing the file-page asset mapping', async () => {
    const p=page(1);const previous=job('succeeded',{input_asset_id:'other-book-source'});const found=match(p,[previous]);
    const restored=applyMatch(p,found,'alice',origin);const rerun=rerunSource(restored,found,'classic','zh-Hans')!;
    expect(rerun).toEqual({pageId:p.id,jobId:previous.id,inputAssetId:'other-book-source'});
    expect(restored.assetId).toBe(found.asset!.id);expect(restored.fileHash).toBe(p.fileHash);expect(restored.pageIndex).toBe(0);
    const api=new Api(origin);const preview=vi.spyOn(api,'preview').mockResolvedValue({id:'preview',quota_pages:1,quota_kind:'classic_daily',new_pages:1,reused_pages:0,regenerate:true,entitlement_version:'rights',page_count:1,expires_at:'',config_version:'config'});
    const rerunCall=vi.spyOn(api,'rerun').mockResolvedValue(job('queued',{version:2}));
    const q=await api.preview([rerun.inputAssetId],'classic','zh-Hans');await api.rerun(rerun.jobId,'same-key',q.id,q.quota_pages);
    expect(preview).toHaveBeenCalledWith(['other-book-source'],'classic','zh-Hans');expect(rerunCall).toHaveBeenCalledWith(previous.id,'same-key','preview',1);
  });
  it('rejects late match responses from the previous account/service', async () => {
    let current=true;let resolve!: (value:{items:FilePageMatch[]})=>void;const api=new Api(origin,'token',undefined,()=>current);const p=page(1);
    vi.spyOn(api,'matchPages').mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const response=matchFilePages(api,[p],'classic','zh-Hans');current=false;resolve({items:[match(p,[job()])]});
    await expect(response).rejects.toBeInstanceOf(StaleOperation);
  });
  it('does not publish late uploads, but continues independent pages after an upload error', async () => {
    const api=new Api(origin);const pages=[page(1),page(2),page(3)];const updated:Page[]=[];
    vi.spyOn(api,'upload').mockRejectedValueOnce(Error('bad image')).mockImplementation(async(_blob,name)=>({id:name,width:100,height:200,expires_at:'2099-01-01'}));
    const results=await uploadPages(api,pages,'alice',origin,2,async()=>new Blob(),p=>updated.push(p));
    expect(results.map(r=>r.status)).toEqual(['rejected','fulfilled','fulfilled']);expect(updated.map(p=>p.name).sort()).toEqual(['2.png','3.png']);
    let current=true;let finish!: (value:{id:string;width:number;height:number;expires_at:string})=>void;
    vi.spyOn(api,'upload').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const publish=vi.fn();const late=uploadPages(api,[page(4)],'alice',origin,2,async()=>new Blob(),publish,()=>current);
    await vi.waitFor(()=>expect(finish).toBeDefined());current=false;finish({id:'old-account-asset',width:1,height:1,expires_at:'2099-01-01'});
    expect((await late)[0].status).toBe('rejected');expect(publish).not.toHaveBeenCalled();
  });
  it('uploads duplicated image identities once, retaining each local page identity', async () => {
    const first=page(1),second={...first,id:'other-page'};const api=new Api(origin);
    const upload=vi.spyOn(api,'upload').mockResolvedValue({id:'shared',width:100,height:200,expires_at:'2099-01-01'});
    const results=await uploadPages(api,[first,second],'alice',origin,2,async()=>new Blob(),vi.fn());
    expect(upload).toHaveBeenCalledTimes(1);expect(results.map(r=>r.status==='fulfilled'&&r.value.page.id)).toEqual([first.id,second.id]);
  });
});
