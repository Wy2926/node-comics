import 'fake-indexeddb/auto';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {Api,ApiError} from '../src/api';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';
import {applyAccountJobs,readingPriority} from '../src/translation/sync';
import {prepareChunk,readManifest,readManifests,saveManifest,translationScope,type UploadManifest} from '../src/translation/store';
import {processManifest} from '../src/translation/processor';
import type {Job,Page,UploadPlan} from '../src/types';

const origin='https://api.example';
const page=(n:number):Page=>({...emptyPage(`${n}.png`,100,200),fileHash:'a'.repeat(64),pageIndex:n,imageSha256:n.toString(16).padStart(64,'0'),blobKey:`blob-${n}`});
const job=(p:Page,extra:Partial<Job>={}):Job=>({id:`job-${p.pageIndex}`,input_asset_id:'original',output_asset_id:null,mode:'classic',target_language:'zh-Hans',status:'queued',phase:'queued',quota_pages:1,created_at:'2026-09-15T00:00:00Z',version:1,cache_hit:false,file_hash:p.fileHash,page_index:p.pageIndex,image_sha256:p.imageSha256,...extra});
const manifest=(pages:Page[]):UploadManifest=>({id:crypto.randomUUID(),scope:translationScope(origin,'alice'),title:'Test chapter',mode:'classic',language:'zh-Hans',quotaKind:'classic_daily',maxQuotaPages:pages.length,continuous:true,regenerate:false,paused:false,createdAt:Date.now(),items:pages.map(p=>({id:p.id,copyId:'copy',pageId:p.id,blobKey:p.blobKey,state:'local',image:{client_item_id:p.id,file_hash:p.fileHash,page_index:p.pageIndex,image_sha256:p.imageSha256!,byte_size:4,content_type:'image/png',name:p.name}}))});
const upload:UploadPlan={id:'upload',url:origin+'/upload',method:'PUT',headers:{'Content-Type':'image/png'},expires_at:'2099-01-01'};
afterEach(()=>vi.unstubAllGlobals());

describe('persistent per-operation upload queue',()=>{
 it('retains an accepted chunk and pauses only the remaining local pages when another device consumes quota',async()=>{
  const pages=[page(101),page(102)],value=manifest(pages);await saveManifest(value);const api=new Api(origin);
  const submit=vi.spyOn(api,'submit').mockResolvedValueOnce({id:'first-accepted',mode:'classic',target_language:'zh-Hans',items:[{client_item_id:pages[0].id,job:job(pages[0])}]})
    .mockRejectedValueOnce(new ApiError('可用常规翻译页数已用完','DAILY_QUOTA_EXHAUSTED',409));
  const options={api,manifest:value,available:1,readingPageIds:[],concurrency:1,getBlob:async()=>new Blob(),onJobs:vi.fn(async()=>{}),onChange:vi.fn()};
  await processManifest(options);await processManifest(options);
  const saved=(await readManifest(value.id))!;
  expect(saved.items.map(i=>i.state)).toEqual(['accepted','local']);expect(saved.paused).toBe(true);
  expect(saved.pending).toBeUndefined();expect(saved.error).toContain('已用完');
  expect(submit.mock.calls[0][1]).not.toBe(submit.mock.calls[1][1]);
  await processManifest(options);expect(submit).toHaveBeenCalledTimes(2);
 });
 it('stores several independent manifests without a global pending lock or cross-account leakage',async()=>{
  const a=manifest([page(0)]),b=manifest([page(1)]),other={...manifest([page(2)]),scope:translationScope(origin,'bob')};
  await Promise.all([saveManifest(a),saveManifest(b),saveManifest(other)]);
  const values=await readManifests(a.scope);expect(values.map(m=>m.id)).toEqual(expect.arrayContaining([a.id,b.id]));expect(values.some(m=>m.id===other.id)).toBe(false);
 });
 it('offers the current reading page the next available upload slot while preserving uncertain request bytes',()=>{
  const pages=[page(1),page(2),page(3)],value=manifest(pages),prepared=prepareChunk(value,1,[pages[2].id]);
  expect(prepared.pending!.body.items.map(i=>i.client_item_id)).toEqual([pages[2].id]);
  expect(prepareChunk(prepared,2,[pages[0].id]).pending).toBe(prepared.pending);
  expect(prepareChunk(value,0,[]).pending).toBeUndefined();
 });
 it('replays the original idempotent submission after losing its receipt, even after reader order changes',async()=>{
  const pages=[page(10),page(11)],value=manifest(pages);await saveManifest(value);const api=new Api(origin);
  const submit=vi.spyOn(api,'submit').mockRejectedValueOnce(new ApiError('offline'));
  const options={api,manifest:value,available:1,readingPageIds:[pages[1].id],concurrency:2,getBlob:async()=>new Blob(['1234']),onJobs:vi.fn(async()=>{}),onChange:vi.fn()};
  await processManifest(options);const saved=(await readManifest(value.id))!;expect(saved.pending).toBeDefined();expect(saved.error).toContain('待核实');
  saved.retryAt=undefined;await saveManifest(saved);
  submit.mockResolvedValueOnce({id:'server-submission',mode:'classic',target_language:'zh-Hans',items:[{client_item_id:pages[1].id,job:job(pages[1])}]});
  await processManifest({...options,readingPageIds:[pages[0].id]});
  expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);expect((await readManifest(value.id))!.items[1].state).toBe('accepted');
 });
 it('keeps completed uploads independent of a missing local original and does not resend accepted pages',async()=>{
  const pages=[page(20),page(21)],value=manifest(pages);await saveManifest(value);const api=new Api(origin);
  const receipt={id:'submission',mode:'classic' as const,target_language:'zh-Hans',items:pages.map(p=>({client_item_id:p.id,job:job(p,{status:'awaiting_upload'}),upload:{...upload,id:p.id}}))};
  vi.spyOn(api,'submit').mockResolvedValue(receipt);const send=vi.spyOn(api,'uploadOriginal').mockResolvedValue();vi.spyOn(api,'completeUpload').mockImplementation(async id=>job(pages.find(p=>p.id===id)!));
  const options={api,manifest:value,available:2,readingPageIds:[],concurrency:2,getBlob:async(key:string)=>key===pages[0].blobKey?new Blob(['1234']):undefined,onJobs:vi.fn(async()=>{}),onChange:vi.fn()};
  await processManifest(options);let saved=(await readManifest(value.id))!;expect(saved.items.map(i=>i.state)).toEqual(['accepted','failed']);expect(send).toHaveBeenCalledTimes(1);
  saved.retryAt=undefined;await saveManifest(saved);vi.spyOn(api,'submission').mockResolvedValue({...receipt,items:[{...receipt.items[0],job:job(pages[0]),upload:null},receipt.items[1]]});
  await processManifest({...options,getBlob:async()=>new Blob(['1234'])});saved=(await readManifest(value.id))!;
  expect(send).toHaveBeenCalledTimes(2);expect(saved.items.map(i=>i.state)).toEqual(['accepted','accepted']);expect(saved.pending).toBeUndefined();
 });
 it('waits for server throttling and retries the same intent without failing or pausing pages',async()=>{
  const p=page(90),value=manifest([p]);await saveManifest(value);const api=new Api(origin);
  const submit=vi.spyOn(api,'submit').mockRejectedValueOnce(new ApiError('稍后重试','SUBMISSION_DAILY_LIMIT',429,null,3600));
  const options={api,manifest:value,available:1,readingPageIds:[],concurrency:2,getBlob:async()=>new Blob(),onJobs:vi.fn(async()=>{}),onChange:vi.fn()};
  const before=Date.now();await processManifest(options);const saved=(await readManifest(value.id))!;
  expect(saved.retryAt).toBeGreaterThanOrEqual(before+3600000);expect(saved.paused).toBe(false);expect(saved.items[0].state).toBe('local');expect(saved.error).not.toContain('待核实');
  await processManifest(options);expect(submit).toHaveBeenCalledTimes(1);
  saved.retryAt=undefined;await saveManifest(saved);submit.mockResolvedValueOnce({id:'after-throttle',mode:'classic',target_language:'zh-Hans',items:[{client_item_id:p.id,job:job(p)}]});
  await processManifest(options);expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);expect((await readManifest(value.id))!.pending).toBeUndefined();
 });
 it('pauses an archived intent without replacing its idempotency key',async()=>{
  const value=manifest([page(91)]);await saveManifest(value);const api=new Api(origin);
  const submit=vi.spyOn(api,'submit').mockRejectedValue(new ApiError('回执已归档','SUBMISSION_ARCHIVED',410));
  const options={api,manifest:value,available:1,readingPageIds:[],concurrency:2,getBlob:async()=>new Blob(),onJobs:vi.fn(async()=>{}),onChange:vi.fn()};
  await processManifest(options);const saved=(await readManifest(value.id))!;
  expect(saved.paused).toBe(true);expect(saved.pending!.key).toBe(submit.mock.calls[0][1]);expect(saved.retryAt).toBeUndefined();
  await processManifest(options);expect(submit).toHaveBeenCalledTimes(1);
 });
 it('releases a definitively rejected chunk so capacity can be checked again, without losing selected pages',async()=>{
  const value=manifest([page(30)]);await saveManifest(value);const api=new Api(origin);vi.spyOn(api,'submit').mockRejectedValue(new ApiError('full','QUEUE_CAPACITY_EXCEEDED',409));
  await processManifest({api,manifest:value,available:1,readingPageIds:[],concurrency:2,getBlob:async()=>new Blob(),onJobs:vi.fn(async()=>{}),onChange:vi.fn()});
  const saved=(await readManifest(value.id))!;expect(saved.pending).toBeUndefined();expect(saved.paused).toBe(false);expect(saved.items[0].state).toBe('local');
 });
});

describe('reading priority and account recovery',()=>{
 it('reads reuse from the submission item, keeping the original job settlement separate',async()=>{
  const api=new Api(origin),original=job(page(60),{submission_id:'receipt',quota_pages:1,settlement:'settled'});
  vi.spyOn(api,'submission').mockResolvedValue({id:'receipt',mode:'classic',target_language:'zh-Hans',items:[{client_item_id:'first',job:original,reused:false},{client_item_id:'second',job:original,reused:true}]});
  const result=await api.historyJobs({id:'receipt',status:'succeeded',created_at:original.created_at,mode:'classic',target_language:'zh-Hans',quota_pages:1,page_count:2});
  expect(result.items.map(item=>item.reused)).toEqual([false,true]);expect(result.items[1].quota_pages).toBe(1);
 });
 it('limits realtime candidates to nearby pages per mode, preserving the rest as personal order',()=>{
  const pages=Array.from({length:20},(_,n)=>page(n)),jobs=pages.flatMap(p=>[job(p),job(p,{id:`redraw-${p.pageIndex}`,mode:'redraw'})]);
  expect(readingPriority(pages,jobs,'classic','zh-Hans',2).realtime_job_ids).toEqual(['job-0','job-1']);
  expect(readingPriority(pages,jobs,'redraw','zh-Hans',10).realtime_job_ids).toHaveLength(10);
  expect(readingPriority(pages,jobs,'classic','zh-Hans',2).ordered_job_ids).toHaveLength(20);
  expect(readingPriority([pages[19],...pages.slice(0,19)],jobs,'classic','zh-Hans',2).realtime_job_ids[0]).toBe('job-19');
 });
 it('restores another device results by source identity without downloading or moving the reader',()=>{
  const p=page(1),copy={...makeCopy('chapter',[p]),relativeOffset:.42};
  const restored=applyAccountJobs(copy,[job(p,{status:'succeeded',output_asset_id:'result'})],'alice',origin);
  expect(restored.pageId).toBe(copy.pageId);expect(restored.relativeOffset).toBe(.42);expect(restored.pages[0]).toMatchObject({width:100,height:200,ownerId:'alice',outputBlobs:{}});expect(restored.pages[0].jobs).toHaveLength(1);
  expect(applyAccountJobs(restored,[job(p,{status:'succeeded',output_asset_id:'result'})],'alice',origin)).toBe(restored);
 });
 it('never forwards account credentials to R2 and rejects cross-origin authenticated upload plans',async()=>{
  const calls:RequestInit[]=[];vi.stubGlobal('fetch',async(_url:URL,init:RequestInit)=>{calls.push(init);return new Response(null,{status:200});});const api=new Api(origin,'secret-test-token');
  await api.uploadOriginal({...upload,url:'https://bucket.r2.example/raw'},new Blob(['a']));expect(calls[0].headers).not.toHaveProperty('Authorization');expect(calls[0].credentials).toBe('omit');
  await api.uploadOriginal({...upload,authorization_required:true},new Blob(['a']));expect(calls[1].headers).toMatchObject({Authorization:'Bearer secret-test-token'});
  await expect(api.uploadOriginal({...upload,url:'https://other.example/raw',authorization_required:true},new Blob(['a']))).rejects.toThrow('无效');
 });
});
