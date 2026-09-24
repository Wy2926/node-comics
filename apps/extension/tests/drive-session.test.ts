import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PendingDriveBridge} from '../src/comics/sources/google-drive/bridge-protocol';
const api = vi.hoisted(() => ({account: vi.fn(), metadata: vi.fn()}));
const native = vi.hoisted(() => ({available: vi.fn(), token: vi.fn()}));
vi.mock('../src/comics/sources/google-drive/chrome-auth', () => ({chromeDriveAvailable: native.available, requestChromeDriveToken: native.token}));
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
  native.available.mockReturnValue(false);
  native.token.mockResolvedValue({accessToken: 'chrome-managed-token', account});
  api.account.mockResolvedValue(account);
  api.metadata.mockImplementation(async reference => ({...reference, name: 'comic.cbz', mimeType: 'application/zip', size: 100, version: '1', format: 'cbz'}));
  vi.stubGlobal('chrome', {
    runtime: {id: 'extension', getURL: (path: string) => 'chrome-extension://extension/' + path,
      onMessage: {addListener: (value: Listener) => { listener = value; }}, sendMessage: vi.fn(async () => undefined)},
    identity: {removeCachedAuthToken: vi.fn(async () => undefined)},
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

describe('trusted Drive session reuse', () => {
  it('lists explicit account choices before imports without exposing credentials or invoking OAuth',async()=>{
    native.available.mockReturnValue(true);
    const publicAccount={...account,emailAddress:'reader@example.test'};
    local['nc-drive-chrome-connection:account-1']={account:{...publicAccount,accessToken:'hidden-extra'},generation:'native-generation'};
    local.unrelated={private:'hidden-extra'};
    seedToken({account:publicAccount,accessToken:'private-valid-token',provider:'chrome'});
    const result=await send({type:'NC_DRIVE_ACCOUNTS'});
    expect(result).toEqual({ok:true,accounts:[{account:publicAccount,status:'connected'}]});
    expect(JSON.stringify(result)).not.toMatch(/private-valid-token|native-generation|hidden-extra/);
    expect(api.account).not.toHaveBeenCalled();expect(native.token).not.toHaveBeenCalled();expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(await send({type:'NC_DRIVE_ACCOUNTS'},{...extensionSender,url:'https://untrusted.example'})).toMatchObject({ok:false,code:'invalid-bridge'});
    await send({type:'NC_DRIVE_DISCONNECT',accountId:account.id});
    expect(await send({type:'NC_DRIVE_ACCOUNTS'})).toEqual({ok:true,accounts:[]});
  });
  it('shows an expired web account as needing reconnect, ignoring pending results and malformed identities',async()=>{
    seedToken({expiresAt:now-1});session['nc-drive-result:ignored']={account:{id:'unselected-account',displayName:'Wrong'}};
    session['nc-drive-token:wrong']={...session[tokenKey()],account:{id:'different-account',displayName:'Wrong'}};
    expect(await send({type:'NC_DRIVE_ACCOUNTS'})).toEqual({ok:true,accounts:[{account,status:'reauth-required'}]});
    expect(native.token).not.toHaveBeenCalled();expect(api.account).not.toHaveBeenCalled();
  });
  it('hands an unexpired token to one exact bridge and preserves its expiry and read generation after selection', async () => {
    const original = structuredClone(seedToken());
    const {operation, pending, sender} = await connect();
    expect(pending.url).not.toContain(original.accessToken);
    const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(ready.session).toEqual({accessToken: original.accessToken, expiresAt: original.expiresAt, displayName: 'Alice'});
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender)).toMatchObject({ok: false, code: 'invalid-bridge'});
    now += 120_000;
    const payload = {nonce: pending.nonce, accessToken: original.accessToken, expiresIn: 86_400, files: [{fileId: 'file-1'}]};
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload}, sender)).toEqual({ok: true});
    expect(chrome.tabs.remove).toHaveBeenCalledWith(pending.tabId);
    expect(session[tokenKey()]).toEqual(original);
    expect(api.account).toHaveBeenCalledOnce(); expect(api.metadata).toHaveBeenCalledOnce();
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation: original.generation})).toMatchObject({ok: true, ...original});
    expect(await send({type: 'NC_DRIVE_STATUS', id: operation.id})).toMatchObject({ok: true, account, files: [{fileId: 'file-1'}]});
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload}, sender)).toMatchObject({ok: false, code: 'invalid-bridge'});
  });

  it('only releases a token once when initialization messages race', async () => {
    seedToken(); const {sender} = await connect();
    const replies = await Promise.all([send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender), send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender)]);
    expect(replies.filter(reply => reply.session)).toHaveLength(1);
    expect(replies.filter(reply => !reply.ok)).toHaveLength(1);
  });

  it.each([
    {frameId: 1}, {id: 'other-extension'}, {tab: {id: 999}}, {documentId: 'different-document'},
    {url: 'https://evil.example/drive-connect/index.html'},
  ])('never releases session credentials to a changed bridge sender %j', async patch => {
    seedToken(); const {pending, sender} = await connect();
    // Capture the original document identity before testing the other document.
    session['nc-drive-pending:' + pending.tabId].documentId = sender.documentId;
    const reply = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, {...sender, ...patch} as chrome.runtime.MessageSender);
    expect(reply).toMatchObject({ok: false, code: 'invalid-bridge'}); expect(reply).not.toHaveProperty('session');
  });

  it('uses only the expected account and does not send an expired or nearly expired token', async () => {
    seedToken();
    const different = await connect('account-2');
    expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, different.sender)).not.toHaveProperty('session');
    for (const remaining of [-1, 10_000]) {
      seedToken({expiresAt: now + remaining}); const next = await connect(account.id);
      expect(await send({type: 'NC_DRIVE_BRIDGE_INIT'}, next.sender)).not.toHaveProperty('session');
    }
  });

  it.each(['expired', 'replaced'] as const)('does not hand out a token that became %s while bridge initialization was pending', async change => {
    seedToken({expiresAt: now + 40_000}); const {sender} = await connect();
    const set = vi.mocked(chrome.storage.session.set), originalSet = set.getMockImplementation()!;
    set.mockImplementationOnce(async values => {
      await originalSet(values, () => {});
      if (change === 'expired') now += 60_000;
      else seedToken({accessToken: 'newer-account-token', generation: 'new-generation'});
    });
    const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(ready).toMatchObject({ok: true}); expect(ready).not.toHaveProperty('session');
  });

  it('accepts explicit new authorization and account selection instead of silently reusing the previous identity', async () => {
    const old = structuredClone(seedToken()); const {pending, sender} = await connect();
    await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const second = {id: 'account-2', displayName: 'Bob'}; api.account.mockResolvedValueOnce(second);
    const reply = await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'new-account-token', expiresIn: 3600, files: []}}, sender);
    expect(reply).toEqual({ok: true}); expect(session[tokenKey()]).toEqual(old);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(session[tokenKey(second.id)]).toMatchObject({accessToken: 'new-account-token', account: second, expiresAt: now + 3_570_000});
    expect(session[tokenKey(second.id)].generation).not.toBe(old.generation);
  });

  it('does not extend an expired stored token when an authorization response claims the same token again', async () => {
    const original = structuredClone(seedToken({expiresAt: now - 1})); const {pending, sender} = await connect();
    await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const reply = await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: original.accessToken, expiresIn: 3600, files: []}}, sender);
    expect(reply).toMatchObject({ok: false, code: 'reconnect-required'}); expect(session[tokenKey()]).toEqual(original);
  });

  it('rejects old handed-out credentials after another authorization replaces that account generation', async () => {
    seedToken(); const {pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const current = structuredClone(seedToken({accessToken: 'newer-account-token', generation: 'new-generation'}));
    const reply = await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'private-valid-token', expiresIn: 3600, files: []}}, sender);
    expect(reply).toMatchObject({ok: false, code: 'reconnect-required'}); expect(session[tokenKey()]).toEqual(current);
  });

  it('does not restore a token after disconnect during verification', async () => {
    seedToken(); const {pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    let finish!: (value: typeof account) => void;
    api.account.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'private-valid-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(api.account).toHaveBeenCalledOnce());
    expect(await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id})).toEqual({ok: true}); finish(account);
    expect(await result).toMatchObject({ok: false}); expect(session[tokenKey()]).toBeUndefined();
    expect(session['nc-drive-pending:' + pending.tabId]).toBeUndefined();
  });

  it.each(['init', 'result'] as const)('rejects navigation during the final token read of %s without overriding cancellation', async stage => {
    seedToken(); const {operation, pending, sender} = await connect();
    if (stage === 'result') await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const get = vi.mocked(chrome.storage.session.get), originalGet = get.getMockImplementation() as unknown as (key: unknown) => Promise<Reply>;
    let reads = 0, release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const paused = vi.fn();
    get.mockImplementation(async key => {
      const value = await originalGet(key);
      if (key === tokenKey() && ++reads === (stage === 'init' ? 1 : 2)) { paused(); await wait; }
      return value;
    });
    const result = send(stage === 'init' ? {type: 'NC_DRIVE_BRIDGE_INIT'} : {type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'private-valid-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const tab = tabs.get(pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false}));
    release(); expect(await result).toMatchObject({ok: false, code: 'invalid-bridge'});
    expect(await result).not.toHaveProperty('session'); expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false});
    expect(session['nc-drive-pending:' + pending.tabId]).toBeUndefined();
  });

  it.each(['navigation', 'close', 'disconnect'] as const)('does not restore credentials or success when %s occurs during the final storage write', async cancellation => {
    const {operation, pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const set = vi.mocked(chrome.storage.session.set), originalSet = set.getMockImplementation() as unknown as (value: Reply) => Promise<void>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    set.mockImplementation(async values => {
      if ((values as Reply)[tokenKey()]) { paused(); await wait; }
      await originalSet(values);
    });
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'new-authorized-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    if (cancellation === 'navigation') { const tab = tabs.get(pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab); }
    else if (cancellation === 'close') onRemoved(pending.tabId);
    else await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    await vi.waitFor(() => expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false}));
    release(); expect(await result).toMatchObject({ok: false});
    expect(session[tokenKey()]).toBeUndefined(); expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false});
    expect(session['nc-drive-pending:' + pending.tabId]).toBeUndefined();
  });

  it('does not hand out a token to a reader after disconnect during its session read', async () => {
    seedToken(); const get = vi.mocked(chrome.storage.session.get), originalGet = get.getMockImplementation() as unknown as (key: unknown) => Promise<Reply>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    get.mockImplementationOnce(async key => { const value = await originalGet(key); paused(); await wait; return value; });
    const result = send({type: 'NC_DRIVE_TOKEN', accountId: account.id});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce()); await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id}); release();
    expect(await result).toMatchObject({ok: false, code: 'reconnect-required'}); expect(await result).not.toHaveProperty('accessToken');
  });

  it('does not expose a cancelled success to status polling before a late storage write is rolled back', async () => {
    const {operation, pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const set = vi.mocked(chrome.storage.session.set), originalSet = set.getMockImplementation() as unknown as (value: Reply) => Promise<void>;
    let releaseWrite!: () => void, releaseReply!: () => void;
    const beforeWrite = new Promise<void>(resolve => { releaseWrite = resolve; }), beforeReply = new Promise<void>(resolve => { releaseReply = resolve; });
    const paused = vi.fn(), wrote = vi.fn();
    set.mockImplementation(async values => {
      if (!(values as Reply)[tokenKey()]) { await originalSet(values); return; }
      paused(); await beforeWrite; await originalSet(values); wrote(); await beforeReply;
    });
    const result = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'new-authorized-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const tab = tabs.get(pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false}));
    releaseWrite(); await vi.waitFor(() => expect(wrote).toHaveBeenCalledOnce());
    expect(await send({type: 'NC_DRIVE_STATUS', id: operation.id})).toEqual({ok: true, pending: true});
    releaseReply(); expect(await result).toMatchObject({ok: false});
    expect(await send({type: 'NC_DRIVE_STATUS', id: operation.id})).toMatchObject({ok: false}); expect(session[tokenKey()]).toBeUndefined();
  });
});

describe('Chrome-managed Drive authorization', () => {
  const connectionKey = 'nc-drive-chrome-connection:account-1';
  beforeEach(() => { native.available.mockReturnValue(true); });

  it('authorizes only after a connection click, saves no durable credentials and hands the Picker a short lease', async () => {
    expect(native.token).not.toHaveBeenCalled();
    const {sender} = await connect();
    expect(native.token).toHaveBeenCalledWith(true, undefined);
    expect(local[connectionKey]).toEqual({account, generation: expect.any(String)});
    expect(JSON.stringify(local)).not.toContain('chrome-managed-token');
    const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    expect(ready).toMatchObject({ok: true, authMode: 'chrome', session: {accessToken: 'chrome-managed-token', expiresAt: now + 300_000}});
  });

  it('recovers after cleared session storage and worker restart without interactive authorization', async () => {
    await connect(); const generation = local[connectionKey].generation;
    session = {}; registerDriveBackground();
    native.token.mockClear(); native.token.mockResolvedValue({accessToken: 'chrome-refreshed-token', account});
    const result = await send({type: 'NC_DRIVE_TOKEN', accountId: account.id});
    expect(result).toMatchObject({ok: true, accessToken: 'chrome-refreshed-token', generation});
    expect(native.token).toHaveBeenCalledWith(false, account.id);
  });

  it('asks Chrome for every reading credential and preserves the generation across token rotation', async () => {
    await connect(); const generation = local[connectionKey].generation;
    now += 3_600_000; native.token.mockClear();
    native.token.mockResolvedValueOnce({accessToken: 'rotated-managed-token', account});
    const first = await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation});
    expect(first).toMatchObject({ok: true, accessToken: 'rotated-managed-token', generation});
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation})).toMatchObject({ok: true, generation});
    expect(native.token).toHaveBeenCalledTimes(2);
    expect(native.token.mock.calls.every(([interactive]) => interactive === false)).toBe(true);
  });

  it('does not turn a missing or disconnected connection into silent account access', async () => {
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: false, code: 'reconnect-required'});
    expect(native.token).not.toHaveBeenCalled();
    await connect(); await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    session = {}; registerDriveBackground(); native.token.mockClear();
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: false, code: 'reconnect-required'});
    expect(native.token).not.toHaveBeenCalled(); expect(local[connectionKey]).toBeUndefined();
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith({token: 'chrome-managed-token'});
  });

  it('retains a connection when the user cancels only file selection', async () => {
    const {pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    onRemoved(pending.tabId);
    await vi.waitFor(() => expect(session['nc-drive-pending:' + pending.tabId]).toBeUndefined());
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: true, accessToken: 'chrome-managed-token'});
  });

  it('does not restore an authorization that finishes after disconnect', async () => {
    let finish!: (value: Reply) => void;
    native.token.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = send({type: 'NC_DRIVE_CONNECT'});
    await vi.waitFor(() => expect(native.token).toHaveBeenCalledOnce());
    await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    finish({accessToken: 'late-managed-token', account});
    expect(await result).toMatchObject({ok: false});
    expect(session[tokenKey()]).toBeUndefined(); expect(local[connectionKey]).toBeUndefined(); expect(tabs.size).toBe(0);
  });

  it.each(['local', 'session'] as const)('rolls back a connection if disconnect occurs during its %s write', async area => {
    const set = vi.mocked(chrome.storage[area].set), original = set.getMockImplementation() as unknown as (value: Reply) => Promise<void>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    set.mockImplementation(async values => { paused(); await wait; await original(values); });
    const result = send({type: 'NC_DRIVE_CONNECT'});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const disconnect = send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    release(); await disconnect;
    expect(await result).toMatchObject({ok: false});
    expect(session[tokenKey()]).toBeUndefined(); expect(local[connectionKey]).toBeUndefined(); expect(tabs.size).toBe(0);
  });

  it('persists Chrome ownership after Picker selection but removes it after explicit web account reconnect', async () => {
    const first = await connect(); const ready = await send({type: 'NC_DRIVE_BRIDGE_INIT'}, first.sender);
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: first.pending.nonce, accessToken: ready.session.accessToken, expiresIn: 300, files: []}}, first.sender)).toEqual({ok: true});
    expect(session[tokenKey()].provider).toBe('chrome');
    const second = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, second.sender);
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: second.pending.nonce, accessToken: 'explicit-web-token', expiresIn: 3600, files: []}}, second.sender)).toEqual({ok: true});
    expect(local[connectionKey]).toBeUndefined(); expect(session[tokenKey()].provider).toBeUndefined();
  });

  it.each(['credential', 'session-write'] as const)('does not overwrite an explicit web connection with a Chrome %s already in flight', async stage => {
    const {pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    if (stage === 'credential') native.token.mockImplementationOnce(async () => { paused(); await wait; return {accessToken: 'late-chrome-token', account}; });
    else {
      const set = vi.mocked(chrome.storage.session.set), original = set.getMockImplementation() as unknown as (value: Reply) => Promise<void>;
      set.mockImplementation(async values => {
        if ((values as Reply)[tokenKey()]?.provider === 'chrome') { paused(); await wait; }
        await original(values);
      });
    }
    const reading = send({type: 'NC_DRIVE_TOKEN', accountId: account.id});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    const selection = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'explicit-web-token', expiresIn: 3600, files: []}}, sender);
    if (stage === 'credential') expect(await selection).toEqual({ok: true});
    else await vi.waitFor(() => expect(api.account).toHaveBeenCalledOnce());
    release();
    expect(await reading).toMatchObject({ok: false});
    expect(await selection).toEqual({ok: true});
    expect(local[connectionKey]).toBeUndefined();
    expect(session[tokenKey()]).toMatchObject({accessToken: 'explicit-web-token'});
    expect(session[tokenKey()]).not.toHaveProperty('provider');
  });

  it('refuses new reads and connection clicks throughout asynchronous disconnect cleanup', async () => {
    await connect(); native.token.mockClear();
    const remove = vi.mocked(chrome.storage.local.remove), original = remove.getMockImplementation() as unknown as (key: string) => Promise<void>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    remove.mockImplementationOnce(async key => { paused(); await wait; await original(key as unknown as string); });
    const disconnect = send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    expect(local[connectionKey]).toBeDefined();
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: false, code: 'reconnect-required'});
    expect(await send({type: 'NC_DRIVE_CONNECT'})).toMatchObject({ok: false, code: 'cancelled'});
    expect(native.token).not.toHaveBeenCalled();
    release(); expect(await disconnect).toEqual({ok: true});
    expect(local[connectionKey]).toBeUndefined(); expect(session[tokenKey()]).toBeUndefined();
    expect(Object.keys(session).some(key => key.startsWith('nc-drive-pending:'))).toBe(false);
  });

  it.each(['popup-create', 'pending-write', 'tab-navigation'] as const)('cleans up a connection cancelled while its %s is pending', async stage => {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    if (stage === 'popup-create') {
      const create = vi.mocked(chrome.windows.create), original = create.getMockImplementation() as unknown as (values?: chrome.windows.CreateData) => Promise<chrome.windows.Window>;
      create.mockImplementationOnce(async values => { const popup = await original(values); paused(); await wait; return popup; });
    } else if (stage === 'pending-write') {
      const set = vi.mocked(chrome.storage.session.set), original = set.getMockImplementation() as unknown as (values: Reply) => Promise<void>;
      set.mockImplementation(async values => {
        if (Object.keys(values).some(key => key.startsWith('nc-drive-pending:'))) { paused(); await wait; }
        await original(values);
      });
    } else {
      const update = vi.mocked(chrome.tabs.update), original = update.getMockImplementation() as unknown as (id: number, values: chrome.tabs.UpdateProperties) => Promise<chrome.tabs.Tab>;
      update.mockImplementationOnce(async (id, values) => { const tab = await original(id as number, values as chrome.tabs.UpdateProperties); paused(); await wait; return tab; });
    }
    const connection = send({type: 'NC_DRIVE_CONNECT'});
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    expect(await send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id})).toEqual({ok: true});
    release(); expect(await connection).toMatchObject({ok: false, code: 'cancelled'});
    expect(tabs.size).toBe(0); expect(local[connectionKey]).toBeUndefined(); expect(session[tokenKey()]).toBeUndefined();
    expect(Object.keys(session).some(key => key.startsWith('nc-drive-pending:'))).toBe(false);
  });

  it('retains the previous Chrome connection if web selection is cancelled after deleting its connection metadata', async () => {
    const {operation, pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const previousConnection = structuredClone(local[connectionKey]), previousToken = structuredClone(session[tokenKey()]);
    const remove = vi.mocked(chrome.storage.local.remove), original = remove.getMockImplementation() as unknown as (key: string) => Promise<void>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    remove.mockImplementationOnce(async key => { await original(key as unknown as string); paused(); await wait; });
    const selection = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'cancelled-web-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce()); expect(local[connectionKey]).toBeUndefined();
    const tab = tabs.get(pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false}));
    release(); expect(await selection).toMatchObject({ok: false, code: 'invalid-bridge'});
    expect(local[connectionKey]).toEqual(previousConnection); expect(session[tokenKey()]).toEqual(previousToken);
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation: previousConnection.generation})).toMatchObject({ok: true, generation: previousConnection.generation});
    expect(session['nc-drive-pending:' + pending.tabId]).toBeUndefined();
  });

  it('does not restore Chrome connection metadata after disconnect during a cancelled web switch rollback', async () => {
    const {operation, pending, sender} = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, sender);
    const remove = vi.mocked(chrome.storage.local.remove), removeOriginal = remove.getMockImplementation() as unknown as (key: string) => Promise<void>;
    const set = vi.mocked(chrome.storage.local.set), setOriginal = set.getMockImplementation() as unknown as (values: Reply) => Promise<void>;
    let releaseRemoval!: () => void, releaseRestore!: () => void;
    const removalWait = new Promise<void>(resolve => { releaseRemoval = resolve; }), restoreWait = new Promise<void>(resolve => { releaseRestore = resolve; });
    const removed = vi.fn(), restoring = vi.fn();
    remove.mockImplementationOnce(async key => { await removeOriginal(key as unknown as string); removed(); await removalWait; });
    set.mockImplementationOnce(async values => { restoring(); await restoreWait; await setOriginal(values); });
    const selection = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: pending.nonce, accessToken: 'cancelled-web-token', expiresIn: 3600, files: []}}, sender);
    await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce());
    const tab = tabs.get(pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-result:' + operation.id]).toMatchObject({ok: false}));
    releaseRemoval(); await vi.waitFor(() => expect(restoring).toHaveBeenCalledOnce());
    const disconnect = send({type: 'NC_DRIVE_DISCONNECT', accountId: account.id});
    // If rollback is serialized, disconnect waits for it; otherwise let cleanup
    // reach its session removal before releasing the late durable write.
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseRestore(); expect(await disconnect).toEqual({ok: true});
    expect(await selection).toMatchObject({ok: false});
    expect(local[connectionKey]).toBeUndefined(); expect(session[tokenKey()]).toBeUndefined();
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id})).toMatchObject({ok: false, code: 'reconnect-required'});
  });

  it('restores a cancelled account switch even if a different account connects concurrently', async () => {
    const first = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, first.sender);
    const second = await connect(); await send({type: 'NC_DRIVE_BRIDGE_INIT'}, second.sender);
    const previous = structuredClone(local[connectionKey]), otherAccount = {id: 'account-2', displayName: 'Bob'};
    api.account.mockImplementation(async token => token === 'second-web-token' ? otherAccount : account);
    const remove = vi.mocked(chrome.storage.local.remove), original = remove.getMockImplementation() as unknown as (key: string) => Promise<void>;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), paused = vi.fn();
    remove.mockImplementationOnce(async key => { await original(key as unknown as string); paused(); await wait; });
    const cancelled = send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: first.pending.nonce, accessToken: 'cancelled-web-token', expiresIn: 3600, files: []}}, first.sender);
    await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
    expect(await send({type: 'NC_DRIVE_BRIDGE_RESULT', payload: {nonce: second.pending.nonce, accessToken: 'second-web-token', expiresIn: 3600, files: []}}, second.sender)).toEqual({ok: true});
    const tab = tabs.get(first.pending.tabId)!; tab.url = 'https://trusted.example/left'; onUpdated(tab.id, {url: tab.url}, tab);
    await vi.waitFor(() => expect(session['nc-drive-result:' + first.operation.id]).toMatchObject({ok: false}));
    release(); expect(await cancelled).toMatchObject({ok: false, code: 'invalid-bridge'});
    expect(local[connectionKey]).toEqual(previous);
    expect(session[tokenKey(otherAccount.id)]).toMatchObject({accessToken: 'second-web-token', account: otherAccount});
    expect(await send({type: 'NC_DRIVE_TOKEN', accountId: account.id, generation: previous.generation})).toMatchObject({ok: true, generation: previous.generation});
  });
});
