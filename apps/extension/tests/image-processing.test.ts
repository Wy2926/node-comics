import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {decodedImage, transferLocks} from './channel-transfer-fixture';
import {nunifAdapter} from '../src/image-processing/adapters/nunif';
import {enhanceImage} from '../src/image-processing/runtime';
import {activeProcessingProfile, normalizeSettings, processingDefaults, processingIdentity, saveProcessingProfile, readProcessingSettings, updateProcessingSettings} from '../src/image-processing/settings';
import {clearProcessingCache, removeProcessingOwner, removeProcessingProfile, processingCache, readServiceLane,findProcessingRecord,saveProcessingRecord} from '../src/image-processing/storage';
import {readTransferReceipt,saveTransferReceipt,trimTransferReceipts} from '../src/image-transfer/receipts';
import {hashFile} from '../src/importers/hash';
import type {ProcessingProfile} from '../src/image-processing/contracts';

let values: Map<string, string>;
beforeEach(() => {
  transferLocks(); decodedImage(); values = new Map();
  vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value)});
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function selected(): Promise<ProcessingProfile> {
  await saveProcessingProfile('nunif', 'Local enhancement', {url: 'http://localhost/' + crypto.randomUUID()});
  await updateProcessingSettings(value => ({...value, enabled: true}));
  return (await readProcessingSettings()).profiles[0];
}
const input = () => {
  const blob = new Blob(['complete translated pixels'], {type: 'image/png'});
  return {owner: crypto.randomUUID(), key: 'complete-translation:account:language:job', blob, validate:vi.fn(async()=>{}),
    load:vi.fn(async(_signal:AbortSignal)=>({blob,release:vi.fn()}))};
};
const signal = () => new AbortController().signal;
const output = () => new Response(new Blob(['enhanced pixels'], {type: 'image/png'}));

it('keeps enhancement off by default; saving normalizes only and never contacts a model', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await readProcessingSettings()).toEqual(processingDefaults());
  await saveProcessingProfile('nunif', 'My service', {url: 'http://localhost:8812/base///'});
  const value = await readProcessingSettings();
  expect(value.enabled).toBe(false); expect(value.profiles[0].settings).toEqual({url:'http://localhost:8812/base/', style:'art', scale:'2', noise:'-1'});
  expect(fetcher).not.toHaveBeenCalled();
  const profile = value.profiles[0];
  await saveProcessingProfile('nunif', 'Renamed', profile.settings, profile.id);
  expect((await readProcessingSettings()).profiles[0].revision).toBe(1);
  await saveProcessingProfile('nunif', 'Renamed', {...profile.settings, noise:'1'}, profile.id);
  expect((await readProcessingSettings()).profiles[0].revision).toBe(2);
});
it('owns the exact nunif protocol and rejects credential-bearing URLs or invalid options', () => {
  const adapter = nunifAdapter();
  expect(adapter.request({url:'https://example.test/prefix',style:'art_scan',scale:'1',noise:'3'}))
    .toEqual({url:'https://example.test/prefix/api',headers:{},imageField:'file',fields:{style:'art_scan',scale:'1',noise:'3',format:'0'}});
  for (const url of ['file:///image','http://user:pass@localhost','https://example.test/?token=secret','https://example.test/#secret'])
    expect(() => adapter.normalize({url})).toThrow();
  expect(() => adapter.normalize({url:'http://localhost',scale:'4'})).toThrow();
});
it('defaults enhancement cache to 10 GB without replacing valid saved budgets', async () => {
  expect(processingDefaults().cacheLimitMb).toBe(10240);
  for (const cacheLimitMb of [128, 512, 1024, 10240]) {
    await updateProcessingSettings(value => ({...value, cacheLimitMb}));
    expect((await readProcessingSettings()).cacheLimitMb).toBe(cacheLimitMb);
  }
  for (const cacheLimitMb of [undefined, -1, 0, NaN, 2048]) expect(normalizeSettings({cacheLimitMb}).cacheLimitMb).toBe(10240);
});
it('invalidates display only for effective profile changes or an explicit cache clear', async () => {
  const profile = await selected(), before = processingIdentity(await readProcessingSettings());
  await saveProcessingProfile(profile.adapterId, 'Renamed', profile.settings, profile.id);
  await updateProcessingSettings(value => ({...value, cacheLimitMb: 128}));
  expect(processingIdentity(await readProcessingSettings())).toBe(before);
  await clearProcessingCache();
  expect(processingIdentity(await readProcessingSettings())).not.toBe(before);
  await updateProcessingSettings(value => ({...value, enabled: false}));
  expect(processingIdentity(await readProcessingSettings())).toBe('');
});
it('sends the full parent bytes unchanged, deduplicates concurrent readers and recovers cached output', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    expect(await (form.get('file') as Blob).text()).toBe('complete translated pixels');
    expect(form.get('format')).toBe('0'); expect(form.get('scale')).toBe('2');
    expect(init.credentials).toBe('omit'); expect(init.referrerPolicy).toBe('no-referrer');
    return output();
  });
  const reads = vi.spyOn(original.blob, 'slice');
  vi.stubGlobal('fetch', fetcher);
  const results = await Promise.all([enhanceImage(original,profile,signal()), enhanceImage(original,profile,signal())]);
  expect(await results[0].text()).toBe('enhanced pixels');
  await enhanceImage(original,profile,signal());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(reads).toHaveBeenCalledOnce();
});
it('uses stable parent identity without reopening bytes, and isolates account, language and owner', async () => {
  const profile = await selected(), original = input();
  const fetcher = vi.fn(async () => output()); vi.stubGlobal('fetch', fetcher);
  await enhanceImage(original,profile,signal());
  await enhanceImage({...original,key:'complete-translation:other-account:language:job'},profile,signal());
  const unavailable={...original,load:vi.fn(async()=>{throw Error('parent no longer available');})};
  expect(await(await enhanceImage(unavailable,profile,signal())).text()).toBe('enhanced pixels');
  expect(unavailable.load).not.toHaveBeenCalled();
  await enhanceImage({...original,owner:crypto.randomUUID()},profile,signal());
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('does not rerun after cache eviction or clearing without an explicit enhancement retry', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn(async () => output()); vi.stubGlobal('fetch', fetcher);
  await enhanceImage(original,profile,signal()); await clearProcessingCache(false);
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'RESULT_MISSING'});
  expect(fetcher).toHaveBeenCalledOnce();
  await enhanceImage(original,profile,signal(),{retry:true}); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('clears finished records and their receipts by default, allowing fresh enhancement without blocking the service', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn(async () => output()); vi.stubGlobal('fetch', fetcher);
  await enhanceImage(original,profile,signal());
  const lookup = await hashFile(new Blob([JSON.stringify([original.owner,original.key,profile.id,profile.revision])]));
  const record = (await findProcessingRecord(lookup))!;
  expect((await processingCache.usage()).bytes).toBeGreaterThan(0);
  const unrelatedId = crypto.randomUUID();
  await saveTransferReceipt({... (await readTransferReceipt(record.requestId))!, id: unrelatedId, scope: 'translation:unrelated'});
  await clearProcessingCache();
  expect((await processingCache.usage()).bytes).toBe(0);
  expect(await findProcessingRecord(lookup)).toBeUndefined();
  expect(await readTransferReceipt(record.requestId)).toBeUndefined();
  expect(await readTransferReceipt(unrelatedId)).toBeDefined();
  await enhanceImage(original,profile,signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('clears failed records in bounded batches and is safe to repeat', async () => {
  const owner = crypto.randomUUID(), token = await processingCache.token(owner), records = Array.from({length: 105}, (_, index) => ({
    id: `${owner}:${index}`, lookupKey: `${owner}:${index}`, owner, profileId: owner, requestId: crypto.randomUUID(), state: 'failed' as const, token,
  }));
  for (const record of records) await saveProcessingRecord(record);
  await clearProcessingCache(); await clearProcessingCache();
  for (const record of records) expect(await findProcessingRecord(record.lookupKey)).toBeUndefined();
});
it('keeps running records during a full clear, fences late output and never repeats the accepted request', async () => {
  const profile = await selected(), original = input(), pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher);
  const work = enhanceImage(original,profile,signal()), failed = expect(work).rejects.toMatchObject({code:'RESULT_MISSING'});
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const lookup = await hashFile(new Blob([JSON.stringify([original.owner,original.key,profile.id,profile.revision])]));
  const record = (await findProcessingRecord(lookup))!;
  await clearProcessingCache();
  expect((await findProcessingRecord(lookup))?.requestId).toBe(record.requestId);
  expect(await readTransferReceipt(record.requestId)).toBeDefined();
  pending.resolve(output()); await failed;
  expect((await processingCache.usage()).bytes).toBe(0);
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'RESULT_MISSING'});
  expect(fetcher).toHaveBeenCalledOnce();
});
it('does not erase uncertain service protection when clearing processing records', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn(async () => {throw Error('network lost');}); vi.stubGlobal('fetch', fetcher);
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'INTERRUPTED'});
  await clearProcessingCache();
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'INTERRUPTED'});
  expect(fetcher).toHaveBeenCalledOnce();
});
it('delivers once when disk admission fails, then reports missing cache without repeating the service',async()=>{
  const profile=await selected(),original=input(),fetcher=vi.fn(async()=>output());vi.stubGlobal('fetch',fetcher);
  const put=vi.spyOn(processingCache,'put').mockResolvedValue(false);
  expect(await(await enhanceImage(original,profile,signal())).text()).toBe('enhanced pixels');
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'RESULT_MISSING'});
  expect(fetcher).toHaveBeenCalledOnce();expect(original.load).toHaveBeenCalledOnce();put.mockRestore();
});
it('preserves HTTP failure, does not downsample or auto-retry, and sanitizes remote error content', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn(async () => new Response('private OCR response',{status:413})); vi.stubGlobal('fetch', fetcher);
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'HTTP_413'});
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'HTTP_413'});
  expect(fetcher).toHaveBeenCalledOnce();
});
it('does not submit queued pages after enhancement is disabled', async () => {
  const profile = await selected(), fetcher = vi.fn(async () => output()); vi.stubGlobal('fetch', fetcher);
  await updateProcessingSettings(value => ({...value,enabled:false}));
  await expect(enhanceImage(input(),profile,signal())).rejects.toMatchObject({name:'AbortError'});
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps an accepted request alive when the reader leaves, then joins it instead of resubmitting', async () => {
  const profile = await selected(), original = input(), pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(), work = enhanceImage(original,profile,controller.signal);
  const stopped = expect(work).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); controller.abort(); await stopped;
  const recovered = enhanceImage(original,profile,signal());
  pending.resolve(output()); expect(await (await recovered).text()).toBe('enhanced pixels');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('stops automatic admission to an uncertain service until a manual retry confirms it', async () => {
  const profile = await selected(), original = input(), fetcher = vi.fn<() => Promise<Response>>(async () => {throw Error('network lost');}); vi.stubGlobal('fetch', fetcher);
  await expect(enhanceImage(original,profile,signal())).rejects.toMatchObject({code:'INTERRUPTED'});
  await expect(enhanceImage(input(),profile,signal())).rejects.toMatchObject({code:'INTERRUPTED'});
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockImplementation(async () => output());
  await enhanceImage(original,profile,signal(),{retry:true}); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('publishes after every UI leaves and survives receipt expiry without rereading the parent', async () => {
  const profile=await selected(),original=input(),pending=Promise.withResolvers<Response>();
  const fetcher=vi.fn(()=>pending.promise);vi.stubGlobal('fetch',fetcher);
  const controller=new AbortController(),work=enhanceImage(original,profile,controller.signal);
  const stopped=expect(work).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());controller.abort();await stopped;
  pending.resolve(output());
  const service=await hashFile(new Blob([nunifAdapter().request(profile.settings).url]));
  const lane=(await readServiceLane(service))!;
  await vi.waitFor(async()=>expect((await readTransferReceipt(lane.requestId))?.output).toBeUndefined());
  await vi.waitFor(async()=>expect(await processingCache.inventory([original.owner])).toHaveLength(1));
  const receipt=(await readTransferReceipt(lane.requestId))!;
  await saveTransferReceipt({...receipt,updatedAt:Date.now()-25*60*60*1000});await trimTransferReceipts();
  expect(await readTransferReceipt(lane.requestId)).toBeUndefined();
  original.load.mockRejectedValue(Error('parent unavailable'));
  expect(await(await enhanceImage(original,profile,signal())).text()).toBe('enhanced pixels');
  expect(original.load).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
  expect((await readServiceLane(service))?.settled).toBe(true);
});
it('revalidates access on a cache hit without opening the revoked parent', async () => {
  const profile=await selected(),original=input();vi.stubGlobal('fetch',vi.fn(async()=>output()));
  await enhanceImage(original,profile,signal());original.load.mockClear();
  original.validate.mockRejectedValue(Error('access revoked'));
  await expect(enhanceImage(original,profile,signal())).rejects.toThrow('access revoked');
  expect(original.load).not.toHaveBeenCalled();
});
it('recovers a terminal receipt after publication failed, without loading or resubmitting the parent',async()=>{
  const profile=await selected(),original=input(),pending=Promise.withResolvers<Response>();
  const fetcher=vi.fn(()=>pending.promise);vi.stubGlobal('fetch',fetcher);
  const controller=new AbortController(),work=enhanceImage(original,profile,controller.signal);
  const stopped=expect(work).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());controller.abort();await stopped;
  const put=vi.spyOn(processingCache,'put').mockRejectedValueOnce(Error('publication interrupted'));
  pending.resolve(output());await vi.waitFor(()=>expect(put).toHaveBeenCalledOnce());put.mockRestore();
  const lookup=await hashFile(new Blob([JSON.stringify([original.owner,original.key,profile.id,profile.revision])]));
  expect((await findProcessingRecord(lookup))?.state).toBe('running');
  original.load.mockRejectedValue(Error('parent unavailable'));
  expect(await(await enhanceImage(original,profile,signal())).text()).toBe('enhanced pixels');
  expect(original.load).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
});
it('stops a large input digest between chunks on cancellation', async () => {
  const blob=new Blob([new Uint8Array(8*1024*1024)]),reads=vi.spyOn(blob,'slice'),controller=new AbortController();
  await expect(hashFile(blob,()=>controller.abort(),controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(reads).toHaveBeenCalledOnce();
});
it('removes only the deleted profile cache and leaves other in-flight profile results usable', async () => {
  const inactive = await selected(), prior = input();
  const fetcher = vi.fn(async () => output()); vi.stubGlobal('fetch', fetcher);
  await enhanceImage(prior,inactive,signal());
  await saveProcessingProfile('nunif', 'Another service', {url:'http://localhost/' + crypto.randomUUID()});
  const active = activeProcessingProfile(await readProcessingSettings())!, original = input(), pending = Promise.withResolvers<Response>();
  fetcher.mockImplementationOnce(() => pending.promise);
  const work = enhanceImage(original,active,signal());
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await removeProcessingProfile(inactive.id);
  pending.resolve(output());
  expect(await (await work).text()).toBe('enhanced pixels');
  expect(await processingCache.inventory([prior.owner])).toHaveLength(0);
  await enhanceImage(original,active,signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['owner','profile'] as const)('preserves a completed service outcome when removing a departed %s', async kind => {
  const profile = await selected(), original = input(), pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async () => output()).mockImplementationOnce(() => pending.promise); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(), work = enhanceImage(original,profile,controller.signal);
  const stopped = expect(work).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); controller.abort(); await stopped;
  pending.resolve(output());
  const service = await hashFile(new Blob([nunifAdapter().request(profile.settings).url]));
  const lane = (await readServiceLane(service))!;
  await vi.waitFor(async () => expect((await readTransferReceipt(lane.requestId))?.state).toBe('succeeded'));
  if (kind === 'owner') await removeProcessingOwner(original.owner);
  else {
    await saveProcessingProfile('nunif', 'Same service', profile.settings);
    await removeProcessingProfile(profile.id);
  }
  expect((await readServiceLane(service))?.settled).toBe(true);
  expect(await readTransferReceipt(lane.requestId)).toBeUndefined();
  await enhanceImage(input(),activeProcessingProfile(await readProcessingSettings())!,signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['owner','profile'] as const)('fences late results and future uploads after %s removal', async kind => {
  const profile = await selected(), original = input(), pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher);
  const work = enhanceImage(original,profile,signal());
  const failed = expect(work).rejects.toBeDefined();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  if (kind === 'owner') await removeProcessingOwner(original.owner); else await removeProcessingProfile(profile.id);
  pending.resolve(output()); await failed;
  expect(await processingCache.inventory([original.owner])).toHaveLength(0);
  await expect(enhanceImage(original,profile,signal(),{retry:true})).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledOnce();
});
