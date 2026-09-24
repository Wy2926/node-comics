import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

const script = readFileSync(new URL('../../drive-connect/connect.js', import.meta.url), 'utf8');
const nonce = 'a'.repeat(72), origin = 'https://trusted.example';
type Message = Record<string, any>;
async function page({deferSdk = false} = {}) {
  let now = 1_800_000_000_000, oauth!: {callback: (value: Message) => void};
  const buttons = Object.fromEntries(['connect', 'reconnect', 'status', 'connection-info'].map(id => [id, {
    disabled: true, textContent: '', click: () => {}, addEventListener: function (_type: string, action: () => void) { this.click = () => { if (!this.disabled) action(); }; },
  }]));
  const listeners = new Map<string, ((event: Message) => void)[]>();
  const location = {origin, protocol: 'https:', hash: '#state=' + nonce};
  const storage = {setItem: vi.fn()};
  const window = {postMessage: vi.fn(), addEventListener: (type: string, fn: (event: Message) => void) => listeners.set(type, [...listeners.get(type) ?? [], fn])};
  const pickers: {token: string; callback: (data: Message) => void; dispose: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>}[] = [];
  const requestAccessToken = vi.fn();
  const mimeFilters: string[][] = [];
  class DocsView { setMimeTypes(value:string) { if(value.includes("image/"))throw Error("Images are not selectable"); mimeFilters.push(value.split(',')); return this; } setIncludeFolders() { return this; } setSelectFolderEnabled() { return this; } }
  class PickerBuilder {
    private token = '';
    private callback!: (data: Message) => void;
    setDeveloperKey() { return this; } setAppId() { return this; } setOrigin() { return this; }
    enableFeature() { return this; } addView() { return this; }
    setOAuthToken(value: string) { this.token = value; return this; }
    setCallback(value: (data: Message) => void) { this.callback = value; return this; }
    build() { const picker = {token: this.token, callback: this.callback, dispose: vi.fn(), setVisible: vi.fn()}; pickers.push(picker); return picker; }
  }
  const initTokenClient = vi.fn((options: typeof oauth) => { oauth = options; return {requestAccessToken}; });
  const sdkScripts: {onload: () => void}[] = [];
  runInNewContext(script, {
    NODE_COMICS_DRIVE_CONFIG: {clientId: 'test-client', apiKey: 'test-key', appId: '123'},
    window, location, URLSearchParams, Date: {now: () => now}, localStorage: storage, sessionStorage: storage,
    document: {getElementById: (id: string) => buttons[id], createElement: () => ({}), head: {appendChild: (element: {onload: () => void}) => sdkScripts.push(element)}},
    gapi: {load: (_name: string, options: {callback: () => void}) => options.callback()},
    google: {accounts: {oauth2: {initTokenClient, hasGrantedAllScopes: () => true}},
      picker: {DocsView, PickerBuilder, ViewId: {DOCS: 'docs'}, Feature: {MULTISELECT_ENABLED: 'multi'}, Action: {CANCEL: 'cancel', PICKED: 'picked'}, Response: {DOCUMENTS: 'docs'}, Document: {ID: 'id'}}},
  });
  const loadSdk = async () => {
    for (const element of sdkScripts.splice(0)) element.onload();
    await vi.waitFor(() => expect(initTokenClient).toHaveBeenCalledOnce());
  };
  if (!deferSdk) await loadSdk();
  const emit = (data: Message, patch = {}) => { for (const fn of listeners.get('message') ?? []) fn({source: window, origin, data: {nonce, ...data}, ...patch}); };
  return {buttons, pickers, mimeFilters, requestAccessToken, storage, window, location, emit, loadSdk,
    authorize: (response: Message) => oauth.callback(response),
    advance: (milliseconds: number) => { now += milliseconds; },
    ready: (session?: Message, authMode = 'web') => emit({type: 'NC_DRIVE_READY', session, authMode}),
    valid: () => ({accessToken: 'private-existing-token', expiresAt: now + 3_600_000, displayName: 'Alice'}),
    hide: () => { for (const fn of listeners.get('pagehide') ?? []) fn({}); },
  };
}

describe('Drive authorization page session reuse', () => {
  it('includes MOBI and generic binary uploads in the picker while excluding images', async () => {
    const ui = await page(); ui.ready(ui.valid());
    expect(ui.mimeFilters).toHaveLength(1);
    expect(ui.mimeFilters[0]).toEqual(expect.arrayContaining(['application/zip', 'application/x-mobipocket-ebook', 'application/octet-stream']));
    expect(ui.mimeFilters[0].some(mime => mime.startsWith('image/'))).toBe(false);
  });
  it.each(['bridge-first', 'sdk-first'])('opens an existing session exactly once after both prerequisites are ready (%s)', async order => {
    const ui = await page({deferSdk: true});
    if (order === 'bridge-first') {
      ui.ready(ui.valid()); expect(ui.pickers).toHaveLength(0); await ui.loadSdk();
    } else {
      await ui.loadSdk(); expect(ui.pickers).toHaveLength(0); ui.ready(ui.valid());
    }
    expect(ui.pickers).toHaveLength(1); expect(ui.pickers[0].setVisible).toHaveBeenCalledWith(true);
    ui.ready(ui.valid()); ui.buttons.connect.click(); expect(ui.pickers).toHaveLength(1);
    expect(ui.requestAccessToken).not.toHaveBeenCalled();
  });

  it('opens Picker with the existing token and reuses it after cancelling without calling GIS', async () => {
    const ui = await page(); ui.ready(ui.valid());
    expect(ui.buttons.connect.textContent).toBe('选择 Google Drive 文件');
    expect(ui.pickers[0].token).toBe('private-existing-token'); expect(ui.requestAccessToken).not.toHaveBeenCalled();
    ui.pickers[0].callback({action: 'cancel'}); ui.buttons.connect.click();
    expect(ui.pickers).toHaveLength(2); expect(ui.requestAccessToken).not.toHaveBeenCalled();
  });

  it.each(['web', 'chrome'])('does not open Picker or GIS if the %s session expires while its SDK loads', async mode => {
    const ui = await page({deferSdk: true}); ui.ready(ui.valid(), mode); ui.advance(3_600_001); await ui.loadSdk();
    expect(ui.pickers).toHaveLength(0); expect(ui.requestAccessToken).not.toHaveBeenCalled();
    expect(ui.buttons.status.textContent).toContain(mode === 'chrome' ? '没有可用的 Chrome 连接' : '没有可复用的连接');
  });

  it.each([false, true])('requests GIS only after a click when the existing web token is missing or expired (expired=%s)', async expired => {
    const ui = await page(); const token = ui.valid(); ui.advance(3_600_001); ui.ready(expired ? token : undefined);
    expect(ui.requestAccessToken).not.toHaveBeenCalled(); expect(ui.pickers).toHaveLength(0);
    expect(ui.buttons.status.textContent).toContain('没有可复用的连接');
    ui.buttons.connect.click(); expect(ui.requestAccessToken).toHaveBeenCalledWith({prompt: 'select_account'}); expect(ui.pickers).toHaveLength(0);
    ui.authorize({access_token: 'fresh-authorized-token', expires_in: 3600});
    expect(ui.pickers[0].token).toBe('fresh-authorized-token');
  });

  it('explicit account reconnect requests new authorization even with a valid existing session', async () => {
    const ui = await page(); ui.ready(ui.valid()); ui.pickers[0].callback({action: 'cancel'}); ui.buttons.reconnect.click();
    expect(ui.requestAccessToken).toHaveBeenCalledOnce();
    ui.authorize({access_token: 'new-account-token', expires_in: 3600});
    expect(ui.pickers).toHaveLength(1);
    expect(ui.window.postMessage).toHaveBeenCalledWith({type: 'NC_DRIVE_SELECTION', nonce, accessToken: 'new-account-token', expiresIn: 3600, files: []}, origin);
  });

  it.each([false, true])('does not request web authorization when a Chrome connection is missing or expired (expired=%s)', async expired => {
    const ui = await page(); const token = ui.valid(); ui.advance(3_600_001); ui.ready(expired ? token : undefined, 'chrome');
    expect(ui.pickers).toHaveLength(0); expect(ui.requestAccessToken).not.toHaveBeenCalled();
    expect(ui.buttons.status.textContent).toContain('没有可用的 Chrome 连接');
    ui.buttons.connect.click();
    expect(ui.requestAccessToken).not.toHaveBeenCalled(); expect(ui.pickers).toHaveLength(0);
    expect(ui.buttons.status.textContent).toContain('返回插件重新打开 Google Drive');
    expect(ui.buttons['connection-info'].textContent).toContain('临时网页授权');
  });

  it('sends an expired Chrome Picker lease back to the extension without silently switching authorization models', async () => {
    const ui = await page(); ui.ready(ui.valid(), 'chrome'); ui.pickers[0].callback({action: 'cancel'});
    ui.advance(3_600_001); ui.buttons.connect.click();
    expect(ui.requestAccessToken).not.toHaveBeenCalled(); expect(ui.pickers).toHaveLength(1);
    expect(ui.buttons.status.textContent).toContain('返回插件重新打开 Google Drive');
  });

  it('allows a deliberate switch from Chrome to a temporary web account connection', async () => {
    const ui = await page(); ui.ready(ui.valid(), 'chrome'); ui.pickers[0].callback({action: 'cancel'}); ui.buttons.reconnect.click();
    expect(ui.requestAccessToken).toHaveBeenCalledOnce(); expect(ui.buttons.status.textContent).toContain('临时网页连接');
    ui.authorize({access_token: 'explicit-web-account-token', expires_in: 3600});
    expect(ui.window.postMessage).toHaveBeenCalledWith({type: 'NC_DRIVE_SELECTION', nonce, accessToken: 'explicit-web-account-token', expiresIn: 3600, files: []}, origin);
    expect(ui.buttons['connection-info'].textContent).toContain('网页连接仅在授权有效期内复用');
  });

  it('cannot deliver a selection made after a Chrome Picker lease expires', async () => {
    const ui = await page(); ui.ready(ui.valid(), 'chrome'); ui.advance(3_600_001);
    ui.pickers[0].callback({action: 'picked', docs: [{id: 'file-1'}]});
    expect(ui.window.postMessage).not.toHaveBeenCalled(); expect(ui.requestAccessToken).not.toHaveBeenCalled();
    expect(ui.buttons.status.textContent).toContain('返回插件重新打开 Google Drive');
  });

  it('delivers the remaining lifetime and bounded file references without placing credentials in URL or storage', async () => {
    const ui = await page(); ui.ready(ui.valid()); ui.buttons.connect.click(); ui.advance(120_000);
    ui.pickers[0].callback({action: 'picked', docs: [{id: 'file-1', resourceKey: 'resource-1', downloadUrl: 'https://untrusted.example'}]});
    expect(ui.window.postMessage).toHaveBeenCalledWith({type: 'NC_DRIVE_SELECTION', nonce, accessToken: 'private-existing-token', expiresIn: 3480, files: [{fileId: 'file-1', resourceKey: 'resource-1'}]}, origin);
    expect(ui.storage.setItem).not.toHaveBeenCalled(); expect(ui.location.hash).toBe('#state=' + nonce);
  });

  it('ignores cross-origin, cross-window and repeated ready credentials, and cannot restart after acknowledgement', async () => {
    const ui = await page();
    ui.emit({type: 'NC_DRIVE_READY', session: ui.valid(), nonce: 'wrong'}); expect(ui.buttons.connect.disabled).toBe(true);
    ui.emit({type: 'NC_DRIVE_READY', session: ui.valid()}, {origin: 'https://evil.example'});
    ui.emit({type: 'NC_DRIVE_READY', session: ui.valid()}, {source: {}}); expect(ui.buttons.connect.disabled).toBe(true);
    ui.ready(ui.valid()); ui.ready({...ui.valid(), accessToken: 'replacement-token'}); ui.buttons.connect.click();
    expect(ui.pickers[0].token).toBe('private-existing-token');
    ui.pickers[0].callback({action: 'picked', docs: [{id: 'file-1'}]});
    ui.emit({type: 'NC_DRIVE_ACK', ok: true}); ui.ready(ui.valid()); ui.buttons.connect.click();
    expect(ui.buttons.connect.disabled).toBe(true); expect(ui.pickers).toHaveLength(1); expect(ui.requestAccessToken).not.toHaveBeenCalled();
  });

  it('drops access to a token and closes Picker when the authorization document leaves', async () => {
    const ui = await page(); ui.ready(ui.valid()); ui.buttons.connect.click(); ui.hide(); ui.buttons.connect.click();
    expect(ui.pickers[0].dispose).toHaveBeenCalledOnce(); expect(ui.buttons.connect.disabled).toBe(true);
    ui.pickers[0].callback({action: 'picked', docs: [{id: 'file-1'}]}); expect(ui.window.postMessage).not.toHaveBeenCalled();
  });

  it('ignores authorization completion after the document leaves', async () => {
    const ui = await page(); ui.ready(); ui.buttons.connect.click(); ui.hide();
    ui.authorize({access_token: 'late-authorized-token', expires_in: 3600});
    expect(ui.pickers).toHaveLength(0); expect(ui.window.postMessage).not.toHaveBeenCalled();
  });
});
