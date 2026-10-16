import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DirectImageRuntime} from '../src/translation/channels/transport/runtime';
import {definition as mtu} from '../src/translation/channels/adapters/manga-translator-ui/definition';
import {startImageTransfer} from '../src/image-transfer/client';
import {readTransferReceipt, saveTransferReceipt} from '../src/image-transfer/receipts';
import {readDirectOperations, saveDirectOperation, updateDirectOperation} from '../src/translation/channels/transport/operations';
import * as directOperations from '../src/translation/channels/transport/operations';
import {loadResultBlob, resultBlobKey, resultInMemory} from '../src/storage/translations/results';
import {translationCache} from '../src/storage/translations';
import type {ReadingTarget} from '../src/translation/automatic';
import type {RuntimeOptions} from '../src/translation/channels/contracts';
import type {Job} from '../src/types';
import {hashFile} from '../src/importers/hash';
import {decodedImage, transferLocks} from './channel-transfer-fixture';

const runtimes: DirectImageRuntime[] = [];
beforeEach(() => {transferLocks(); decodedImage();});
afterEach(() => {for (const runtime of runtimes.splice(0)) runtime.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function target(id: string): ReadingTarget {
  return {entryId: 'book', mode: 'classic', page: {id, name: id, width: 800, height: 1200, blobKey: 'original-' + id, jobs: [], outputBlobs: {}}};
}
it('keeps the MTU upload byte limit at the channel submission entry', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const blob = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)], {type: 'image/png'}), jobs: Job[] = [];
  const connection = await mtu.open({id: crypto.randomUUID(), adapterId: mtu.id, name: 'Local GPU', revision: 1, settings: {baseUrl: 'http://localhost:8000'}}, {token: 'fixture-token'}, () => true);
  const runtime = connection.createRuntime({language: 'zh-Hans', getBlob: async () => blob, onJobs: async incoming => {jobs.push(...incoming);}, onChange: () => {}, isCurrent: () => true});
  try {
    await runtime.manual(target('oversized-upload'));
    expect(jobs.at(-1)).toMatchObject({status: 'failed', error: {code: 'IMAGE_TOO_LARGE'}});
    expect(fetcher).not.toHaveBeenCalled();
  } finally {runtime.dispose(); connection.dispose();}
});
function setup(scope = {key: crypto.randomUUID()}, options: Partial<Pick<RuntimeOptions, 'getBlob' | 'isCurrent'>> = {}) {
  const jobs = new Map<string, Job>(), consumed = vi.fn(async () => {});
  const driver = {errorMessage: (code: string) => code, start: vi.fn(async (id: string, blob: Blob) => {
    await startImageTransfer(id, scope.key, blob, {url: 'http://localhost/fixture', headers: {}, imageField: 'image', fields: {}});
  })};
  const runtime = new DirectImageRuntime(scope, {language: 'zh-Hans', getBlob: async key => new Blob([key]),
    onJobs: async incoming => {for (const job of incoming) jobs.set(job.id, job);}, onChange: () => {}, isCurrent: () => true,
    onInputConsumed: consumed,
    ...options,
  }, driver);
  runtimes.push(runtime); return {runtime, jobs, scope, driver, consumed};
}

it('stops an invalidated unsubmitted tail, keeps its accepted request, and resumes the remaining pages', async () => {
  const firstResponse = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'})))
    .mockImplementationOnce(() => firstResponse.promise);
  vi.stubGlobal('fetch', fetcher);
  const {runtime, driver, scope} = setup(), pages = ['a', 'b', 'c'].map(target);
  let allowed = true;
  await runtime.submit(pages, () => allowed);
  await vi.waitFor(() => expect(driver.start).toHaveBeenCalledTimes(1));
  const acceptedId = driver.start.mock.calls[0][0];
  allowed = false;
  firstResponse.resolve(new Response(new Blob(['translated-a'], {type: 'image/png'})));
  await vi.waitFor(async () => {
    await runtime.refresh();
    expect((await readDirectOperations(scope.key)).find(record => record.job.id === acceptedId)?.job.status).toBe('succeeded');
  });
  await navigator.locks.request('nc-image-transfer:admission:' + scope.key, () => {});
  expect(driver.start).toHaveBeenCalledTimes(1);
  expect(runtime.hasPending).toBe(false);
  expect((await readDirectOperations(scope.key)).map(record => record.job.id)).toEqual([acceptedId]);

  allowed = true;
  await runtime.submit(pages, () => allowed);
  await vi.waitFor(async () => {await runtime.refresh(); expect(driver.start).toHaveBeenCalledTimes(3);});
  expect(await Promise.all(driver.start.mock.calls.map(([, blob]) => blob.text()))).toEqual(['original-a', 'original-b', 'original-c']);
});

it('discards source preparation invalidated before upload and can resume it without a failed receipt', async () => {
  const original = Promise.withResolvers<Blob>();
  const getBlob = vi.fn(async (key: string) => new Blob([key])).mockImplementationOnce(() => original.promise);
  const fetcher = vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'})));
  vi.stubGlobal('fetch', fetcher);
  const {runtime, driver, scope, jobs} = setup(undefined, {getBlob}), page = target('preparing');
  let allowed = true;
  await runtime.submit([page], () => allowed);
  await vi.waitFor(() => expect(getBlob).toHaveBeenCalledTimes(1));
  allowed = false;
  original.resolve(new Blob(['original-preparing']));
  await navigator.locks.request('nc-image-transfer:admission:' + scope.key, () => {});
  expect(driver.start).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readDirectOperations(scope.key)).toEqual([]);
  expect(jobs.size).toBe(0);
  expect(runtime.hasPending).toBe(false);

  allowed = true;
  await runtime.submit([page], () => allowed);
  await vi.waitFor(async () => {await runtime.refresh(); expect([...jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  expect(driver.start).toHaveBeenCalledTimes(1);
  expect([...jobs.values()].some(job => job.status === 'failed')).toBe(false);
});

it.each([false, true])('rechecks a preparing page against the latest window (still present: %s)', async retained => {
  const original = Promise.withResolvers<Blob>();
  const getBlob = vi.fn(async (key: string) => new Blob([key])).mockImplementationOnce(() => original.promise);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'}))));
  const {runtime, driver} = setup(undefined, {getBlob});
  let previousWindow = true;
  await runtime.submit(['a', 'b'].map(target), () => previousWindow);
  await vi.waitFor(() => expect(getBlob).toHaveBeenCalledTimes(1));
  previousWindow = false;
  const remaining = retained ? ['a', 'c'] : ['c'];
  await runtime.submit(remaining.map(target), page => remaining.includes(page.page.id));
  original.resolve(new Blob(['original-a']));
  await vi.waitFor(async () => {await runtime.refresh(); expect(driver.start).toHaveBeenCalledTimes(remaining.length);});
  expect(await Promise.all(driver.start.mock.calls.map(([, blob]) => blob.text()))).toEqual(remaining.map(id => 'original-' + id));
});

it('rechecks a queued target after acquiring the channel admission lock', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'}))));
  const getBlob = vi.fn(async (key: string) => new Blob([key]));
  const {runtime, driver, scope} = setup(undefined, {getBlob}), page = target('locked');
  const lockName = 'nc-image-transfer:admission:' + scope.key;
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const blocker = navigator.locks.request(lockName, async () => {entered.resolve(); await release.promise;});
  await entered.promise;
  let allowed = true;
  await runtime.submit([page], () => allowed);
  await vi.waitFor(async () => expect((await navigator.locks.query()).pending?.some(lock => lock.name === lockName)).toBe(true));
  allowed = false; release.resolve(); await blocker;
  await navigator.locks.request(lockName, () => {});
  expect(getBlob).not.toHaveBeenCalled();
  expect(driver.start).not.toHaveBeenCalled();
  expect(await readDirectOperations(scope.key)).toEqual([]);
  allowed = true;
  await runtime.submit([page], () => allowed);
  await vi.waitFor(async () => {await runtime.refresh(); expect(driver.start).toHaveBeenCalledTimes(1);});
});

it('withdraws an invalidated saved intent before upload without publishing it to another runtime', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['translated'], {type: 'image/png'}))));
  const persisted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const persist = directOperations.saveDirectOperation;
  vi.spyOn(directOperations, 'saveDirectOperation').mockImplementationOnce(async operation => {
    await persist(operation); persisted.resolve(); await release.promise;
  });
  const first = setup(), page = target('saved-before-upload');
  let allowed = true;
  await first.runtime.submit([page], () => allowed);
  await persisted.promise;
  const observer = setup(first.scope);
  await observer.runtime.init(); await observer.runtime.restore([page]);
  expect(observer.jobs.size).toBe(0);
  expect(observer.runtime.hasPending).toBe(false);
  allowed = false; release.resolve();
  await navigator.locks.request('nc-image-transfer:admission:' + first.scope.key, () => {});
  expect(first.driver.start).not.toHaveBeenCalled();
  expect(first.jobs.size).toBe(0);
  expect(await readDirectOperations(first.scope.key)).toEqual([]);
  await observer.runtime.refresh();
  expect(observer.runtime.hasPending).toBe(false);

  allowed = true;
  await first.runtime.submit([page], () => allowed);
  await vi.waitFor(async () => {await observer.runtime.refresh(); expect([...observer.jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  expect(first.driver.start).toHaveBeenCalledTimes(1);
  expect(observer.driver.start).not.toHaveBeenCalled();
});

it.each([false, true])('restores the prior result if a manual replacement loses its context before starting the driver (owner transferred: %s)', async handedOff => {
  const fetcher = vi.fn(async () => new Response(new Blob(['previous-result'], {type: 'image/png'})));
  vi.stubGlobal('fetch', fetcher);
  let active = true;
  const first = setup(undefined, {isCurrent: () => active}), page = target('manual-before-upload');
  page.entryId = crypto.randomUUID();
  page.page.imageSha256 = await hashFile(new Blob(['original-manual-before-upload']));
  await first.runtime.submit([page]);
  await vi.waitFor(async () => {await first.runtime.refresh(); expect([...first.jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  const previous = (await readDirectOperations(first.scope.key))[0];
  const persisted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const persist = directOperations.saveDirectOperation;
  vi.spyOn(directOperations, 'saveDirectOperation').mockImplementationOnce(async operation => {
    await persist(operation); persisted.resolve(); await release.promise;
  });
  const retry = first.runtime.manual(page);
  await persisted.promise;
  const owner = {entryId: crypto.randomUUID(), pageId: 'surviving-page'};
  if (handedOff) {
    await directOperations.transferDirectOperation((await readDirectOperations(first.scope.key))[0], owner);
    await directOperations.blockEntryDirectOperations(page.entryId);
  }
  active = false; release.resolve(); await retry;
  expect((await readDirectOperations(first.scope.key))[0]).toEqual(handedOff ? {...previous, ...owner} : previous);
  expect(await (await loadResultBlob({scope: first.scope, job: previous.job, isCurrent: () => true})).text()).toBe('previous-result');
  const restored = setup(first.scope);
  const survivingPage = handedOff ? {...page, entryId: owner.entryId, page: {...page.page, id: owner.pageId}} : page;
  await restored.runtime.init(); await restored.runtime.submit([survivingPage]); await restored.runtime.refresh();
  expect(restored.jobs.get(previous.job.id)?.status).toBe('succeeded');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reports a manual source-preparation failure while retaining the previous completed result', async () => {
  const fetcher = vi.fn(async () => new Response(new Blob(['previous-result'], {type: 'image/png'})));
  vi.stubGlobal('fetch', fetcher);
  const getBlob = vi.fn<(key: string) => Promise<Blob | undefined>>(async key => new Blob([key]));
  const {runtime, scope, jobs} = setup(undefined, {getBlob}), page = target('missing-original');
  await runtime.submit([page]);
  await vi.waitFor(async () => {await runtime.refresh(); expect([...jobs.values()].some(job => job.status === 'succeeded')).toBe(true);});
  const previous = (await readDirectOperations(scope.key))[0];
  getBlob.mockResolvedValue(undefined);
  await runtime.manual(page);
  const failed = (await readDirectOperations(scope.key))[0];
  expect(failed.job.id).not.toBe(previous.job.id);
  expect(failed.job).toMatchObject({status: 'failed', error: {code: 'SOURCE_MISSING'}});
  expect(failed.previousResult).toEqual(previous.job);
  expect(jobs.get(failed.job.id)?.status).toBe('failed');
  expect(runtime.stateFor(page, true)).toMatchObject({kind: 'error', message: 'SOURCE_MISSING', retryable: true});
  expect(await (await loadResultBlob({scope, job: previous.job, isCurrent: () => true})).text()).toBe('previous-result');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('withdraws only the exact unstarted UUID and never restores a deleted current owner', async () => {
  const previous: directOperations.DirectOperation = {id: crypto.randomUUID(), scope: crypto.randomUUID(), entryId: crypto.randomUUID(), pageId: 'page',
    job: {id: crypto.randomUUID(), mode: 'classic', target_language: 'zh-Hans', status: 'succeeded', phase: 'succeeded',
      created_at: new Date().toISOString(), version: 1, quota_pages: 0, cache_hit: false}};
  const replacement = {...previous, entryId: crypto.randomUUID(), job: {...previous.job, id: crypto.randomUUID(), status: 'running' as const}};
  const newer = {...replacement, job: {...replacement.job, id: crypto.randomUUID()}};
  await saveDirectOperation(newer);
  await directOperations.discardUnstartedDirectOperation(replacement, previous);
  expect(await directOperations.readDirectOperation(previous.id)).toEqual(newer);
  await saveDirectOperation(replacement);
  await directOperations.blockEntryDirectOperations(replacement.entryId);
  await directOperations.discardUnstartedDirectOperation(replacement, previous);
  expect(await directOperations.readDirectOperation(previous.id)).toBeUndefined();
});

it('processes the fifth slot without dropping the current request or duplicating completed pages',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Blob(['translated'],{type:'image/png'}))));
  const {runtime,driver}=setup();
  await runtime.submit(['a','b','c','d','e','ignored'].map(target));
  await vi.waitFor(async()=>{await runtime.refresh();expect(driver.start).toHaveBeenCalledTimes(5);},5000);
  expect(await Promise.all(driver.start.mock.calls.map(([,blob])=>blob.text()))).toEqual(['a','b','c','d','e'].map(id=>'original-'+id));
  await runtime.submit(['b','c','d','e','f'].map(target));
  await vi.waitFor(async()=>{await runtime.refresh();expect(driver.start).toHaveBeenCalledTimes(6);},5000);
  expect(await driver.start.mock.calls[5][1].text()).toBe('original-f');
});
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
  expect([...jobs.values()].find(job => job.status === 'succeeded')?.result?.recoverable).toBe(false);
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
  expect(job.result).toEqual({key: job.id, recoverable: false});
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
