import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubAuthLocks } from './auth-fixture';
import { job, origin } from './translation-fixture';
import { loadResultBlob, resultBlobKey, resultInMemory } from '../src/storage/translations/results';
import { translationCache, setTranslationCacheLimitMb } from '../src/storage/translations';
import { sourcePageCache } from '../src/storage/source-pages';
import { SourceDatabaseSchemaError } from '../src/storage/database';

beforeEach(async () => { stubAuthLocks(); await setTranslationCacheLimitMb(1024); });
afterEach(()=>vi.restoreAllMocks());
const request = () => ({ origin, userId: crypto.randomUUID(),
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
  for (const patch of [{}, {userId: 'other'}, {origin: 'https://other.example'},
    {job: {...input.job, id: 'another-job'}}, {job: {...input.job, output_asset_id: 'new-output'}}])
    await loadResultBlob({...input, ...patch});
  expect(input.download).toHaveBeenCalledTimes(5);
});

it('rejects revoked or expired results even with cached bytes', async () => {
  const input = request();
  await loadResultBlob(input);
  for (const patch of [{result_available: false}, {result_expired: true}, {output_asset_id: null}])
    await expect(loadResultBlob({...input, job: {...input.job, ...patch}})).rejects.toThrow();
  expect(input.download).toHaveBeenCalledTimes(1);
});

it('does not retain failed downloads and supports a download-only retry', async () => {
  const input = request();
  input.download.mockRejectedValueOnce(Error('offline'));
  await expect(loadResultBlob(input)).rejects.toThrow('offline');
  expect(await translationCache.get(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
});

it('does not return or persist a download after account invalidation', async () => {
  const input = request();
  let current = true;
  input.isCurrent = () => current;
  input.download.mockImplementation(async () => {current = false; return new Blob(['private']);});
  await expect(loadResultBlob(input)).rejects.toThrow();
  expect(await translationCache.get(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
});

it('downloads again after eviction and honors the existing clear-translations action', async () => {
  const input = request();
  await loadResultBlob(input);
  await translationCache.delete(resultBlobKey(origin, input.userId, input.job));
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
  await translationCache.clear();
  expect(await translationCache.get(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
});

it('can display a result even when the finite budget immediately evicts its cache', async () => {
  const input = request();
  const original = 'inline-original:' + input.userId;
  await sourcePageCache.put(original, new Blob(['pending upload']));
  await setTranslationCacheLimitMb(0);
  const blob = await loadResultBlob(input);
  expect(await blob.text()).toBe('translated');
  expect(await translationCache.get(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
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
  expect(resultInMemory(resultBlobKey(input.origin,input.userId,input.job))).toBeUndefined();
  // Failed coalesced work must not poison a subsequent retry after storage is repaired.
  expect(await(await loadResultBlob(input)).text()).toBe('translated');expect(input.download).toHaveBeenCalledOnce();
});

it('reports schema errors during result persistence instead of marking the result available in memory',async()=>{
  const input=request(),error=new SourceDatabaseSchemaError('translations','缺少 objects');
  vi.spyOn(translationCache,'put').mockRejectedValueOnce(error);
  await expect(loadResultBlob(input)).rejects.toBe(error);expect(input.download).toHaveBeenCalledOnce();
  expect(resultInMemory(resultBlobKey(input.origin,input.userId,input.job))).toBeUndefined();
});
