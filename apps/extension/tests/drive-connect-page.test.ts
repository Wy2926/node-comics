import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

const script = readFileSync(new URL('../../drive-connect/connect.js', import.meta.url), 'utf8');
const nonce = 'a'.repeat(72), state = 'b'.repeat(72), origin = 'https://trusted.example';
const scope = 'https://www.googleapis.com/auth/drive.file', oauthKey = 'nc-drive-oauth-pending';
const clientId = 'test-client.apps.googleusercontent.com';
type Message = Record<string, any>;
function page({hash = '#state=' + nonce, search = '', saved = undefined as Message | undefined} = {}) {
  let now = 1_800_000_000_000;
  const buttons = Object.fromEntries(['connect', 'reconnect', 'status', 'connection-info'].map(id => [id, {
    disabled: true, textContent: '', click: () => {}, addEventListener: function (_type: string, action: () => void) { this.click = () => { if (!this.disabled) action(); }; },
  }]));
  const listeners = new Map<string, ((event: Message) => void)[]>();
  const location = {origin, protocol: 'https:', pathname: '/drive-connect/index.html', hash, search, assign: vi.fn()};
  const storage = new Map(saved ? [[oauthKey, JSON.stringify(saved)]] : []);
  const sessionStorage = {getItem: (key: string) => storage.get(key), setItem: vi.fn((key, value) => storage.set(key, value)), removeItem: vi.fn(key => storage.delete(key))};
  const history = {replaceState: vi.fn((_state, _title, value) => { const url = new URL(value, origin); location.hash = url.hash; location.search = url.search; })};
  const window = {postMessage: vi.fn(), addEventListener: (type: string, fn: (event: Message) => void) => listeners.set(type, [...listeners.get(type) ?? [], fn])};
  const scripts: Message[] = [];
  runInNewContext(script, {
    NODE_COMICS_DRIVE_CONFIG: {clientId},
    window, location, history, URL, URLSearchParams, Date: {now: () => now}, sessionStorage,
    document: {getElementById: (id: string) => buttons[id], createElement: () => ({}), head: {appendChild: (element: Message) => scripts.push(element)}},
  });
  const emit = (data: Message, patch = {}) => { for (const fn of listeners.get('message') ?? []) fn({source: window, origin, data: {nonce, ...data}, ...patch}); };
  return {buttons, scripts, storage, sessionStorage, history, window, location, emit,
    ready: (autoRedirect = false) => emit({type: 'NC_DRIVE_READY', autoRedirect, oauthRedirect: true}),
    hide: () => { for (const fn of listeners.get('pagehide') ?? []) fn({}); },
  };
}
const pending = () => ({state, nonce, expiresAt: 1_800_000_600_000, onlyConnect: false});
const response = (patch = {}) => '#' + new URLSearchParams({state, access_token: 'private-returned-token', token_type: 'Bearer', expires_in: '3600', scope, picked_file_ids: 'file-1,file-2', ...patch});

describe('top-level Google file selection', () => {
  it('waits for first-time consent without loading any Google SDK', () => {
    const ui = page(); ui.ready(); expect(ui.scripts).toEqual([]); expect(ui.window.postMessage).not.toHaveBeenCalled();
    ui.buttons.connect.click(); ui.buttons.connect.click();
    expect(ui.window.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'NC_DRIVE_OAUTH_START', nonce, clientId}, origin);
  });
  it('saves only a one-use state before navigating the current window to Google', () => {
    const ui = page(); ui.ready(); ui.buttons.connect.click();
    const url = `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
    ui.emit({type: 'NC_DRIVE_OAUTH_STARTED', result: {ok: true, state, url, expiresAt: pending().expiresAt}});
    expect(JSON.parse(ui.storage.get(oauthKey)!)).toEqual(pending()); expect(ui.location.assign).toHaveBeenCalledWith(url);
    expect(JSON.stringify([...ui.storage])).not.toContain('accessToken');
  });
  it('scrubs the fragment immediately, returns selected IDs once, and loads no Google scripts', () => {
    const ui = page({hash: response(), saved: pending()});
    expect(ui.location.hash).toBe('#state=' + nonce); expect(ui.storage.size).toBe(0);
    expect(ui.history.replaceState).toHaveBeenNthCalledWith(1, null, '', '/drive-connect/index.html'); ui.ready(); ui.ready();
    expect(ui.window.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'NC_DRIVE_SELECTION', nonce, accessToken: 'private-returned-token', expiresIn: 3600, oauthState: state, files: [{fileId: 'file-1'}, {fileId: 'file-2'}]}, origin);
    expect(ui.scripts).toEqual([]); expect(ui.sessionStorage.setItem).not.toHaveBeenCalled();
  });
  it('accepts selected IDs in the query but never accepts a token there', () => {
    const params = new URLSearchParams(response().slice(1)); params.delete('picked_file_ids');
    const ui = page({hash: '#' + params, search: '?picked_file_ids=file-1', saved: pending()}); ui.ready();
    expect(ui.window.postMessage.mock.calls[0][0].files).toEqual([{fileId: 'file-1'}]); params.delete('access_token');
    const invalid = page({hash: '#' + params, search: '?picked_file_ids=file-1&access_token=private-token', saved: pending()}); invalid.ready();
    expect(invalid.window.postMessage).not.toHaveBeenCalled();
  });
  it.each([
    {state: 'wrong'}, {scope: 'openid'}, {scope: scope + ' openid'}, {expires_in: '-1'}, {expires_in: 'Infinity'}, {token_type: 'Basic'},
    {picked_file_ids: '../file'}, {picked_file_ids: ''}, {picked_file_ids: Array(101).fill('file-1').join(',')},
  ])('rejects invalid response %j without exposing credentials', patch => {
    const ui = page({hash: response(patch), saved: pending()}); ui.ready();
    expect(ui.window.postMessage).not.toHaveBeenCalled(); expect(ui.buttons.status.textContent).toContain('无效或已过期');
    expect(ui.location.hash).not.toContain('private-returned-token');
  });
  it('rejects replay, duplicate fields and callbacks after expiry', () => {
    for (const setup of [{hash: response()}, {hash: response() + '&state=' + state, saved: pending()}, {hash: response(), saved: {...pending(), expiresAt: 0}}]) {
      const ui = page(setup); ui.ready(); expect(ui.window.postMessage).not.toHaveBeenCalled();
    }
  });
  it('allows a cancelled callback to retry without importing or loading the SDK', () => {
    const ui = page({hash: '#state=' + state + '&error=access_denied', saved: pending()}); ui.ready(true);
    expect(ui.buttons.status.textContent).toContain('已取消'); expect(ui.window.postMessage).not.toHaveBeenCalled();
    ui.buttons.connect.click(); expect(ui.window.postMessage.mock.calls[0][0].type).toBe('NC_DRIVE_OAUTH_START');
  });
  it('supports explicit account reconnect without importing selected files', () => {
    const ui = page({hash: response(), saved: {...pending(), onlyConnect: true}}); ui.ready(); expect(ui.window.postMessage.mock.calls[0][0].files).toEqual([]);
  });
  it('ignores other origins, windows and a callback after pagehide', () => {
    const ui = page({hash: response(), saved: pending()});
    ui.emit({type: 'NC_DRIVE_READY'}, {origin: 'https://evil.example'}); ui.emit({type: 'NC_DRIVE_READY'}, {source: {}}); ui.hide(); ui.ready();
    expect(ui.window.postMessage).not.toHaveBeenCalled();
  });
});

describe('remembered connection navigation', () => {
  it('auto-forwards once without a button click or a cached credential', () => {
    const ui = page(); ui.ready(true); ui.ready(true); ui.buttons.connect.click();
    expect(ui.window.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'NC_DRIVE_OAUTH_START', nonce, clientId}, origin);
    expect(ui.buttons.connect.disabled).toBe(true); expect(ui.scripts).toEqual([]);
  });
  it('does not auto-forward successful callbacks or after completion', () => {
    const ui = page({hash: response(), saved: pending()}); ui.ready(true);
    expect(ui.window.postMessage.mock.calls[0][0].type).toBe('NC_DRIVE_SELECTION');
    ui.emit({type: 'NC_DRIVE_ACK', ok: true}); ui.ready(true); ui.buttons.connect.click();
    expect(ui.window.postMessage).toHaveBeenCalledTimes(1);
  });
  it('does not navigate on another window, stale page, or an unsupported bridge', () => {
    const ui = page(); ui.emit({type: 'NC_DRIVE_READY', autoRedirect: true, oauthRedirect: true}, {source: {}});
    expect(ui.window.postMessage).not.toHaveBeenCalled(); ui.hide(); ui.ready(true); expect(ui.window.postMessage).not.toHaveBeenCalled();
    const old = page(); old.emit({type: 'NC_DRIVE_READY', autoRedirect: true});
    expect(old.buttons.connect.disabled).toBe(true); expect(old.window.postMessage).not.toHaveBeenCalled();
  });
});
