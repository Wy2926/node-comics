import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DirectImageRuntime} from '../src/translation/channels/transport/runtime';
import {startImageTransfer} from '../src/translation/channels/transport/client';
import {readTransferReceipt, saveTransferReceipt} from '../src/translation/channels/transport/receipts';
import {readDirectOperations, saveDirectOperation, updateDirectOperation} from '../src/translation/channels/transport/operations';
import {loadResultBlob, resultBlobKey, resultInMemory} from '../src/storage/translations/results';
import {translationCache} from '../src/storage/translations';
import type {ReadingTarget} from '../src/translation/automatic';
import type {Job} from '../src/types';
import {hashFile} from '../src/importers/hash';
import {decodedImage, transferLocks} from './channel-transfer-fixture';

const runtimes: DirectImageRuntime[] = [];
beforeEach(() => {transferLocks(); decodedImage();});
afterEach(() => {for (const runtime of runtimes.splice(0)) runtime.dispose(); vi.unstubAllGlobals();});
function target(id: string): ReadingTarget {
  return {entryId: 'book', mode: 'classic', page: {id, name: id, width: 800, height: 1200, blobKey: 'original-' + id, jobs: [], outputBlobs: {}}};
}
function setup(scope = {key: crypto.randomUUID()}) {
  const jobs = new Map<string, Job>(), consumed = vi.fn(async () => {});
  const driver = {errorMessage: (code: string) => code, start: vi.fn(async (id: string, blob: Blob) => {
    await startImageTransfer(id, scope.key, blob, {url: 'http://localhost/fixture', headers: {}, imageField: 'image', fields: {},
      maxBytes: 1024, maxPixels: 40_000_000, maxDimension: 30000});
  })};
  const runtime = new DirectImageRuntime(scope, {language: 'zh-Hans', getBlob: async key => new Blob([key]),
    onJobs: async incoming => {for (const job of incoming) jobs.set(job.id, job);}, onChange: () => {}, isCurrent: () => true,
    onInputConsumed: consumed,
  }, driver);
  runtimes.push(runtime); return {runtime, jobs, scope, driver, consumed};
}

it('returns from submit before completion, uses one slot and replaces only the unstarted reading tail', async () => {
  const responses: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))));
  const {runtime, jobs, driver, consumed} = setup();
  await runtime.submit(['a', 'b', 'c', 'd'].map(target));
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  expect(runtime.hasPending).toBe(true);
  await runtime.submit(['x', 'y'].map(target));
  expect(responses).toHaveLength(1);
  responses[0](new Response(new Blob(['translated-a'], {type: 'image/png'})));
  await vi.waitFor(async () => {
    await runtime.refresh();
    expect(responses).toHaveLength(2);
  });
  expect(await driver.start.mock.calls[0][1].text()).toBe('original-a');
  expect(await driver.start.mock.calls[1][1].text()).toBe('original-x');
  expect(consumed).toHaveBeenCalledWith('original-a');
  expect([...jobs.values()].find(job => job.status === 'succeeded')?.output_asset_id).toBeNull();
  responses[1](new Response(new Blob(['translated-x'], {type: 'image/png'})));
  runtime.dispose();
});
it('restores the same completed local result without an account, remote asset id or new translation', async () => {
  const fetcher = vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'}))); vi.stubGlobal('fetch', fetcher);
  const first = setup(), page = target('recover');
  await first.runtime.submit([page]);
  await vi.waitFor(async () => {await first.runtime.refresh(); expect([...first.jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  first.runtime.dispose();
  const second = setup(first.scope); await second.runtime.init(); await second.runtime.submit([page]);
  const job = [...second.jobs.values()].find(job => job.status === 'succeeded')!;
  expect(job.result).toEqual({key: job.id, recoverable: false}); expect(job.output_asset_id).toBeNull();
  expect(await (await loadResultBlob({scope: second.scope, job, isCurrent: () => true})).text()).toBe('translated');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not repeat failures; only an explicit retry creates another attempt', async () => {
  const fetcher = vi.fn(async () => new Response('failed', {status: 503})); vi.stubGlobal('fetch', fetcher);
  const {runtime, jobs} = setup(), page = target('retry');
  await runtime.submit([page]);
  await vi.waitFor(async () => {await runtime.refresh(); expect([...jobs.values()].some(job => job.status === 'failed')).toBe(true);});
  for (let i = 0; i < 3; i++) await runtime.submit([page]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await runtime.manual(page);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
it('keeps a running host receipt across runtime disposal and a fresh client observes it without resubmitting', async () => {
  let complete!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {complete = resolve;})); vi.stubGlobal('fetch', fetcher);
  const first = setup(), page = target('ongoing'); await first.runtime.submit([page]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  first.runtime.dispose(); const second = setup(first.scope); await second.runtime.init();
  expect([...second.jobs.values()][0].status).toBe('running');
  await second.runtime.submit([page]); expect(fetcher).toHaveBeenCalledTimes(1);
  complete(new Response(new Blob(['image'], {type: 'image/png'})));
  await vi.waitFor(async () => {await second.runtime.refresh(); expect([...second.jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('serializes concurrent completion observers and never replaces success with a receipt-cleanup failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['same-result'], {type: 'image/png'}))));
  const first = setup(), second = setup(first.scope), page = target('parallel');
  await Promise.all([first.runtime.init(), second.runtime.init()]);
  await first.runtime.submit([page]);
  await vi.waitFor(async () => {
    const record = (await readDirectOperations(first.scope.key))[0];
    expect(record && (await readTransferReceipt(record.job.id))?.state).toBe('succeeded');
  });
  await Promise.all(Array.from({length: 8}, (_, index) => (index % 2 ? first : second).runtime.refresh()));
  const saved = (await readDirectOperations(first.scope.key))[0];
  expect(saved.job.status).toBe('succeeded');
  expect(first.jobs.get(saved.job.id)?.status).toBe('succeeded');
  expect(second.jobs.get(saved.job.id)?.status).toBe('succeeded');
  expect((await readTransferReceipt(saved.job.id))?.output).toBeUndefined();
  expect(await (await loadResultBlob({scope: first.scope, job: saved.job, isCurrent: () => true})).text()).toBe('same-result');
  const replaced = {...saved, job: {...saved.job, id: crypto.randomUUID(), status: 'running' as const}};
  await saveDirectOperation(replaced);
  await updateDirectOperation({...saved, job: {...saved.job, status: 'failed'}});
  expect((await readDirectOperations(first.scope.key))[0].job.id).toBe(replaced.job.id);
});
it('reuses the same image digest across entries and serializes different images across runtimes', async () => {
  const responses: Array<(response: Response) => void> = [];
  const fetcher = vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))); vi.stubGlobal('fetch', fetcher);
  const first = setup(), second = setup(first.scope);
  const image = target('digest'), sameImage = {...target('digest'), entryId: 'another-book'};
  image.page.imageSha256 = sameImage.page.imageSha256 = await hashFile(new Blob(['original-digest']));
  await Promise.all([first.runtime.submit([image]), second.runtime.submit([sameImage])]);
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  await second.runtime.submit([target('different')]);
  expect(responses).toHaveLength(1);
  responses[0](new Response(new Blob(['first-image'], {type: 'image/png'})));
  await vi.waitFor(async () => {await Promise.all([first.runtime.refresh(), second.runtime.refresh()]); expect(responses).toHaveLength(2);});
  await first.runtime.submit([sameImage]); expect(responses).toHaveLength(2);
  responses[1](new Response(new Blob(['second-image'], {type: 'image/png'})));
  await vi.waitFor(async () => {await Promise.all([first.runtime.refresh(), second.runtime.refresh()]); expect(first.runtime.hasPending).toBe(false);});
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('admits one request when two contexts submit different images at exactly the same time', async () => {
  const responses: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))));
  const first = setup(), second = setup(first.scope);
  await Promise.all([first.runtime.submit([target('parallel-a')]), second.runtime.submit([target('parallel-b')])]);
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  expect(first.driver.start.mock.calls.length + second.driver.start.mock.calls.length).toBe(1);
  responses[0](new Response(new Blob(['first'], {type: 'image/png'})));
  await vi.waitFor(async () => {await Promise.all([first.runtime.refresh(), second.runtime.refresh()]); expect(responses).toHaveLength(2);});
  responses[1](new Response(new Blob(['second'], {type: 'image/png'})));
  await vi.waitFor(async () => {await Promise.all([first.runtime.refresh(), second.runtime.refresh()]); expect(first.runtime.hasPending || second.runtime.hasPending).toBe(false);});
});
it('does not resurrect a result when the user clears its cache while a long translation is running', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;})); vi.stubGlobal('fetch', fetcher);
  const {runtime, scope, jobs} = setup(); await runtime.submit([target('cleared')]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await translationCache.deleteOwner(scope.key);
  finish(new Response(new Blob(['late-image'], {type: 'image/png'})));
  await vi.waitFor(async () => {
    await runtime.refresh();
    expect([...jobs.values()].some(job => job.status === 'failed' && job.error?.code === 'RESULT_NOT_CACHED')).toBe(true);
  });
  const job = [...jobs.values()][0], key = resultBlobKey(scope, {...job, result: {key: job.id, recoverable: false}});
  expect(await translationCache.get(key)).toBeUndefined(); expect(resultInMemory(key)).toBeUndefined();
  await runtime.refresh(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await readTransferReceipt(job.id))?.output).toBeUndefined();
});
it('marks crash leftovers interrupted, isolates channel revisions and presents missing bytes as manual retry', async () => {
  const first = setup(), page = target('crash');
  vi.stubGlobal('fetch', vi.fn(async () => {throw Error('disconnected');}));
  await first.runtime.submit([page]);
  await vi.waitFor(async () => expect((await readDirectOperations(first.scope.key)).length).toBe(1));
  await vi.waitFor(async () => {
    const record = (await readDirectOperations(first.scope.key))[0];
    expect((await readTransferReceipt(record.job.id))?.state).toBe('failed');
  });
  first.runtime.dispose();
  const record = (await readDirectOperations(first.scope.key))[0];
  await saveTransferReceipt({id: record.job.id, scope: first.scope.key, state: 'running', updatedAt: Date.now()});
  const second = setup(first.scope); await second.runtime.init();
  expect([...second.jobs.values()][0]).toMatchObject({status: 'failed', error: {code: 'INTERRUPTED'}});
  const isolated = setup(); await isolated.runtime.init(); expect(isolated.jobs.size).toBe(0);
  page.page.translationError = 'RESULT_NOT_CACHED';
  expect(isolated.runtime.stateFor(page, true)).toMatchObject({kind: 'error', retryable: true});
});
