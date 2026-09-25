import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {startImageTransfer, interruptAbandonedTransfer, HOST_MESSAGE} from '../src/translation/channels/transport/client';
import {executeImageTransfer} from '../src/translation/channels/transport/execute';
import {readTransferReceipt, saveTransferReceipt} from '../src/translation/channels/transport/receipts';
import {registerImageTransferHost, trustedHostSender} from '../src/translation/channels/transport/host';
import {transferLock, type ImageTransferRequest} from '../src/translation/channels/transport/types';
import {decodedImage, transferLocks} from './channel-transfer-fixture';

const recipe = (): ImageTransferRequest => ({url: 'http://localhost:8000/translate/image', headers: {'X-Test-Token': 'fixture-secret'}, imageField: 'image', fields: {config: '{}'}, maxBytes: 1024, maxPixels: 40_000_000, maxDimension: 30000});
beforeEach(() => {transferLocks(); decodedImage();});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

it('uploads in a page, validates the image and persists only receipt/bytes, never credentials', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('config')).toBe('{}');
    return new Response(new Blob(['png bytes'], {type: 'image/png'}));
  });
  vi.stubGlobal('fetch', fetcher);
  const id = crypto.randomUUID();
  await startImageTransfer(id, 'local', new Blob(['original']), recipe());
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  const receipt = await readTransferReceipt(id);
  expect(await receipt?.output?.text()).toBe('png bytes'); expect(receipt?.input).toBeUndefined();
  expect(JSON.stringify(receipt)).not.toMatch(/fixture-secret|localhost|headers|url/);
  await startImageTransfer(id, 'local', new Blob(['duplicate']), recipe());
  await executeImageTransfer(id, recipe());
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('holds a durable receipt while the server is silent and never repeats it after a new context starts', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher);
  const id = crypto.randomUUID();
  await startImageTransfer(id, 'durable', new Blob(['original']), recipe());
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect((await interruptAbandonedTransfer(id))?.state).toBe('running');
  await startImageTransfer(id, 'durable', new Blob(['duplicate']), recipe());
  finish(new Response(new Blob(['image'], {type: 'image/png'})));
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('marks an abandoned request interrupted and does not automatically resend it', async () => {
  const id = crypto.randomUUID(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await saveTransferReceipt({id, scope: 'closed-page', state: 'running', input: new Blob(['original']), updatedAt: Date.now()});
  expect(await interruptAbandonedTransfer(id)).toMatchObject({state: 'failed', errorCode: 'INTERRUPTED', input: undefined});
  await startImageTransfer(id, 'closed-page', new Blob(['original']), recipe());
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not accept HTTP success with invalid/oversized images and retains no remote error text', async () => {
  for (const response of [new Response('OCR and credentials', {headers: {'Content-Type': 'text/plain'}}), new Response('private', {status: 401}), new Response(new Blob(['x'.repeat(1025)], {type: 'image/png'}))]) {
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const id = crypto.randomUUID(); await startImageTransfer(id, id, new Blob(['original']), recipe());
    await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('failed'));
    expect(JSON.stringify(await readTransferReceipt(id))).not.toMatch(/OCR|credentials|private/);
  }
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {throw Error('bad image');}));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['undecodable'], {type: 'image/png'}))));
  const id = crypto.randomUUID(); await startImageTransfer(id, id, new Blob(['original']), recipe());
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.errorCode).toBe('INVALID_IMAGE'));
});
it('runs a worker request in an inactive host and survives a lost message acknowledgement without a resend', async () => {
  let ready = false;
  const create = vi.fn(async () => {ready = true; return {id: 77};});
  const sendMessage = vi.fn(async (message: {type: string; action: string; id?: string; request?: ImageTransferRequest}) => {
    expect(message.type).toBe(HOST_MESSAGE);
    if (message.action === 'ping') {if (!ready) throw Error('no host'); return {ready: true};}
    void executeImageTransfer(message.id!, message.request!);
    throw Error('SW message channel closed');
  });
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (path: string) => 'chrome-extension://own' + path, sendMessage}, tabs: {create}});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const id = crypto.randomUUID(); await startImageTransfer(id, id, new Blob(['original']), recipe());
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  expect(create).toHaveBeenCalledWith({url: 'chrome-extension://own/translation-host.html', active: false});
  expect(sendMessage.mock.calls.filter(([message]) => message.action === 'start')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(trustedHostSender({id: 'own', url: 'https://untrusted.example', tab: {id: 1} as chrome.tabs.Tab})).toBe(false);
  expect(trustedHostSender({id: 'own', url: 'chrome-extension://own/reader.html'})).toBe(true);
});
it('does not declare a prepared request interrupted while its execution page is still starting', async () => {
  let ready = false, finishOpening!: () => void;
  const create = vi.fn(async () => {await new Promise(resolve => {finishOpening = () => resolve(undefined);}); ready = true; return {id: 88};});
  const sendMessage = vi.fn(async (message: {action: string; id?: string; request?: ImageTransferRequest}) => {
    if (message.action === 'ping') return {ready};
    void executeImageTransfer(message.id!, message.request!); return {accepted: true};
  });
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (path: string) => 'chrome-extension://own' + path, sendMessage}, tabs: {create}});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const id = crypto.randomUUID(), starting = startImageTransfer(id, id, new Blob(['original']), recipe());
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect((await interruptAbandonedTransfer(id))?.state).toBe('prepared');
  finishOpening(); await starting;
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['host', 'reader'] as const)('keeps ownership until the %s execution lock is registered in another context', async context => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const id = crypto.randomUUID(), locks = transferLocks(), request = locks.request;
  let acquisitionCount = 0, registerExecution!: () => void, finishedStarting = false;
  locks.request = (name, options, supplied) => {
    // The first transfer lock creates the receipt in the worker. The next request comes from
    // the executing page, whose browser lock-service registration can lag behind its message.
    if (name === transferLock(id) && !supplied && ++acquisitionCount === 2)
      return new Promise(resolve => {registerExecution = () => resolve(request(name, options, supplied));});
    return request(name, options, supplied);
  };
  let listener!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
  const acknowledgements: unknown[] = [];
  vi.stubGlobal('document', context === 'reader' ? {} : undefined);
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (value: string) => 'chrome-extension://own' + value,
    onMessage: {addListener: (value: typeof listener) => {listener = value;}},
    sendMessage: (message: {action: string}) => new Promise(resolve => listener(message,
      {id: 'own', url: 'chrome-extension://own/background.js'}, reply => {
        if (message.action === 'start') acknowledgements.push(reply);
        resolve(reply);
      }))}, tabs: {getCurrent: async () => ({id: 7}), remove: vi.fn()}});
  if (context === 'host') registerImageTransferHost(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const starting = startImageTransfer(id, id, new Blob(['original']), recipe()).then(() => {finishedStarting = true;});
  await vi.waitFor(() => expect(registerExecution).toBeTypeOf('function'));
  const observed = await interruptAbandonedTransfer(id), acknowledgedEarly = acknowledgements.length,
    releasedEarly = finishedStarting;
  registerExecution(); await starting;
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await readTransferReceipt(id))?.state));
  expect(observed?.state).toBe('prepared');
  expect(acknowledgedEarly).toBe(0); expect(releasedEarly).toBe(false);
  expect((await readTransferReceipt(id))?.state).toBe('succeeded');
  expect(fetch).toHaveBeenCalledTimes(1);
  if (context === 'host') expect(acknowledgements).toEqual([{accepted: true}]);
});
it('acknowledges ownership before waiting for a busy scope, even when notification throws', async () => {
  const id = crypto.randomUUID(), scope = crypto.randomUUID();
  let releaseSlot!: () => void;
  const busy = navigator.locks.request('nc-channel-execution:' + scope, () => new Promise<void>(resolve => {releaseSlot = resolve;}));
  await vi.waitFor(() => expect(releaseSlot).toBeTypeOf('function'));
  await saveTransferReceipt({id, scope, state: 'prepared', input: new Blob(['original']), updatedAt: Date.now()});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const accepted = vi.fn(() => {throw Error('sender disappeared');});
  const execution = executeImageTransfer(id, recipe(), accepted);
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(fetch).not.toHaveBeenCalled();
  expect((await interruptAbandonedTransfer(id))?.state).toBe('prepared');
  releaseSlot(); await busy; await execution;
  expect((await readTransferReceipt(id))?.state).toBe('succeeded'); expect(fetch).toHaveBeenCalledOnce();
});
it('continues host execution when the accepted message cannot reach the worker', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  let listener!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (value: string) => 'chrome-extension://own' + value,
    onMessage: {addListener: (value: typeof listener) => {listener = value;}}}, tabs: {getCurrent: async () => ({id: 7}), remove: vi.fn()}});
  registerImageTransferHost(() => {});
  const id = crypto.randomUUID();
  await saveTransferReceipt({id, scope: id, state: 'prepared', input: new Blob(['original']), updatedAt: Date.now()});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const reply = vi.fn(() => {throw Error('message port closed');});
  listener({type: HOST_MESSAGE, action: 'start', id, request: recipe()}, {id: 'own', url: 'chrome-extension://own/background.js'}, reply);
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  expect(reply).toHaveBeenCalledExactlyOnceWith({accepted: true}); expect(fetch).toHaveBeenCalledOnce();
});
it.each(['missing receipt', 'terminal receipt', 'lock failure'])('settles a host start without hanging on %s', async failure => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  let listener!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (value: string) => 'chrome-extension://own' + value,
    onMessage: {addListener: (value: typeof listener) => {listener = value;}}}, tabs: {getCurrent: async () => ({id: 7}), remove: vi.fn()}});
  registerImageTransferHost(() => {});
  const id = crypto.randomUUID(), locks = transferLocks(), request = locks.request;
  if (failure !== 'missing receipt') await saveTransferReceipt({id, scope: id,
    state: failure === 'terminal receipt' ? 'failed' : 'prepared', input: new Blob(['original']), updatedAt: Date.now()});
  if (failure === 'lock failure') locks.request = (name, options, supplied) => name === transferLock(id)
    ? Promise.reject(Error('execution context closed')) : request(name, options, supplied);
  vi.stubGlobal('fetch', vi.fn());
  const response = await new Promise(resolve => listener({type: HOST_MESSAGE, action: 'start', id, request: recipe()},
    {id: 'own', url: 'chrome-extension://own/background.js'}, resolve));
  expect(response).toEqual({accepted: false}); expect(fetch).not.toHaveBeenCalled();
});
it('refreshes the idle-close deadline on a trusted readiness ping before the next request arrives', async () => {
  vi.useFakeTimers();
  let listener!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
  const remove = vi.fn(async () => {});
  vi.stubGlobal('chrome', {runtime: {id: 'own', getURL: (value: string) => 'chrome-extension://own' + value,
    onMessage: {addListener: (value: typeof listener) => {listener = value;}}}, tabs: {getCurrent: async () => ({id: 3}), remove}});
  registerImageTransferHost(() => {});
  await vi.advanceTimersByTimeAsync(9900);
  listener({type: HOST_MESSAGE, action: 'ping'}, {id: 'own', url: 'chrome-extension://own/reader.html'}, () => {});
  await vi.advanceTimersByTimeAsync(9900); expect(remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100); expect(remove).toHaveBeenCalledWith(3);
});
it.each([
  {context: 'Chrome service worker', document: false, tab: undefined, hosted: true},
  {context: 'Firefox background event page', document: true, tab: undefined, hosted: true},
  {context: 'extension reader document', document: true, tab: {id: 21}, hosted: false},
])('selects the correct long-request owner for $context', async fixture => {
  vi.stubGlobal('document', fixture.document ? {} : undefined);
  const sendMessage = vi.fn(async (message: {action: string; id?: string; request?: ImageTransferRequest}) => {
    if (message.action === 'ping') return {ready: true};
    void executeImageTransfer(message.id!, message.request!); return {accepted: true};
  });
  const getCurrent = vi.fn(async () => fixture.tab);
  vi.stubGlobal('chrome', {runtime: {id: 'own', sendMessage}, tabs: {getCurrent}});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], {type: 'image/png'}))));
  const id = crypto.randomUUID(); await startImageTransfer(id, id, new Blob(['original']), recipe());
  await vi.waitFor(async () => expect((await readTransferReceipt(id))?.state).toBe('succeeded'));
  expect(sendMessage.mock.calls.filter(([message]) => message.action === 'start')).toHaveLength(fixture.hosted ? 1 : 0);
  expect(getCurrent).toHaveBeenCalledTimes(fixture.document ? 1 : 0);
  expect(fetch).toHaveBeenCalledTimes(1);
});
