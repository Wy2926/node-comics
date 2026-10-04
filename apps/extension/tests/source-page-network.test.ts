import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPageNetworkContext } from '../src/sources/runtime/page-network';
import { requestInSourcePage, type PageNetworkResponse } from '../src/sources/runtime/page-request';
import { readSourceCatalog } from '../src/sources/runtime/catalog-reader';
import { readNetworkPages } from '../src/sources/runtime/network';
const url = 'https://comix.to/title/fixture-book', target = 'https://comix.to/api/v1/manga/fixture';
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
let records: Record<string, unknown>, tab: {
  id: number;
  url: string;
  status: string;
  pendingUrl?: string;
};
let inject: ReturnType<typeof vi.fn>, response: PageNetworkResponse;
beforeEach(() => {
  records = {};
  tab = { id: 7, url, status: 'complete' };
  response = { pageUrl: url, status: 200, body: 'source', challenge: false, retryAfter: null };
  inject = vi.fn(async (options: any) => [{ frameId: 0, documentId: 'document-1', result: options.func === requestInSourcePage ? response : tab.url }]);
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name: unknown, _options: unknown, run: () => Promise<unknown>) => run()) } });
  vi.stubGlobal('chrome', {
    runtime: { id: 'fixture' }, permissions: { contains: vi.fn(async () => true) },
    alarms: { get: vi.fn(async () => undefined), create: vi.fn(async () => { }), clear: vi.fn(async () => true) },
    tabs: { query: vi.fn(async () => []), create: vi.fn(async () => ({ id: 7 })), get: vi.fn(async () => ({ ...tab })), remove: vi.fn(async () => { }), onUpdated: event(), onRemoved: event() },
    scripting: { executeScript: inject }, storage: { local: { set: vi.fn() }, session: { get: vi.fn(async () => records), set: vi.fn(async (value: object) => Object.assign(records, value)), remove: vi.fn(async (key: string) => { delete records[key]; }) } }
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Extension HTTP must not run'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const read = (signal = new AbortController().signal) => withPageNetworkContext(url, signal, context => context.request(target));
describe('opt-in source-page catalog transport', () => {
  it('creates one background tab, pins the document and performs all requests there', async () => {
    expect(await withPageNetworkContext(url, new AbortController().signal, async (context) => {
      await context.request(target);
      return context.request(target + '/chapters');
    })).toBe('source');
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url, active: false });
    expect(inject.mock.calls.slice(1).every(([options]) => options.world === 'MAIN' && options.target.documentIds[0] === 'document-1')).toBe(true);
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(records).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalledOnce();
  });
  it('reuses an already open chapter of the same work without navigating or closing it', async () => {
    tab.url = url + '/20-chapter-1';
    response.pageUrl = tab.url;
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [tab as chrome.tabs.Tab]);
    expect(await read()).toBe('source');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(records).toEqual({});
  });
  it('does not borrow another work on the same host', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [{ ...tab, url: 'https://comix.to/title/other-book' } as chrome.tabs.Tab]);
    await read();
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
  });
  it('waits for navigation readiness without making requests or repeated injections', async () => {
    vi.useFakeTimers();
    tab.status = 'loading';
    const pending = read();
    await vi.advanceTimersByTimeAsync(400);
    expect(inject).not.toHaveBeenCalled();
    tab.status = 'complete';
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe('source');
  });
  it('times out an unloaded document and releases the owned tab', async () => {
    vi.useFakeTimers();
    tab.status = 'loading';
    const rejected = expect(read()).rejects.toThrow('完整加载');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(inject).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
    expect(records).toEqual({});
  });
  it('fails before opening a tab when host permission is absent or the request is cancelled', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    await expect(read()).rejects.toMatchObject({ kind: 'permission-required' });
    const controller = new AbortController();
    controller.abort();
    await expect(read(controller.signal)).rejects.toThrow();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });
  it('rechecks permission after waiting for the session lock, before creating a tab', async () => {
    vi.mocked(navigator.locks.request).mockImplementationOnce(async (_name: any, _options: any, run: any) => {
      vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      return run();
    });
    await expect(read()).rejects.toMatchObject({ kind: 'permission-required' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });
  it('supports Firefox without documentId using a request-bound document token', async () => {
    inject.mockImplementation(async (options: any) => [{ frameId: 0, result: options.func === requestInSourcePage ? response : tab.url }]);
    expect(await read()).toBe('source');
    const probe = inject.mock.calls[0][0], request = inject.mock.calls[1][0];
    expect(probe.world).toBe('MAIN');
    expect(probe.args[0]).toEqual(expect.any(String));
    expect(request).toMatchObject({ target: { tabId: 7, frameIds: [0] }, args: [{ documentToken: probe.args[0] }] });
    expect(request.target).not.toHaveProperty('documentIds');
  });
  it.each(['https://evil.test/api', 'https://comix.to.evil.test/api', 'https://user:secret@comix.to/api', 'javascript:alert(1)'])('rejects out-of-scope request %s before injection', async (foreign) => {
    await expect(withPageNetworkContext(url, new AbortController().signal, context => context.request(foreign))).rejects.toMatchObject({ kind: 'request-denied' });
    expect(inject).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('rechecks permission for every request and rejects revocation between pages', async () => {
    await expect(withPageNetworkContext(url, new AbortController().signal, async (context) => {
      await context.request(target);
      vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      return context.request(target + '/chapters');
    })).rejects.toMatchObject({ kind: 'permission-required' });
    expect(inject).toHaveBeenCalledTimes(2);
  });
  it('keeps page-context Referer bound to the document origin without an adapter host declaration', async () => {
    await expect(withPageNetworkContext(url, new AbortController().signal, context =>
      context.request(target, {referer: 'https://reader.example.test/book'}))).rejects.toMatchObject({kind: 'request-denied'});
    expect(inject).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('rejects results after navigation and leaves user navigation open', async () => {
    inject.mockImplementation(async (options: any) => {
      if (options.func === requestInSourcePage)
        tab.url = 'https://comix.to/title/other-book';
      return [{ frameId: 0, documentId: 'document-1', result: options.func === requestInSourcePage ? response : url }];
    });
    await expect(read()).rejects.toThrow('变化');
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(records).toEqual({});
  });
  it('rejects an in-flight result after permission revocation', async () => {
    inject.mockImplementation(async (options: any) => {
      if (options.func === requestInSourcePage)
        vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      return [{ frameId: 0, documentId: 'document-1', result: options.func === requestInSourcePage ? response : url }];
    });
    await expect(read()).rejects.toMatchObject({ kind: 'permission-required' });
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('rejects a same-URL reload and cleans up event listeners', async () => {
    inject.mockImplementation(async (options: any) => {
      if (options.func === requestInSourcePage)
        vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls[0][0](7, { status: 'loading' }, tab as chrome.tabs.Tab);
      return [{ frameId: 0, documentId: 'document-1', result: options.func === requestInSourcePage ? response : url }];
    });
    await expect(read()).rejects.toThrow('变化');
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
  });
  it('rejects pending navigation before issuing any request', async () => {
    tab.pendingUrl = 'https://evil.test/';
    await expect(read()).rejects.toThrow('跳转');
    expect(inject).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(records).toEqual({});
  });
  it('cancels an in-flight request in its pinned document and closes the owned tab promptly', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    inject.mockImplementation(async (options: any) => {
      if (options.func === requestInSourcePage) {
        started();
        return new Promise(() => { });
      }
      return [{ frameId: 0, documentId: 'document-1', result: url }];
    });
    const rejected = expect(read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    expect(inject).toHaveBeenLastCalledWith(expect.objectContaining({ world: 'MAIN', target: { tabId: 7, documentIds: ['document-1'] }, args: [expect.stringContaining('nc-source-request-cancel:'), inject.mock.calls[0][0].args[0]] }));
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
    expect(records).toEqual({});
  });
  it.each([401, 403])('reports HTTP %s verification without retries or switching to HTTP', async (status) => {
    response = { ...response, status, challenge: true };
    await expect(read()).rejects.toThrow('验证');
    expect(inject).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('preserves rate limiting without retrying', async () => {
    response = { ...response, status: 429, retryAfter: '7' };
    await expect(read()).rejects.toMatchObject({ kind: 'http', details: { status: 429, retryAfter: 7 } });
    expect(inject).toHaveBeenCalledTimes(2);
  });
  it('does not describe a failed network read as a document navigation', async () => {
    response.error = 'network';
    await expect(read()).rejects.toThrow('网络请求失败');
  });
  it('keeps the HTTP rejection when its body could not be read', async () => {
    response = { ...response, status: 403, error: 'network', body: '' };
    await expect(read()).rejects.toMatchObject({ kind: 'http', details: { status: 403 } });
  });
  it('preserves explicit structured error responses but never returns a challenge document', async () => {
    response.status = 403;
    expect(await withPageNetworkContext(url, new AbortController().signal, context => context.request(target, { referer: url, acceptStatuses: [403] }))).toBe('source');
    response.challenge = true;
    await expect(withPageNetworkContext(url, new AbortController().signal, context => context.request(target, { referer: url, acceptStatuses: [403] }))).rejects.toThrow('验证');
  });
  it('does not publish a response from another document', async () => {
    inject.mockResolvedValueOnce([{ frameId: 0, documentId: 'document-1', result: url }]).mockResolvedValueOnce([{ frameId: 0, documentId: 'other', result: response }]);
    await expect(read()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('rejects oversized page messages', async () => {
    response.body = 'x'.repeat(8 * 1024 * 1024 + 1);
    await expect(read()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('runs the real Comix catalog parser through the page request path without HTML or extension fetch', async () => {
    const paths: string[] = [];
    inject.mockImplementation(async (options: any) => {
      if (options.func !== requestInSourcePage)
        return [{ frameId: 0, documentId: 'document-1', result: url }];
      const path = new URL(options.args[0].url).pathname;
      paths.push(path);
      const result = path === '/api/v1/manga/fixture' ? { id: 1, hid: 'fixture', title: 'Fixture', url: '/title/fixture-book' } :
        { items: [{ id: 20, mangaId: 1, number: 1, language: 'en', isOfficial: true, url: '/title/fixture-book/20-chapter-1' }], meta: { total: 1, lastPage: 1, page: 1, hasNext: false } };
      return [{ frameId: 0, documentId: 'document-1', result: { ...response, body: JSON.stringify({ status: 'ok', result }) } }];
    });
    const catalog = await readSourceCatalog(url);
    expect(catalog).toMatchObject({ id: 'comix:fixture', title: 'Fixture', complete: true });
    expect(catalog.entries).toHaveLength(1);
    expect(paths).toEqual(['/api/v1/manga/fixture', '/api/v1/manga/fixture/chapters']);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('loads the chapter manifest in the same page transport, opening only the work landing page', async () => {
    const chapter = url + '/20-chapter-1';
    response.body = JSON.stringify({ status: 'ok', result: { id: 20, number: 1, url: chapter, pages: { items: [{ url: 'https://images.test/page.webp', width: 800, height: 1200, s: 1 }] } } });
    const manifest = await readNetworkPages(chapter);
    expect(manifest).toMatchObject({ adapter: 'comix', url: chapter, discoveryComplete: true, knownTotal: 1 });
    expect(manifest.items[0]).toMatchObject({ url: 'https://images.test/page.webp', processing: 'tiles-v1' });
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url, active: false });
    expect(inject.mock.calls[1][0].args[0].url).toContain('/api/v1/chapters/20?');
    expect(chrome.storage.session.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('rejects a denied chapter without registering an empty manifest or using HTTP fallback', async () => {
    response.status = 403;
    await expect(readNetworkPages(url + '/20-chapter-1')).rejects.toThrow('403');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('serialized source-page request function', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { href: url, origin: 'https://comix.to' });
    vi.stubGlobal('document', { [Symbol.for('nc-source-page-document')]: 'fixture-document' });
  });
  const input = () => ({ pageUrl: url, url: target, cancelEvent: 'fixture-cancel', documentToken: 'fixture-document' });
  it('uses ordinary same-origin credentials, rejects redirects and returns bounded text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data')));
    expect(await requestInSourcePage(input())).toMatchObject({ status: 200, body: 'data', challenge: false });
    expect(fetch).toHaveBeenCalledWith(target, expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  });
  it('refuses cross-origin and changed-page requests', async () => {
    expect(await requestInSourcePage({ ...input(), url: 'https://evil.test/' })).toMatchObject({ error: 'changed' });
    expect(await requestInSourcePage({ ...input(), pageUrl: url + '2' })).toMatchObject({ error: 'changed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not return a Cloudflare challenge body to the parser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('challenge document', { status: 403, headers: { 'cf-mitigated': 'challenge' } })));
    expect(await requestInSourcePage(input())).toMatchObject({ status: 403, body: '', challenge: true });
  });
  it('preserves the status of an empty HTTP rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })));
    expect(await requestInSourcePage(input())).toMatchObject({ status: 403, body: '' });
    expect(await requestInSourcePage(input())).not.toHaveProperty('error');
  });
  it('rejects the new document after a same-URL reload even before tab events arrive', async () => {
    vi.stubGlobal('document', {});
    expect(await requestInSourcePage(input())).toMatchObject({ error: 'changed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts via the request-scoped event and removes listeners', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn((_url: string, { signal }: {
      signal: AbortSignal;
    }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const pending = requestInSourcePage(input());
    window.dispatchEvent(new Event('fixture-cancel'));
    expect(await pending).toMatchObject({ error: 'aborted' });
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('stops a stalled request after 30 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, { signal }: {
      signal: AbortSignal;
    }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const pending = requestInSourcePage(input());
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ error: 'aborted' });
  });
  it('rejects an oversized response stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))));
    expect(await requestInSourcePage(input())).toMatchObject({ error: 'size', body: '' });
  });
});
