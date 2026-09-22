import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { stubAuthLocks } from './auth-fixture';
import { job, origin } from './translation-fixture';
import { loadResultBlob, resultBlobKey } from '../src/library/result-cache';
import { clearTranslations, getBlob, putBlob, removeBlob } from '../src/library/store';

beforeEach(() => stubAuthLocks());
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
  const other = await import('../src/library/result-cache');
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
  expect(await getBlob(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
});

it('does not return or persist a download after account invalidation', async () => {
  const input = request();
  let current = true;
  input.isCurrent = () => current;
  input.download.mockImplementation(async () => {current = false; return new Blob(['private']);});
  await expect(loadResultBlob(input)).rejects.toThrow();
  expect(await getBlob(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
});

it('downloads again after eviction and honors the existing clear-translations action', async () => {
  const input = request();
  await loadResultBlob(input);
  await removeBlob(resultBlobKey(origin, input.userId, input.job));
  await loadResultBlob(input);
  expect(input.download).toHaveBeenCalledTimes(2);
  await clearTranslations();
  expect(await getBlob(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
});

it('can display a result even when the finite budget immediately evicts its cache', async () => {
  const input = request();
  const original = 'inline-original:' + input.userId;
  await putBlob(original, new Blob(['pending upload']));
  const blob = await loadResultBlob({...input, cacheLimitMb: 0});
  expect(await blob.text()).toBe('translated');
  expect(await getBlob(resultBlobKey(origin, input.userId, input.job))).toBeUndefined();
  expect(await getBlob(original)).toBeInstanceOf(Blob);
  await removeBlob(original);
});
