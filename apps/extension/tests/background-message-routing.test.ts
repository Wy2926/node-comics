import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Keep every production message listener; isolate the wrapper and optional content registration.
vi.mock('wxt/utils/define-background', () => ({defineBackground: (main: () => void) => ({main})}));
vi.mock('../src/sources/runtime/optional-content', () => ({registerOptionalSourceContent: vi.fn()}));

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
type Message = {type: string; [key: string]: unknown};
type Reply = {ok?: boolean; id?: string; tabId?: number; pending?: boolean; nonce?: string; code?: string; data?: unknown; [key: string]: unknown};
const extensionId = 'test-extension';
const extensionSender: chrome.runtime.MessageSender = {id: extensionId, url: `chrome-extension://${extensionId}/reader.html`};
const listeners: Listener[] = [];
const event = () => ({addListener: vi.fn(), removeListener: vi.fn()});
let local: Record<string, unknown>, session: Record<string, unknown>;
let tabs: Map<number, {id: number; url: string}>;
let request: ReturnType<typeof vi.fn<typeof fetch>>;

function storage(records: Record<string, unknown>) {
  return {
    get: async (keys: string | string[] | null) => keys === null ? {...records} : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])),
    set: async (values: Record<string, unknown>) => {Object.assign(records, values);},
    remove: async (keys: string | string[]) => {for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key];},
    setAccessLevel: vi.fn(async () => {}),
  };
}

/** Chrome invokes all listeners; only the first sendResponse wins. Never select one listener by hand. */
async function dispatch(message: unknown, sender = extensionSender) {
  const claimed: number[] = [], responses: {listener: number; value: unknown}[] = [];
  let resolve!: (value: Reply | undefined) => void;
  const first = new Promise<Reply | undefined>(done => {resolve = done;});
  for (const [index, listener] of listeners.entries()) {
    const keepAlive = listener(message, sender, value => {
      responses.push({listener: index, value});
      resolve(value as Reply);
    });
    if (keepAlive === true) claimed.push(index);
  }
  if (!claimed.length && !responses.length) resolve(undefined);
  const response = await first;
  // Drain delayed responders as well: a late losing response is still a routing bug.
  await new Promise(done => setTimeout(done, 0));
  return {response, claimed, responses};
}

async function owned(message: Message, sender = extensionSender) {
  const result = await dispatch(message, sender);
  expect(result.claimed, message.type + ' must have exactly one owner').toHaveLength(1);
  expect(result.responses, message.type + ' must have exactly one response').toHaveLength(1);
  return result.response!;
}

beforeEach(async () => {
  // Each case starts a new worker. Reusing one module graph would register
  // permanent background/auth subscriptions repeatedly in the same process.
  vi.resetModules();
  listeners.length = 0;
  local = {'nc-reader-settings': {uiLanguage: 'en', autoTranslateTabs: false}};
  session = {}; tabs = new Map();
  vi.stubEnv('VITE_DRIVE_CONNECT_URL', 'https://drive.example.test/drive-connect/index.html');
  request = vi.fn<typeof fetch>().mockImplementation(async input => {
    // Synthetic Google replies only; no user credentials or network requests.
    await new Promise(done => setTimeout(done, 0));
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/drive/v3/about?'))
      return Response.json({user: {permissionId: 'account-1', displayName: 'Test reader'}});
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/file-1?'))
      return Response.json({id: 'file-1', name: 'book.cbz', mimeType: 'application/zip', size: '1024', version: '1', capabilities: {canDownload: true}});
    throw Error('Unexpected test request');
  });
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('chrome', {
    runtime: {
      id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,getManifest:()=>({version:'0.6.0'}),
      onInstalled: event(), onStartup: event(), onConnect: event(),
      onMessage: {addListener: (listener: Listener) => listeners.push(listener)},
      sendMessage: async (message: unknown) => (await dispatch(message)).response,
    },
    storage: {local: storage(local), session: storage(session), onChanged: event()},
    alarms: {get:async()=>({}),create:async()=>{},clear:async()=>true,onAlarm:event()},
    contextMenus: {onClicked: event(), update: vi.fn(async () => {})},
    permissions: {onRemoved: event(), contains: vi.fn(async () => false), request: vi.fn(async () => true)},
    scripting: {executeScript: vi.fn(async () => [])},
    windows: {
      create: async ({url}:{url:string}) => {const tab={id:7,url};tabs.set(tab.id,tab);return {id:1,tabs:[tab]};},
      remove: vi.fn(async()=>{}),
    },
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(), query: async () => [],
      create: async ({url}: {url: string}) => {const tab = {id: 7, url}; tabs.set(tab.id, tab); return tab;},
      get: async (id: number) => {const tab = tabs.get(id); if (!tab) throw Error('Tab closed'); return tab;},
      remove: vi.fn(async (id: number) => {tabs.delete(id);}),
      update: async (id: number, change: {url: string}) => {const tab = {id, ...change}; tabs.set(id, tab); return tab;},
      sendMessage: vi.fn(async () => undefined),
    },
  });
  const {default:background}=await import('../entrypoints/background');
  background.main();
  expect(listeners).toHaveLength(7); // Locale, inline theme, inline reader, website sources, Drive, catalog sync, analytics.
});

afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

function inlinePort(sender: chrome.runtime.MessageSender) {
  const port = {name:'NC_INLINE_RESULT',sender,onMessage:event(),onDisconnect:event(),postMessage:vi.fn(),disconnect:vi.fn()};
  port.disconnect.mockImplementation(() => {for(const [listener] of port.onDisconnect.addListener.mock.calls)listener();});
  for(const [listener] of vi.mocked(chrome.runtime.onConnect.addListener).mock.calls)listener(port as unknown as chrome.runtime.Port);
  return port;
}

describe('inline image port authorization', () => {
  const sender: chrome.runtime.MessageSender = {id:extensionId,url:'https://source.test/book',tab:{id:42} as chrome.tabs.Tab,frameId:0,documentId:'document'};
  it.each([{id:'another-extension'},{frameId:1},{tab:undefined}])('rejects an untrusted port sender: %j', async change => {
    const port=inlinePort({...sender,...change});
    expect(port.disconnect).toHaveBeenCalledOnce();expect(port.onMessage.addListener).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  });
  it.each(['document','navigation','origin','generation','window','result'])('rejects a stale or invalid %s before reading any image', async kind => {
    tabs.set(42,{id:42,url:sender.url!});session['nc-inline:42']={url:sender.url,navigationId:'navigation',documentId:'document'};
    const port=inlinePort({...sender,...(kind==='document'?{documentId:'old'}:kind==='origin'?{url:'https://other.test/book'}:{})});
    const image={id:'page-1',url:'https://source.test/page.jpg',width:800,height:1200};
    const message={type:'NC_INLINE_IMAGE',navigationId:kind==='navigation'?'old':'navigation',generation:kind==='generation'?-1:1,
      images:kind==='window'?[image,image]:[image],resultKey:kind==='result'?undefined:'current-result'};
    for(const [listener] of port.onMessage.addListener.mock.calls)listener({type:'open',request:message});
    await vi.waitFor(()=>expect(port.disconnect).toHaveBeenCalledOnce());
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'error'}));expect(request).not.toHaveBeenCalled();
  });
  it('bounds per-tab transfers and releases the slot after disconnect', () => {
    const first=inlinePort(sender),second=inlinePort(sender),third=inlinePort(sender);
    expect(first.disconnect).not.toHaveBeenCalled();expect(second.disconnect).not.toHaveBeenCalled();expect(third.disconnect).toHaveBeenCalledOnce();
    first.disconnect();const replacement=inlinePort(sender);expect(replacement.disconnect).not.toHaveBeenCalled();
    second.disconnect();replacement.disconnect();
  });
});

describe('production background listeners share the runtime message channel', () => {
  it('uses installed host access without a prompt and starts a manual session with automatic tabs disabled', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async()=>true);
    vi.stubGlobal('navigator', {locks: {request: async (_name:string, run:()=>Promise<unknown>) => run()}});
    const tab = {id: 42, url: 'https://example.test/comic'};
    tabs.set(tab.id, tab);
    Object.assign(chrome.scripting,{executeScript:vi.fn(async()=>[{documentId:'document-42',frameId:0}])});
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_id, message) => (message as Message).type === 'NC_INLINE_IDENTITY'
      ? {url:tab.url,navigationId:'navigation-42'} : {ok:true});
    const click = vi.mocked(chrome.contextMenus.onClicked.addListener).mock.calls[0][0];
    const pending = click({menuItemId:'nc-translate-page',editable:false},tab as chrome.tabs.Tab);
    await pending;
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({origins:['https://*/*','http://*/*']});
    expect(session['nc-inline:42']).toMatchObject({url:tab.url,automatic:false,navigationId:'navigation-42'});
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42,{type:'NC_INLINE_START',automatic:false},expect.anything());
    expect(local['nc-reader-settings']).toMatchObject({autoTranslateTabs:false});
  });

  it.each(['revoked','rejected'])('handles %s host access without prompting or starting translation', async outcome => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async()=>{if(outcome==='rejected')throw Error('Permission check failed');return false;});
    const click = vi.mocked(chrome.contextMenus.onClicked.addListener).mock.calls[0][0];
    await click({menuItemId:'nc-translate-page',editable:false},{id:42} as chrome.tabs.Tab);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(session['nc-inline:42']).toBeUndefined();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(tabs.get(7)?.url).toBe(`chrome-extension://${extensionId}/reader.html#settings`);
  });

  it('keeps the whole Drive connection, selection, token and disconnect flow out of source routing', async () => {
    expect(await owned({type: 'NC_DRIVE_ACCOUNTS'})).toEqual({ok: true, accounts: []});
    const connected = await owned({type: 'NC_DRIVE_CONNECT'});
    expect(connected).toMatchObject({ok: true, id: expect.any(String), tabId: 7});
    expect(await owned({type: 'NC_DRIVE_STATUS', id: connected.id})).toEqual({ok: true, pending: true});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: false, code: 'reconnect-required'});

    const sender: chrome.runtime.MessageSender = {id: extensionId, url: tabs.get(7)!.url, tab: {id: 7} as chrome.tabs.Tab, frameId: 0, documentId: 'test-document'};
    const bridge = await owned({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(bridge).toMatchObject({ok: true, nonce: expect.any(String)});
    (session['nc-drive-pending:7'] as {oauth?: unknown}).oauth = {state: 'test-oauth-state', phase: 'returned'};
    expect(await owned({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: bridge.nonce, oauthState: 'test-oauth-state', accessToken: 'synthetic-test-token', expiresIn: 3600, files: [{fileId: 'file-1'}]}}, sender)).toEqual({ok: true});
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
    expect(await owned({type: 'NC_DRIVE_STATUS', id: connected.id})).toMatchObject({ok: true, account: {id: 'account-1'}, files: [{fileId: 'file-1', format: 'cbz'}]});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: true, accessToken: 'synthetic-test-token', account: {id: 'account-1'}});
    expect(await owned({type: 'NC_DRIVE_ACCOUNTS'})).toEqual({ok: true, accounts: [{account: {id: 'account-1', displayName: 'Test reader'}, status: 'connected'}]});
    expect(request).toHaveBeenCalledTimes(2);
    expect(await owned({type: 'NC_DRIVE_DISCONNECT', accountId: 'account-1'})).toEqual({ok: true});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: false, code: 'reconnect-required'});
    expect(Object.keys(session).some(key => key.startsWith('nc-drive-token:'))).toBe(false);
    expect(await owned({type: 'NC_DRIVE_ACCOUNTS'})).toEqual({ok: true, accounts: []});
  });

  it.each(['NC_DRIVE_CONNECT', 'NC_DRIVE_STATUS', 'NC_DRIVE_TOKEN', 'NC_DRIVE_BRIDGE_INIT', 'NC_DRIVE_BRIDGE_RESULT', 'NC_DRIVE_DISCONNECT'])('leaves invalid %s requests to Drive validation rather than replying as a source', async type => {
    // Invalid payloads still belong to Drive: sender validation and its error codes must survive.
    const response = await owned({type, expectedAccountId: '../invalid'});
    expect(response).toMatchObject({ok: false, code: 'invalid-bridge'});
  });

  it('preserves source messages while locale and theme listeners answer only their own protocol', async () => {
    local['manifest:book'] = {id: 'book', adapter:'comicpash',url: 'https://comicpash.jp/episodes/test123', items: [{id: 'page-1', url: 'https://example.test/1.png'}]};
    expect(await owned({type: 'NC_SOURCE_IMAGE', manifestId: 'book', pageId: 'page-1'})).toEqual({ok: true, data: {url: 'https://example.test/1.png',pageUrl:'https://comicpash.jp/episodes/test123',sourceId:'comicpash',processing:undefined}});
    expect(await owned({type: 'NC_UI_LOCALE'})).toMatchObject({locale: 'en', dictionary: expect.any(Object)});
    expect(await owned({type: 'NC_INLINE_THEME'}, {...extensionSender, tab: {id: 1} as chrome.tabs.Tab, frameId: 0})).toEqual({appearance: 'system', accentTheme: 'sky', textScale: 1});
  });

  it.each([undefined, null, {}, {type: 'NC_UNKNOWN'}, {type: 'NC_DRIVE_DISCONNECTED'}, {type: 'NC_IMPORT_CURRENT'}])('does not claim messages without a background owner: %j', async message => {
    const result = await dispatch(message);
    expect(result.claimed).toEqual([]); expect(result.responses).toEqual([]); expect(result.response).toBeUndefined();
  });

  it.each(['NC_SOURCE_IMAGE','NC_CHECK_DUE_CATALOGS'])('keeps extension-only %s operations inaccessible to a website tab', async type => {
    const result = await dispatch({type, manifestId: 'book', pageId: 'page-1'}, {id: extensionId, url: 'https://example.test/book', frameId: 0, tab: {id: 1} as chrome.tabs.Tab});
    expect(result.claimed).toEqual([]); expect(result.responses).toEqual([]);
  });
});
