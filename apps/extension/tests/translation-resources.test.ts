import 'fake-indexeddb/auto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ApiError} from '../src/api';
import {TranslationCoordinator} from '../src/translation/channels/adapters/nodelane/coordinator';
import {readOperation,saveOperation,readSync} from '../src/translation/channels/adapters/nodelane/store';
import {operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {fixture,target,snapshot,entitlement} from './translation-fixture';
afterEach(()=>vi.restoreAllMocks());
function controlledClock(){let wall=Date.now(),monotonic=performance.now();vi.spyOn(Date,'now').mockImplementation(()=>wall);vi.spyOn(performance,'now').mockImplementation(()=>monotonic);return (milliseconds:number)=>{wall+=milliseconds;monotonic+=milliseconds;};}
describe('independent translation resources',()=>{
 it('submits only newly entered pages and promotes a prefetch once',async()=>{
  const f=fixture();await f.core.submit([0,1,2,3].map(target));expect(f.submit).toHaveBeenCalledTimes(4);
  await f.core.submit([0,1,2,3].map(target));expect(f.submit).toHaveBeenCalledTimes(4);
  const id=f.submit.mock.calls[1][0];await f.core.submit([1,2,3,4].map(target));expect(f.submit).toHaveBeenCalledTimes(6);expect(f.submit.mock.calls[4]).toMatchObject([id,{priority:'current'}]);
 });
 it('starts the current request before preparing later sources and isolates a bad page',async()=>{
  const f=fixture(),missing={...target(1),page:{...target(1).page,imageSha256:undefined,imageByteSize:undefined,blobKey:undefined}};
  await f.core.submit([target(0),missing,target(2)]);expect(f.submit).toHaveBeenCalledTimes(2);expect(f.submit.mock.calls[0][1]).toMatchObject({image:{sha256:target(0).page.imageSha256}});
 });
 it('releases inline input after server acceptance without making cleanup failure an uncertain request',async()=>{
  const f=fixture(),onInputConsumed=vi.fn(async()=>{throw Error('cache cleanup failed');}),core=new TranslationCoordinator({...f.core.options,onInputConsumed});
  await core.submit([target(0)]);expect(onInputConsumed).toHaveBeenCalledWith('blob-0');
  const saved=await readOperation(operationId(core.scope,'zh-Hans',target(0)));expect(saved?.state).toBe('accepted');expect(saved?.result?.state).toBe('queued');
  await core.submit([target(0)]);expect(f.submit).toHaveBeenCalledOnce();
 });
 it('uses a durable UUID after response loss and reopens no server session',async()=>{
  const f=fixture();f.submit.mockRejectedValueOnce(new ApiError('offline'));await f.core.submit([target(1)]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))!;record.retryAt=0;await saveOperation(record);
  const reopened=new TranslationCoordinator(f.core.options);await reopened.submit([target(1)]);
  expect(f.api.translations).toHaveBeenCalledWith([record.requestId],expect.anything());expect(f.submit.mock.calls[1][0]).toBe(record.requestId);
 });
 it('does not retry abandoned local pages',async()=>{const f=fixture();await f.core.submit([target(1)],()=>false);await f.core.submit([target(2)]);expect(f.submit).toHaveBeenCalledOnce();});
 it('gates the remaining prefetches and new windows until the image deadline, then reuses the denied UUID',async()=>{
  const advance=controlledClock(),f=fixture();f.submit.mockRejectedValueOnce(new ApiError('wait','IMAGE_RATE_LIMITED',429,null,20));
  await f.core.submit([0,1,2,3].map(target));expect(f.submit).toHaveBeenCalledOnce();const deniedId=f.submit.mock.calls[0][0];
  await f.core.submit([4,5,6,7].map(target));expect(f.submit).toHaveBeenCalledOnce();expect(f.core.retryDelay).toBe(20000);
  advance(19999);await f.core.submit([4,5,6,7].map(target));expect(f.submit).toHaveBeenCalledOnce();expect(f.core.retryDelay).toBe(1);
  advance(1);await f.core.submit([4,5,6,7].map(target));expect(f.submit).toHaveBeenCalledTimes(5);
  await f.core.submit([target(0)]);expect(f.submit.mock.calls.at(-1)?.[0]).toBe(deniedId);
 });
 it('keeps the image admission deadline when an accepted request completes',async()=>{
  controlledClock();const f=fixture();await f.core.submit([target(0)]);const [id,body]=f.submit.mock.calls[0];
  f.submit.mockRejectedValueOnce(new ApiError('wait','IMAGE_RATE_LIMITED',429,null,20));await f.core.submit([1,2,3,0].map(target));expect(f.submit).toHaveBeenCalledTimes(2);
  const deadline=(await readSync(f.core.scope))!.imageRetryAt;
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,items:[snapshot(id,body,{state:'succeeded',result:{kind:'no_text'}})],missing_ids:[],etag:'"completed"'});
  await f.core.wait(new AbortController().signal);expect((await readSync(f.core.scope))!.imageRetryAt).toBe(deadline);
  await f.core.submit([4,5,6,7].map(target));expect(f.submit).toHaveBeenCalledTimes(2);expect(f.core.retryDelay).toBe(20000);
 });
 it('shares image admission backpressure across reopened coordinators while allowing accepted promotion and recovery',async()=>{
  controlledClock();const f=fixture();await f.core.submit([target(0),target(1)]);const [prefetchId,prefetchBody]=f.submit.mock.calls[1];
  f.submit.mockRejectedValueOnce(new ApiError('wait','IMAGE_RATE_LIMITED',429,null,20));await f.core.submit([target(2)]);const deadline=(await readSync(f.core.scope))!.imageRetryAt;
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,items:[snapshot(prefetchId,prefetchBody,{state:'needs_input'})],missing_ids:[],etag:'"upload"'});
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id)=>snapshot(id,prefetchBody));
  const reopened=new TranslationCoordinator(f.core.options);await reopened.submit([target(1),target(3)]);await reopened.finishUploads();
  expect(f.api.translations).toHaveBeenCalledWith([prefetchId],expect.anything());expect(upload).toHaveBeenCalledOnce();
  expect(f.submit).toHaveBeenCalledTimes(4);expect(f.submit.mock.calls[3]).toMatchObject([prefetchId,{priority:'current'}]);
  expect((await readSync(f.core.scope))!.imageRetryAt).toBe(deadline);expect(reopened.retryDelay).toBe(20000);
 });
 it('restores denied quota with the same unaccepted UUID',async()=>{
  const f=fixture();f.submit.mockRejectedValueOnce(new ApiError('quota','DAILY_QUOTA_EXHAUSTED',403));await f.core.submit([target(0)]);await f.core.refreshEntitlements(entitlement(true));await f.core.submit([target(0)]);expect(f.submit.mock.calls[1][0]).toBe(f.submit.mock.calls[0][0]);
 });
 it('explicit failure retry creates a UUID with only retry_of',async()=>{
  const f=fixture();f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'failed',error:{code:'FAILED',message:'failed'}}));await f.core.submit([target(0)]);const id=f.submit.mock.calls[0][0];await f.core.manual(target(0));expect(f.submit.mock.calls[1][0]).not.toBe(id);expect(f.submit.mock.calls[1][1]).toEqual({retry_of:id,priority:'current'});
 });
 it('never automatically retries uncertain upstream results',async()=>{
  const f=fixture();f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_attention'}));await f.core.submit([target(0)]);await f.core.submit([target(0)]);await expect(f.core.manual(target(0))).rejects.toThrow('核实');expect(f.submit).toHaveBeenCalledOnce();
 });
 it('does no waiting IO without active requests and stops after terminal snapshots',async()=>{
  const f=fixture(),signal=new AbortController().signal;await f.core.wait(signal);expect(f.api.translations).not.toHaveBeenCalled();await f.core.submit([target(0)]);const [id,body]=f.submit.mock.calls[0];vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,items:[snapshot(id,body,{state:'succeeded',result:{kind:'no_text'}})],missing_ids:[],etag:'"2"'});await f.core.wait(signal);expect(f.core.hasPending).toBe(false);const n=vi.mocked(f.api.translations).mock.calls.length;await f.core.wait(signal);expect(f.api.translations).toHaveBeenCalledTimes(n);
 });
 it('does not probe an uncertain request again before its network backoff expires',async()=>{
  const f=fixture();f.submit.mockRejectedValueOnce(new ApiError('offline'));await f.core.submit([target(0)]);await f.core.submit([target(0)]);expect(f.api.translations).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
 });
 it('restores a four-page window with one full snapshot read',async()=>{
  const f=fixture();await f.core.submit([0,1,2,3].map(target));vi.mocked(f.api.translations).mockImplementation(async ids=>({unchanged:false,etag:'"all"',missing_ids:[],items:ids.map(id=>{const [,body]=f.submit.mock.calls.find(c=>c[0]===id)!;return snapshot(id,body);})}));
  const reopened=new TranslationCoordinator(f.core.options);await reopened.submit([0,1,2,3].map(target));expect(f.api.translations).toHaveBeenCalledOnce();expect(vi.mocked(f.api.translations).mock.calls[0][0]).toHaveLength(4);expect(f.submit).toHaveBeenCalledTimes(4);
 });
 it('never persists signed download URLs',async()=>{
  const f=fixture();f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'succeeded',result:{kind:'translated',asset_id:'asset',download_url:'https://private.example/image?secret=value',download_expires_at:'2099-01-01'}}));await f.core.submit([target(0)]);const saved=await readOperation(operationId(f.core.scope,'zh-Hans',target(0)));expect(saved?.result?.result?.asset_id).toBe('asset');expect(saved?.result?.result?.download_url).toBeUndefined();expect(saved?.result?.result?.download_expires_at).toBeUndefined();
 });
 it('stops all new admissions during service backpressure',async()=>{
  const f=fixture();f.submit.mockRejectedValueOnce(new ApiError('wait','REQUEST_RATE_LIMITED',429,null,12));await f.core.submit([0,1,2,3].map(target));await f.core.submit([target(5)]);expect(f.submit).toHaveBeenCalledOnce();expect(f.core.controlDelay).toBeGreaterThan(11000);
 });

});
