import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import background from '../entrypoints/background';

// Keep every production message listener; only replace the WXT entrypoint wrapper.
vi.mock('wxt/utils/define-background', () => ({defineBackground: (main: () => void) => ({main})}));

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

beforeEach(() => {
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
      id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
      onInstalled: event(), onStartup: event(),
      onMessage: {addListener: (listener: Listener) => listeners.push(listener)},
      sendMessage: async (message: unknown) => (await dispatch(message)).response,
    },
    storage: {local: storage(local), session: storage(session), onChanged: event()},
    contextMenus: {onClicked: event(), update: vi.fn(async () => {})},
    permissions: {onRemoved: event(), contains: vi.fn(async () => false)},
    scripting: {executeScript: vi.fn(async () => [])},
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(), query: async () => [],
      create: async ({url}: {url: string}) => {const tab = {id: 7, url}; tabs.set(tab.id, tab); return tab;},
      get: async (id: number) => {const tab = tabs.get(id); if (!tab) throw Error('Tab closed'); return tab;},
      update: async (id: number, change: {url: string}) => {const tab = {id, ...change}; tabs.set(id, tab); return tab;},
      sendMessage: vi.fn(async () => undefined),
    },
  });
  background.main();
  expect(listeners).toHaveLength(5); // Locale, inline theme, inline reader, website sources, Drive.
});

afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

describe('production background listeners share the runtime message channel', () => {
  it('keeps the whole Drive connection, selection, token and disconnect flow out of source routing', async () => {
    const connected = await owned({type: 'NC_DRIVE_CONNECT'});
    expect(connected).toMatchObject({ok: true, id: expect.any(String), tabId: 7});
    expect(await owned({type: 'NC_DRIVE_STATUS', id: connected.id})).toEqual({ok: true, pending: true});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: false, code: 'reconnect-required'});

    const sender: chrome.runtime.MessageSender = {id: extensionId, url: tabs.get(7)!.url, tab: {id: 7} as chrome.tabs.Tab, frameId: 0, documentId: 'test-document'};
    const bridge = await owned({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(bridge).toMatchObject({ok: true, nonce: expect.any(String)});
    expect(await owned({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: bridge.nonce, accessToken: 'synthetic-test-token', expiresIn: 3600, files: [{fileId: 'file-1'}]}}, sender)).toEqual({ok: true});
    expect(await owned({type: 'NC_DRIVE_STATUS', id: connected.id})).toMatchObject({ok: true, account: {id: 'account-1'}, files: [{fileId: 'file-1', format: 'cbz'}]});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: true, accessToken: 'synthetic-test-token', account: {id: 'account-1'}});
    expect(request).toHaveBeenCalledTimes(2);
    expect(await owned({type: 'NC_DRIVE_DISCONNECT', accountId: 'account-1'})).toEqual({ok: true});
    expect(await owned({type: 'NC_DRIVE_TOKEN', accountId: 'account-1'})).toMatchObject({ok: false, code: 'reconnect-required'});
    expect(Object.keys(session).some(key => key.startsWith('nc-drive-token:'))).toBe(false);
  });

  it.each(['NC_DRIVE_CONNECT', 'NC_DRIVE_STATUS', 'NC_DRIVE_TOKEN', 'NC_DRIVE_BRIDGE_INIT', 'NC_DRIVE_BRIDGE_RESULT', 'NC_DRIVE_DISCONNECT'])('leaves invalid %s requests to Drive validation rather than replying as a source', async type => {
    // Invalid payloads still belong to Drive: sender validation and its error codes must survive.
    const response = await owned({type, expectedAccountId: '../invalid'});
    expect(response).toMatchObject({ok: false, code: 'invalid-bridge'});
  });

  it('preserves source messages while locale and theme listeners answer only their own protocol', async () => {
    local['manifest:book'] = {id: 'book', adapter:'xkcd',url: 'https://xkcd.com/123/', items: [{id: 'page-1', url: 'https://example.test/1.png'}]};
    expect(await owned({type: 'NC_SOURCE_IMAGE', manifestId: 'book', pageId: 'page-1'})).toEqual({ok: true, data: {url: 'https://example.test/1.png'}});
    expect(await owned({type: 'NC_UI_LOCALE'})).toMatchObject({locale: 'en', dictionary: expect.any(Object)});
    expect(await owned({type: 'NC_INLINE_THEME'}, {...extensionSender, tab: {id: 1} as chrome.tabs.Tab, frameId: 0})).toEqual({appearance: 'system', accentTheme: 'sky', textScale: 1});
  });

  it.each([undefined, null, {}, {type: 'NC_UNKNOWN'}, {type: 'NC_DRIVE_DISCONNECTED'}, {type: 'NC_IMPORT_CURRENT'}])('does not claim messages without a background owner: %j', async message => {
    const result = await dispatch(message);
    expect(result.claimed).toEqual([]); expect(result.responses).toEqual([]); expect(result.response).toBeUndefined();
  });

  it('keeps extension-only source operations inaccessible to a website tab', async () => {
    const result = await dispatch({type: 'NC_SOURCE_IMAGE', manifestId: 'book', pageId: 'page-1'}, {id: extensionId, url: 'https://example.test/book', frameId: 0, tab: {id: 1} as chrome.tabs.Tab});
    expect(result.claimed).toEqual([]); expect(result.responses).toEqual([]);
  });
});
