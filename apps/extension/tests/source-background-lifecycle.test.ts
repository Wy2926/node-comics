import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageManifest,DocumentSnapshot } from '../src/sources/contracts/source';
vi.mock('../src/i18n/background', () => ({ registerLocaleBackground: () => async () => {} }));
vi.mock('../src/inline/background', () => ({ activateInline: vi.fn(), registerInlineBackground: vi.fn() }));

import { registerSourceBackground } from '../src/sources/runtime/background';

let listener: (message: unknown, sender: chrome.runtime.MessageSender, response: (value: unknown) => void) => unknown;
let local: Record<string, unknown>, session: Record<string, unknown>, snapshot: DocumentSnapshot & {id:string; sourceTabId:number};
const tabs = new Map<number, { id: number; url: string; status: string }>();
const storage = (records: Record<string, unknown>) => ({ get: async (key: string) => ({ [key]: records[key] }), set: async (values: Record<string, unknown>) => { Object.assign(records, values); }, remove: async (key: string) => { delete records[key]; } });
const send = (message: unknown) => new Promise<{ ok: boolean; data?: PageManifest | { url: string }; error?: string }>(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/reader.html' }, value => resolve(value as never)));
beforeEach(() => {
  local = {}; session = {}; tabs.clear();
  snapshot = { id: 'untrusted-content-id', sourceTabId: 999, navigationId: 'navigation', revision: 1, title: 'Test', url: 'https://comicpash.jp/episodes/test123', adapter: 'comicpash', direction: 'rtl', discoveryComplete: true, knownTotal:1, note: '', items: [{ id: 'page-1', url: 'https://images.example.org/1.png', width: 800, height: 1200, order: 0 }] };
  tabs.set(7, { id: 7, url: snapshot.url, status: 'complete' }); session['nc-managed:7'] = { url: snapshot.url, manifestId: 'trusted-manifest' };
  vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (path: string) => 'chrome-extension://test/' + path, onInstalled: { addListener() {} }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } }, contextMenus: { onClicked: { addListener() {} } }, scripting: { executeScript: async () => {} }, storage: { local: storage(local), session: storage(session) }, tabs: { get: async (id: number) => tabs.get(id), remove: async (id: number) => { tabs.delete(id); }, sendMessage: async (id: number, message: { type: string }) => { if (!tabs.has(id)) throw Error('Tab closed'); return message.type === 'NC_NAVIGATION' ? { url: snapshot.url, navigationId: snapshot.navigationId } : snapshot; } } });
  registerSourceBackground();
});
afterEach(() => vi.unstubAllGlobals());
describe('persisted source manifest authority', () => {
  it('registers managed discoveries under a background ID and resolves HTTP pages after their tab closes', async () => {
    const discovered = await send({ type: 'NC_POLL_SOURCE', tabId: 7 });
    expect(discovered).toMatchObject({ ok: true, data: { id: 'trusted-manifest', pageContext:{tabId:7,navigationId:'navigation'} } });
    expect(local['manifest:trusted-manifest']).toMatchObject({ items: snapshot.items });
    expect(await send({ type: 'NC_CLOSE_SOURCE', tabId: 7 })).toMatchObject({ ok: true });
    expect(await send({ type: 'NC_SOURCE_IMAGE', manifestId: 'trusted-manifest', pageId: 'page-1' })).toEqual({ ok: true, data: { url: snapshot.items[0].url,pageUrl:snapshot.url,sourceId:'comicpash',processing:undefined } });
    expect((await send({ type: 'NC_SOURCE_IMAGE', manifestId: 'trusted-manifest', pageId: 'forged-page' })).ok).toBe(false);
    expect((await send({ type: 'NC_SOURCE_IMAGE', manifestId: 'untrusted-content-id', pageId: 'page-1' })).ok).toBe(false);
  });
  it('keeps a stable managed manifest while discovery grows', async () => {
    await send({ type: 'NC_POLL_SOURCE', tabId: 7 }); snapshot.items.push({ ...snapshot.items[0], id: 'page-2', url: 'https://images.example.org/2.png', order: 1 }); snapshot.knownTotal=2;
    expect(await send({ type: 'NC_POLL_SOURCE', tabId: 7 })).toMatchObject({ ok: true, data: { id: 'trusted-manifest' } });
    expect((local['manifest:trusted-manifest'] as PageManifest).items).toHaveLength(2);
  });
  it('requires the original navigation for canvas resources and gives a rediscovery error after close', async () => {
    snapshot.items[0] = { ...snapshot.items[0], kind: 'page', url: 'page-image:canvas-1' };
    await send({ type: 'NC_POLL_SOURCE', tabId: 7 }); await send({ type: 'NC_CLOSE_SOURCE', tabId: 7 });
    expect(await send({ type: 'NC_SOURCE_IMAGE', manifestId: 'trusted-manifest', pageId: 'page-1' })).toMatchObject({ ok: false, error: expect.stringMatching(/重新发现|discover/i) });
  });
  it('rejects unsafe or duplicate resources before registering a source manifest', async () => {
    snapshot.items[0].url = 'javascript:alert(1)';
    expect((await send({ type: 'NC_POLL_SOURCE', tabId: 7 })).ok).toBe(false); expect(local['manifest:trusted-manifest']).toBeUndefined();
  });
});
