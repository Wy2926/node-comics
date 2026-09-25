import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubAuthLocks } from './auth-fixture';
import { job } from './translation-fixture';
import { loadResultBlob, saveResultBlob, resultBlobKey, resultInMemory } from '../src/storage/translations/results';
import { translationCache, setTranslationCacheLimitMb } from '../src/storage/translations';
import { sourcePageCache } from '../src/storage/source-pages';
import { SourceDatabaseSchemaError } from '../src/storage/database';

/** Message delivery model; native extension-page Blob handoff is covered by the browser harness. */
class ResultChannel {
  static contexts=new Set<ResultChannel>();onmessage?: (event:{data:unknown})=>void;
  constructor(readonly name:string){ResultChannel.contexts.add(this);}
  postMessage(data:unknown){for(const peer of ResultChannel.contexts)if(peer!==this&&peer.name===this.name)queueMicrotask(()=>peer.onmessage?.({data}));}
}

beforeEach(async () => { stubAuthLocks();vi.stubGlobal('BroadcastChannel',ResultChannel); vi.stubGlobal("createImageBitmap",vi.fn(async()=>({width:800,height:1200,close:vi.fn()}))); await setTranslationCacheLimitMb(1024); });
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const request = () => ({ scope:{key:crypto.randomUUID()},
  job: job(1, {status: 'succeeded', output_asset_id: 'output-1'}),
  download: vi.fn(async () => new Blob(['translated'])), isCurrent: () => true });

it('coalesces concurrent readers and retains bytes after the display is released', async () => {
  const input = request();
  const blobs = await Promise.all(Array.from({length: 4}, () => loadResultBlob(input)));
  expect(input.download).toHaveBeenCalledTimes(1);
  expect(await blobs[0].text()).toBe('translated');
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(1);
});

it('uses the same persistent cache and lock after the module/context restarts', async () => {
  const input = request();
  // A second module instance models a reader/worker with no shared in-memory map.
  vi.resetModules();
  const other = await import('../src/storage/translations/results');
  await Promise.all([loadResultBlob(input), other.loadResultBlob(input)]);
  expect(input.download).toHaveBeenCalledTimes(1);
});

it('isolates accounts, API origins and delivered result identities', async () => {
  const input = request();
  for (const patch of [{}, {scope:{key:'other'}}, {scope:{key:'another-channel'}},
    {job: {...input.job, id: 'another-job'}}, {job: {...input.job, result:{key:'new-output',recoverable:true}}}])
    await loadResultBlob({...input, ...patch});
  expect(input.download).toHaveBeenCalledTimes(5);
});

it('rejects revoked or expired results even with cached bytes', async () => {
  const input = request();
  await loadResultBlob(input);
  for (const patch of [{result_available: false}, {result_expired: true}, {result: undefined}])
    await expect(loadResultBlob({...input, job: {...input.job, ...patch}})).rejects.toThrow();
  expect(input.download).toHaveBeenCalledTimes(1);
});

it('does not retain failed downloads and supports a download-only retry', async () => {
  const input = request();
  input.download.mockRejectedValueOnce(Error('offline'));
  await expect(loadResultBlob(input)).rejects.toThrow('offline');
  expect(await translationCache.get(resultBlobKey(input.scope,input.job))).toBeUndefined();
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
});

it('does not return or persist a download after account invalidation', async () => {
  const input = request();
  let current = true;
  input.isCurrent = () => current;
  input.download.mockImplementation(async () => {current = false; return new Blob(['private']);});
  await expect(loadResultBlob(input)).rejects.toThrow();
  expect(await translationCache.get(resultBlobKey(input.scope,input.job))).toBeUndefined();
});

it('downloads again after eviction and honors the existing clear-translations action', async () => {
  const input = request();
  await loadResultBlob(input);
  await translationCache.delete(resultBlobKey(input.scope,input.job));
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
  await translationCache.clear();
  expect(await translationCache.get(resultBlobKey(input.scope,input.job))).toBeUndefined();
});

it('can display a result even when the finite budget immediately evicts its cache', async () => {
  const input = request();
  const original = 'inline-original:' + input.scope.key;
  await sourcePageCache.put(original, new Blob(['pending upload']));
  await setTranslationCacheLimitMb(0);
  const blob = await loadResultBlob(input);
  expect(await blob.text()).toBe('translated');
  expect(await translationCache.get(resultBlobKey(input.scope,input.job))).toBeUndefined();
  expect(await sourcePageCache.get(original)).toBeInstanceOf(Blob);
  await sourcePageCache.delete(original);
});

it('delivers downloaded results when cache token and read operations fail',async()=>{
  const input=request();vi.spyOn(translationCache,'token').mockRejectedValue(Error('unavailable'));vi.spyOn(translationCache,'get').mockRejectedValue(Error('unavailable'));
  expect(await(await loadResultBlob(input)).text()).toBe('translated');expect(input.download).toHaveBeenCalledOnce();
});

it('delivers downloaded results when persistence fails',async()=>{
  const input=request();vi.spyOn(translationCache,'put').mockRejectedValue(new DOMException('full','QuotaExceededError'));
  expect(await(await loadResultBlob(input)).text()).toBe('translated');expect(input.download).toHaveBeenCalledOnce();
});

it.each(['token','get'] as const)('reports a result cache %s schema error without downloading or retaining a result',async operation=>{
  const input=request(),error=new SourceDatabaseSchemaError('translations','缺少 reservations');
  vi.spyOn(translationCache,operation).mockRejectedValueOnce(error);
  await expect(loadResultBlob(input)).rejects.toBe(error);expect(input.download).not.toHaveBeenCalled();
  expect(resultInMemory(resultBlobKey(input.scope,input.job))).toBeUndefined();
  // Failed coalesced work must not poison a subsequent retry after storage is repaired.
  expect(await(await loadResultBlob(input)).text()).toBe('translated');expect(input.download).toHaveBeenCalledOnce();
});

it('reports schema errors during result persistence instead of marking the result available in memory',async()=>{
  const input=request(),error=new SourceDatabaseSchemaError('translations','缺少 objects');
  vi.spyOn(translationCache,'put').mockRejectedValueOnce(error);
  await expect(loadResultBlob(input)).rejects.toBe(error);expect(input.download).toHaveBeenCalledOnce();
  expect(resultInMemory(resultBlobKey(input.scope,input.job))).toBeUndefined();
});

it('stores local results without an account or server asset and never downloads after local cache removal',async()=>{
  const input=request();input.job={...input.job,output_asset_id:null,result:{key:crypto.randomUUID(),recoverable:false}};
  await saveResultBlob({...input,blob:new Blob(['local translation'])});
  expect(await(await loadResultBlob(input)).text()).toBe('local translation');
  expect(input.download).not.toHaveBeenCalled();
  await translationCache.delete(resultBlobKey(input.scope,input.job));
  await expect(loadResultBlob(input)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  expect(input.download).not.toHaveBeenCalled();
});

it('keeps local results readable with disk cache disabled, then honors an explicit cache clear',async()=>{
  await setTranslationCacheLimitMb(0);
  const input=request();input.job={...input.job,output_asset_id:null,result:{key:crypto.randomUUID(),recoverable:false}};
  await saveResultBlob({...input,blob:new Blob(['session result'])});
  expect(await translationCache.has(resultBlobKey(input.scope,input.job))).toBe(false);
  expect(await(await loadResultBlob(input)).text()).toBe('session result');
  await translationCache.clear();
  await expect(loadResultBlob(input)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  expect(input.download).not.toHaveBeenCalled();
});

it('rejects undecodable and oversized results before publishing bytes',async()=>{
  const input=request(),blob=new Blob(['bad image']);
  vi.mocked(createImageBitmap).mockRejectedValueOnce(Error('decode failed'));
  await expect(saveResultBlob({...input,blob})).rejects.toThrow('无法解码');
  const close=vi.fn();vi.mocked(createImageBitmap).mockResolvedValueOnce({width:40000,height:1200,close} as unknown as ImageBitmap);
  await expect(saveResultBlob({...input,blob})).rejects.toThrow('尺寸');
  expect(close).toHaveBeenCalledOnce();
  const key=resultBlobKey(input.scope,input.job);expect(await translationCache.has(key)).toBe(false);expect(resultInMemory(key)).toBeUndefined();
});

it('does not republish in memory when a cache clear races with a result download',async()=>{
  const input=request();input.download.mockImplementation(async()=>{await translationCache.clear();return new Blob(['late result']);});
  await expect(loadResultBlob(input)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  const key=resultBlobKey(input.scope,input.job);expect(await translationCache.has(key)).toBe(false);expect(resultInMemory(key)).toBeUndefined();
});

it('rejects results completed after a clear using the token captured before the long translation',async()=>{
  const input=request(),cacheToken=await translationCache.token(input.scope.key);
  await translationCache.clear();
  await expect(saveResultBlob({...input,cacheToken,blob:new Blob(['late translation'])})).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  const key=resultBlobKey(input.scope,input.job);expect(await translationCache.has(key)).toBe(false);expect(resultInMemory(key)).toBeUndefined();
});

it('hands off memory-only local results across module contexts and rejects old bytes after clearing',async()=>{
  await setTranslationCacheLimitMb(0);
  const input=request();input.job={...input.job,output_asset_id:null,result:{key:crypto.randomUUID(),recoverable:false}};
  await saveResultBlob({...input,blob:new Blob(['cross-context image'])});
  vi.resetModules();
  const other=await import('../src/storage/translations/results'),otherCache=await import('../src/storage/translations');
  await otherCache.setTranslationCacheLimitMb(0);
  expect(await(await other.loadResultBlob(input)).text()).toBe('cross-context image');
  expect(await otherCache.translationCache.has(resultBlobKey(input.scope,input.job))).toBe(false);expect(input.download).not.toHaveBeenCalled();
  await otherCache.translationCache.clear();
  await expect(loadResultBlob(input)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  await expect(other.loadResultBlob(input)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
});

it('removes one channel from memory without evicting another channel',async()=>{
  await setTranslationCacheLimitMb(0);
  const first=request(),second=request();
  for(const input of [first,second]){input.job={...input.job,output_asset_id:null,result:{key:crypto.randomUUID(),recoverable:false}};await saveResultBlob({...input,blob:new Blob([input.scope.key])});}
  await translationCache.deleteOwner(first.scope.key);
  await expect(loadResultBlob(first)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
  expect(await(await loadResultBlob(second)).text()).toBe(second.scope.key);
});
