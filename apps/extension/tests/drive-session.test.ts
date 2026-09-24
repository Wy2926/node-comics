import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PendingDriveBridge} from '../src/comics/sources/google-drive/bridge-protocol';
const api = vi.hoisted(() => ({account: vi.fn(), metadata: vi.fn()}));
vi.mock('../src/comics/sources/google-drive/metadata', async importOriginal => ({
  ...await importOriginal<typeof import('../src/comics/sources/google-drive/metadata')>(),
  fetchDriveAccount: api.account, fetchDriveMetadata: api.metadata,
}));
import {registerDriveBackground} from '../src/comics/sources/google-drive/background';

type Reply = Record<string, any>;
type Listener = (message: Reply, sender: chrome.runtime.MessageSender, respond: (value: Reply) => void) => unknown;
const account = {id: 'account-1', displayName: 'Alice'};
const extensionSender = {id: 'extension', url: 'chrome-extension://extension/reader.html'};
let session: Record<string, any>, local: Record<string, any>, tabs: Map<number, {id: number; url: string}>, listener: Listener, now: number;
let onUpdated: (id: number, change: {url?: string; status?: string}, tab: {id: number; url: string}) => void;
let onRemoved: (id: number) => void;
const tokenKey = (id = account.id) => 'nc-drive-token:' + id;
const seedToken = (patch = {}) => session[tokenKey()] = {accessToken: 'private-valid-token', expiresAt: now + 3_600_000, account, generation: 'stable-generation', ...patch};
function send(message: Reply, sender: chrome.runtime.MessageSender = extensionSender): Promise<Reply> {
  return new Promise(resolve => { expect(listener(message, sender, resolve)).toBe(true); });
}
async function connect(expectedAccountId?: string) {
  const operation = await send({type: 'NC_DRIVE_CONNECT', expectedAccountId});
  expect(operation.ok).toBe(true);
  const pending = session['nc-drive-pending:' + operation.tabId] as PendingDriveBridge;
  const sender = {id: 'extension', frameId: 0, tab: {id: pending.tabId} as chrome.tabs.Tab, url: pending.url, documentId: 'document-' + pending.tabId};
  return {operation, pending, sender};
}
beforeEach(() => {
  vi.clearAllMocks(); now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('VITE_DRIVE_CONNECT_URL', 'https://trusted.example/drive-connect/index.html');
  session = {}; local = {}; tabs = new Map(); let tabId = 0;
  api.account.mockResolvedValue(account);
  api.metadata.mockImplementation(async reference => ({...reference, name: 'comic.cbz', mimeType: 'application/zip', size: 100, version: '1', format: 'cbz'}));
  vi.stubGlobal('chrome', {
    runtime: {id: 'extension', getURL: (path: string) => 'chrome-extension://extension/' + path,
      onMessage: {addListener: (value: Listener) => { listener = value; }}, sendMessage: vi.fn(async () => undefined)},
    storage: {local: {
      get: vi.fn(async (key: string | null) => structuredClone(key===null?local:{[key]: local[key]})),
      set: vi.fn(async (values: Reply) => { Object.assign(local, structuredClone(values)); }),
      remove: vi.fn(async (key: string) => { delete local[key]; }),
    }, session: {
      setAccessLevel: vi.fn(async () => undefined),
      get: vi.fn(async (key: string | null) => structuredClone(key === null ? session : {[key]: session[key]})),
      set: vi.fn(async (values: Reply) => { Object.assign(session, structuredClone(values)); }),
      remove: vi.fn(async (key: string) => { delete session[key]; }),
    }},
    windows: {
      create: vi.fn(async ({url}: {url: string}) => { const tab = {id: ++tabId, url}; tabs.set(tab.id, tab); return {id: tab.id, tabs: [tab]}; }),
      remove: vi.fn(async (id: number) => { tabs.delete(id); }),
    },
    tabs: {
      update: vi.fn(async (id: number, patch: {url: string}) => Object.assign(tabs.get(id)!, patch)),
      remove: vi.fn(async (id: number) => { tabs.delete(id); onRemoved(id); }),
      get: vi.fn(async (id: number) => tabs.get(id)),
      onRemoved: {addListener: (value: typeof onRemoved) => { onRemoved = value; }}, onUpdated: {addListener: (value: typeof onUpdated) => { onUpdated = value; }},
    }, scripting: {executeScript: vi.fn(async () => [])},
  });
  registerDriveBackground();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function start(expectedAccountId?: string, switchAccount = false) {
  const flow = await connect(expectedAccountId);
  await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender);
  const result = await send({type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test-client.apps.googleusercontent.com', switchAccount}, flow.sender);
  expect(result.ok).toBe(true);
  return {...flow, result};
}

describe('top-level Google OAuth bridge', () => {
  it('constructs a bounded public-client request and accepts a new callback document only once', async () => {
    const flow = await start(), url = new URL(flow.result.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({response_type: 'token', scope: 'https://www.googleapis.com/auth/drive.file',
      prompt: 'consent', trigger_onepick: 'true', include_granted_scopes: 'false', redirect_uri: 'https://trusted.example/drive-connect/index.html'});
    const tab = tabs.get(flow.pending.tabId)!; tab.url = url.href;
    onUpdated(tab.id, {url: url.href, status: 'loading'}, tab);
    await vi.waitFor(() => expect(session['nc-drive-pending:' + tab.id]?.oauth.phase).toBe('away'));
    expect((await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender)).ok).toBe(false);
    tab.url = flow.pending.url;
    onUpdated(tab.id, {status: 'complete'}, tab);
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalled());
    const sender = {...flow.sender, documentId: 'new-callback-document'};
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender)).toMatchObject({ok: true});
    const message = {type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: flow.pending.nonce, oauthState: flow.result.state,
      accessToken: 'authorized-web-token', expiresIn: 3600, files: [{fileId: 'file-1'}]}};
    expect(await send(message, sender)).toEqual({ok: true});
    expect((await send(message, sender)).ok).toBe(false);
    expect(api.account).toHaveBeenCalledTimes(1); expect(api.metadata).toHaveBeenCalledTimes(1);
  });
  it('rejects uninitialized callers and stale document / wrong nonce / arbitrary client URL', async () => {
    const flow = await connect();
    const message = {type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test.apps.googleusercontent.com'};
    expect((await send(message, flow.sender)).ok).toBe(false);
    await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender);
    for (const [request, sender] of [[{...message, nonce: 'wrong'}, flow.sender], [{...message, clientId: 'https://evil.example'}, flow.sender],
      [message, {...flow.sender, documentId: 'stale'}]] as const) expect((await send(request, sender)).ok).toBe(false);
  });
  it('permits hidden Google tab URLs without requesting access to Google pages', async () => {
    const flow = await start();
    onUpdated(flow.pending.tabId, {status: 'loading'}, {id: flow.pending.tabId, url: undefined as unknown as string});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session['nc-drive-pending:' + flow.pending.tabId]?.oauth.phase).toBe('away');
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it.each(['https://evil.example/', 'https://accounts.google.com.evil.example/'])('cancels navigation to %s', async url => {
    const flow = await start(), tab = tabs.get(flow.pending.tabId)!; tab.url = url;
    onUpdated(tab.id, {url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-pending:' + tab.id]).toBeUndefined());
    expect(api.account).not.toHaveBeenCalled(); expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('rejects a wrong OAuth state before calling Drive', async () => {
    const flow = await start(), tab = tabs.get(flow.pending.tabId)!;
    onUpdated(tab.id, {status: 'complete'}, tab);
    await vi.waitFor(() => expect(session['nc-drive-pending:' + tab.id].oauth.phase).toBe('returned'));
    const sender = {...flow.sender, documentId: 'returned-document'};
    await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const result = await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: flow.pending.nonce, oauthState: 'wrong', accessToken: 'authorized-web-token', expiresIn: 3600, files: []}}, sender);
    expect(result).toMatchObject({ok: false, code: 'invalid-bridge'}); expect(api.account).not.toHaveBeenCalled();
  });
  it('does not resurrect a pending authorization after disconnect races with its storage write', async () => {
    const flow = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;}); const ready = new Promise<void>(resolve => {reached = resolve;});
    vi.mocked(chrome.storage.session.set).mockImplementationOnce(async values => { reached(); await gate; Object.assign(session, structuredClone(values)); });
    const starting = send({type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test.apps.googleusercontent.com'}, flow.sender);
    await ready; await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id}); release();
    expect((await starting).ok).toBe(false); expect(session['nc-drive-pending:' + flow.pending.tabId]).toBeUndefined();
  });
  it('survives a background restart and issues a fresh state after cancellation', async () => {
    const flow = await start();
    registerDriveBackground();
    const tab = tabs.get(flow.pending.tabId)!;
    onUpdated(tab.id, {status: 'complete'}, tab);
    await vi.waitFor(() => expect(session['nc-drive-pending:' + tab.id].oauth.phase).toBe('returned'));
    const sender = {...flow.sender, documentId: 'callback-after-restart'};
    expect((await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender)).ok).toBe(true);
    const next = await send({type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test.apps.googleusercontent.com'}, sender);
    expect(next.ok).toBe(true); expect(next.state).not.toBe(flow.result.state);
    expect(api.account).not.toHaveBeenCalled();
  });
});


const connectionKey = (id = account.id) => 'nc-drive-connection:' + id;
async function callback(expectedAccountId?: string) {
  const flow = await connect(expectedAccountId);
  await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender);
  const start = await send({type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test.apps.googleusercontent.com'}, flow.sender);
  expect(start.ok).toBe(true);
  onUpdated(flow.pending.tabId, {status: 'complete'}, tabs.get(flow.pending.tabId)!);
  await vi.waitFor(() => expect(session['nc-drive-pending:' + flow.pending.tabId]?.oauth.phase).toBe('returned'));
  flow.sender.documentId += '-returned';
  expect((await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender)).ok).toBe(true);
  return {...flow, payload: {nonce: flow.pending.nonce, oauthState: start.state, accessToken: 'new-authorized-token', expiresIn: 3600, files: [] as {fileId: string}[]}};
}
async function complete() {
  const flow = await callback();
  expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: flow.payload}, flow.sender)).toEqual({ok: true});
  return flow;
}

describe('remembered Google connections', () => {
  it('also auto-forwards an active session without sending its credential to the page', async () => {
    seedToken(); const active = await connect();
    const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, active.sender);
    expect(ready).toMatchObject({autoRedirect: true}); expect(ready).not.toHaveProperty('session');
    expect(JSON.stringify(ready)).not.toContain('private-valid-token');
    now += 3_600_001; const expired = await connect();
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, expired.sender)).toMatchObject({autoRedirect: false});
  });
  it('uses a verified email hint after restart without forcing account selection', async () => {
    local['nc-drive-connection:account-1'] = {account: {...account, emailAddress: 'alice@example.test'}, generation: 'verified'};
    const flow = await start(); const url = new URL(flow.result.url);
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('login_hint')).toBe('alice@example.test');
    expect(api.account).not.toHaveBeenCalled();
  });
  it('uses the expected verified account and leaves ambiguous multiple accounts to Google', async () => {
    seedToken({account: {...account, emailAddress: 'alice@example.test'}});
    local['nc-drive-connection:account-2'] = {account: {id: 'account-2', emailAddress: 'bob@example.test'}, generation: 'verified'};
    expect(new URL((await start()).result.url).searchParams.has('login_hint')).toBe(false);
    expect(new URL((await start('account-2')).result.url).searchParams.get('login_hint')).toBe('bob@example.test');
    expect(new URL((await start('unknown-account')).result.url).searchParams.has('login_hint')).toBe(false);
  });
  it('only forces an account chooser on explicit switching, without a previous-account hint', async () => {
    seedToken({account: {...account, emailAddress: 'alice@example.test'}});
    const url = new URL((await start(undefined, true)).result.url);
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.has('login_hint')).toBe(false);
  });
  it('does not treat a Drive permission ID, malformed record or unverified page field as a login hint', async () => {
    seedToken(); local['nc-drive-connection:wrong'] = {account: {...account, emailAddress: 'wrong@example.test'}, generation: 'invalid-key'};
    expect(new URL((await start()).result.url).searchParams.has('login_hint')).toBe(false);
    const flow = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, flow.sender);
    const reply = await send({type: 'NC_DRIVE_OAUTH_START', nonce: flow.pending.nonce, clientId: 'test.apps.googleusercontent.com', loginHint: 'untrusted@example.test'}, flow.sender);
    expect(new URL(reply.url).searchParams.has('login_hint')).toBe(false);
  });
  it('first connection waits; a verified connection auto-forwards across restart without exposing credentials', async () => {
    const first = await connect();
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, first.sender)).toMatchObject({ok: true, autoRedirect: false});
    await complete();
    expect(local[connectionKey()]).toEqual({account, generation: session[tokenKey()].generation});
    expect(JSON.stringify(local)).not.toMatch(/accessToken|new-authorized-token|expiresAt/);
    const again = await connect(); const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, again.sender);
    expect(ready).toMatchObject({ok: true, autoRedirect: true}); expect(ready).not.toHaveProperty('session');
    session = {}; registerDriveBackground();
    expect(await send({type: 'NC_DRIVE_ACCOUNTS'})).toEqual({ok: true, accounts: [{account, status: 'reauth-required'}]});
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: false, code: 'reconnect-required'});
    const restarted = await connect(account.id);
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, restarted.sender)).toMatchObject({ok: true, autoRedirect: true});
    const other = await connect('account-2');
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, other.sender)).toMatchObject({autoRedirect: false});
    await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    expect(local[connectionKey()]).toBeUndefined();
    const disconnected = await connect();
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, disconnected.sender)).toMatchObject({autoRedirect: false});
  });
  it('lists only sanitized explicit accounts, without network requests or authorization', async () => {
    const publicAccount = {...account, emailAddress: 'reader@example.test'};
    local[connectionKey()] = {account: {...publicAccount, accessToken: 'hidden-extra'}, generation: 'generation'};
    local.unrelated = {private: 'hidden-extra'}; seedToken({account: publicAccount});
    const result = await send({type: 'NC_DRIVE_ACCOUNTS'});
    expect(result).toEqual({ok: true, accounts: [{account: publicAccount, status: 'connected'}]});
    expect(JSON.stringify(result)).not.toMatch(/private-valid-token|generation|hidden-extra/);
    expect(api.account).not.toHaveBeenCalled(); expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(await send({type: 'NC_DRIVE_ACCOUNTS'}, {...extensionSender, url: 'https://untrusted.example'})).toMatchObject({ok: false});
  });
  it('requires an OAuth return and grants no import authority from the remembered connection alone', async () => {
    const {pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'forged-authorized-token', expiresIn: 3600, files: []}}, sender)).toMatchObject({ok: false, code: 'invalid-bridge'});
    expect(api.account).not.toHaveBeenCalled(); expect(local).toEqual({});
  });
  it('initializes only once when messages race and rejects changed senders', async () => {
    const {sender} = await connect();
    const replies = await Promise.all([send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender), send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender)]);
    expect(replies.filter(reply => reply.ok)).toHaveLength(1);
    for (const patch of [{frameId: 1}, {id: 'other-extension'}, {documentId: 'other-document'}, {url: 'https://evil.example/'}])
      expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, {...sender, ...patch})).toMatchObject({ok: false});
  });
  it('preserves absolute expiry and read generation for the same token, and consumes selection once', async () => {
    const original = structuredClone(seedToken()); const {operation, pending, sender, payload} = await callback();
    now += 120_000; payload.accessToken = original.accessToken; payload.expiresIn = 86_400; payload.files = [{fileId: 'file-1'}];
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload}, sender)).toEqual({ok: true});
    expect(chrome.tabs.remove).toHaveBeenCalledWith(pending.tabId); expect(session[tokenKey()]).toEqual(original);
    expect(await send({type: 'NC_DRIVE_STATUS', id: operation.id})).toMatchObject({ok: true, account, files: [{fileId: 'file-1'}]});
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload}, sender)).toMatchObject({ok: false});
    expect(api.account).toHaveBeenCalledOnce(); expect(api.metadata).toHaveBeenCalledOnce();
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation: original.generation})).toMatchObject({ok: true, ...original});
  });
  it('does not extend expired credentials or silently select the wrong expected account', async () => {
    const original = structuredClone(seedToken({expiresAt: now - 1})); const expired = await callback(); expired.payload.accessToken = original.accessToken;
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: expired.payload}, expired.sender)).toMatchObject({ok: false, code: 'reconnect-required'});
    const wrong = await callback('account-2');
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: wrong.payload}, wrong.sender)).toMatchObject({ok: false, code: 'account-mismatch'});
    expect(local).toEqual({}); expect(session[tokenKey()]).toEqual(original);
  });
  it('does not persist a connection after disconnect during Google verification', async () => {
    const flow = await callback(); let release!: (value: typeof account) => void;
    api.account.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: flow.payload}, flow.sender);
    await vi.waitFor(() => expect(api.account).toHaveBeenCalled());
    await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id}); release(account);
    expect(await result).toMatchObject({ok: false}); expect(local).toEqual({}); expect(session[tokenKey()]).toBeUndefined();
  });
  it.each(['local', 'session'] as const)('rolls back a late %s storage write when disconnected', async area => {
    const flow = await callback(); const set = vi.mocked(chrome.storage[area].set);
    const originalSet = set.getMockImplementation() as unknown as (values: Reply) => Promise<void>;
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;}); const paused = vi.fn();
    set.mockImplementation(async values => {
      if ((values as Reply)[area === 'local' ? connectionKey() : tokenKey()]) { paused(); await gate; }
      await originalSet(values);
    });
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: flow.payload}, flow.sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const disconnect = send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    await Promise.resolve(); release();
    expect(await result).toMatchObject({ok: false}); expect(await disconnect).toEqual({ok: true});
    expect(local[connectionKey()]).toBeUndefined(); expect(session[tokenKey()]).toBeUndefined();
    expect(await send({type: 'NC_DRIVE_STATUS', id: flow.operation.id})).toMatchObject({ok: false});
  });
  it.each(['navigation', 'close'] as const)('does not expose late success after %s during the final write', async cancellation => {
    const flow = await callback(); const set = vi.mocked(chrome.storage.session.set);
    const originalSet = set.getMockImplementation() as unknown as (values: Reply) => Promise<void>;
    let releaseWrite!: () => void, releaseReply!: () => void;
    const beforeWrite = new Promise<void>(resolve => {releaseWrite = resolve;}), beforeReply = new Promise<void>(resolve => {releaseReply = resolve;});
    const paused = vi.fn(), wrote = vi.fn();
    set.mockImplementation(async values => {
      if (!(values as Reply)[tokenKey()]) {await originalSet(values); return;}
      paused(); await beforeWrite; await originalSet(values); wrote(); await beforeReply;
    });
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: flow.payload}, flow.sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    if (cancellation === 'close') onRemoved(flow.pending.tabId);
    else {const tab = tabs.get(flow.pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);}
    await vi.waitFor(() => expect(session['nc-drive-result:' + flow.operation.id]).toMatchObject({ok: false}));
    releaseWrite(); await vi.waitFor(() => expect(wrote).toHaveBeenCalledOnce());
    expect(await send({type: 'NC_DRIVE_STATUS', id: flow.operation.id})).toEqual({ok: true, pending: true});
    releaseReply(); expect(await result).toMatchObject({ok: false});
    expect(local).toEqual({}); expect(session[tokenKey()]).toBeUndefined();
    expect(await send({type: 'NC_DRIVE_STATUS', id: flow.operation.id})).toMatchObject({ok: false});
  });
  it('blocks a reader token read that races with disconnect', async () => {
    seedToken(); const get = vi.mocked(chrome.storage.session.get);
    const originalGet = get.getMockImplementation() as unknown as (key: unknown) => Promise<Reply>;
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;}); const paused = vi.fn();
    get.mockImplementationOnce(async key => {const value = await originalGet(key); paused(); await gate; return value;});
    const result = send({type: 'NC_DRIVE_TOKEN', accountId: account.id});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id}); release();
    expect(await result).toMatchObject({ok: false, code: 'reconnect-required'}); expect(await result).not.toHaveProperty('accessToken');
  });
});
