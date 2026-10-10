import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPageCover } from '../src/sources/runtime/page-cover';
import { readCoverInPage, type PageCoverResponse } from '../src/sources/runtime/page-cover-request';
import { readSourceCover } from '../src/sources/runtime/source-image';
import { recoverSourceTabs, rememberSourceTab, registerSourceTabRecovery } from '../src/sources/runtime/source-tabs';
const url = 'https://static.comix.to/fixture.jpg';
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
let records: Record<string, unknown>, tab: {
  id: number;
  url: string;
  status: string;
  pendingUrl?: string;
};
let inject: ReturnType<typeof vi.fn>, response: PageCoverResponse;
beforeEach(() => {
  records = {};
  tab = { id: 7, url, status: 'complete' };
  response = { pageUrl: url, responseUrl: url, status: 200, type: 'image/jpg', data: btoa('image bytes'), challenge: false, retryAfter: null };
  inject = vi.fn(async (options: any) => [{ frameId: 0, documentId: 'document-1', result: options.func === readCoverInPage ? response : tab.url }]);
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name: unknown, _options: unknown, run: () => Promise<unknown>) => run()) } });
  vi.stubGlobal('chrome', {
    permissions: { contains: vi.fn(async () => true) },
    webRequest: { onBeforeRedirect: event() },
    alarms: { get: vi.fn(async () => undefined), create: vi.fn(async () => { }), clear: vi.fn(async () => true), onAlarm: event() },
    tabs: { query: vi.fn(async () => []), create: vi.fn(async () => ({ id: 7 })), get: vi.fn(async () => ({ ...tab })), remove: vi.fn(async () => { }), onUpdated: event(), onRemoved: event() },
    scripting: { executeScript: inject }, storage: { session: { get: vi.fn(async () => records), set: vi.fn(async (value: object) => Object.assign(records, value)), remove: vi.fn(async (key: string) => { delete records[key]; }) } }
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Extension HTTP must not run'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('opt-in image-document cover transport', () => {
  it.each([true, false])('uses actual browser access for a new, undeclared cover CDN (granted: %s)', async granted => {
    const coverUrl = 'https://new-cdn.test/cover.jpg';
    tab.url = coverUrl;
    response.pageUrl = coverUrl;
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => granted);
    const pending = readSourceCover({
      id: 'comix:fixture', sourceId: 'comix', url: 'https://comix.to/title/fixture-book',
      title: 'Fixture', observedAt: 1, complete: true, note: '', groups: [], entries: [], cover: { url: coverUrl },
    });
    if (granted) {
      expect(await (await pending).text()).toBe('image bytes');
      expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: coverUrl, active: false });
    } else {
      await expect(pending).rejects.toThrow('权限');
      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(inject).not.toHaveBeenCalled();
    }
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['https://new-cdn.test/*'] });
  });
  it('reads Comix artwork without loading the work/reader or fetching from the extension', async () => {
    const cover = await readSourceCover({
      id: 'comix:fixture', sourceId: 'comix', url: 'https://comix.to/title/fixture-book',
      title: 'Fixture', observedAt: 1, complete: true, note: '', groups: [], entries: [], cover: { url }
    });
    expect(await cover.text()).toBe('image bytes');
    expect(cover.type).toBe('image/jpg');
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url, active: false });
    expect(inject.mock.calls[1][0]).toMatchObject({ world: 'MAIN', target: { tabId: 7, documentIds: ['document-1'] }, args: [{ pageUrl: url }] });
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(records).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalledOnce();
  });
  it('reuses only the exact image URL without navigating or closing a user tab', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [tab as chrome.tabs.Tab]);
    expect(await (await readPageCover(url)).text()).toBe('image bytes');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [{ ...tab, url: url + '?other' } as chrome.tabs.Tab]);
    await readPageCover(url);
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
  });
  it('rejects invalid artwork URLs, denied permissions and pre-cancelled requests before creating a tab', async () => {
    for (const target of ['data:image/png;base64,YQ==', 'https://user:secret@static.comix.to/a.jpg', 'javascript:alert(1)'])
      await expect(readPageCover(target)).rejects.toThrow();
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    await expect(readPageCover(url)).rejects.toThrow('权限');
    const controller = new AbortController();
    controller.abort();
    await expect(readPageCover(url, controller.signal)).rejects.toThrow();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });
  it('rejects in-flight permission revocation', async () => {
    inject.mockImplementation(async (options: any) => {
      if (options.func === readCoverInPage)
        vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      return [{ frameId: 0, documentId: 'document-1', result: options.func === readCoverInPage ? response : url }];
    });
    await expect(readPageCover(url)).rejects.toThrow('权限');
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('checks permissions after the session lock before opening an image document', async () => {
    vi.mocked(navigator.locks.request).mockImplementationOnce(async (_name: any, _options: any, run: any) => {
      vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      return run();
    });
    await expect(readPageCover(url)).rejects.toThrow('权限');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });
  it('supports Firefox without documentIds and passes the probed document token', async () => {
    inject.mockImplementation(async (options: any) => [{ frameId: 0, result: options.func === readCoverInPage ? response : tab.url }]);
    expect(await (await readPageCover(url)).text()).toBe('image bytes');
    expect(inject.mock.calls[1][0]).toMatchObject({ target: { tabId: 7, frameIds: [0] }, args: [{ documentToken: inject.mock.calls[0][0].args[0] }] });
  });
  it('rejects changed documents and leaves user navigation untouched, including another image on the same host', async () => {
    inject.mockImplementation(async (options: any) => {
      if (options.func === readCoverInPage)
        tab.url = 'https://static.comix.to/other.jpg';
      return [{ frameId: 0, documentId: 'document-1', result: options.func === readCoverInPage ? response : url }];
    });
    await expect(readPageCover(url)).rejects.toThrow('变化');
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(records).toEqual({});
  });
  it('rejects unobserved navigation without injecting or removing the destination tab', async () => {
    tab.pendingUrl = 'https://other.test/cover.jpg';
    await expect(readPageCover(url)).rejects.toThrow('跳转');
    expect(inject).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('follows observed HTTP cover redirects and cleans up the final image tab', async () => {
    const destination = 'https://other.test/cover.jpg';
    vi.mocked(chrome.tabs.create).mockImplementation(async () => {
      const listener = vi.mocked(chrome.webRequest.onBeforeRedirect.addListener).mock.calls[0][0];
      listener({tabId: 7, url, redirectUrl: url + '?next'} as chrome.webRequest.OnBeforeRedirectDetails);
      listener({tabId: 7, url: url + '?next', redirectUrl: destination} as chrome.webRequest.OnBeforeRedirectDetails);
      tab.url = destination; response.pageUrl = destination;
      return {id: 7} as chrome.tabs.Tab;
    });
    expect(await (await readPageCover(url)).text()).toBe('image bytes');
    expect(chrome.permissions.contains).toHaveBeenCalledWith({origins: ['https://static.comix.to/*', 'https://other.test/*']});
    expect(inject.mock.calls[1][0].args[0].pageUrl).toBe(destination);
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.webRequest.onBeforeRedirect.removeListener).toHaveBeenCalledOnce();
    expect(records).toEqual({});
  });
  it('checks redirected cover permissions before injecting into the final document', async () => {
    const destination = 'https://denied.test/cover.jpg';
    vi.mocked(chrome.tabs.create).mockImplementation(async () => {
      vi.mocked(chrome.webRequest.onBeforeRedirect.addListener).mock.calls[0][0](
        {tabId: 7, url, redirectUrl: destination} as chrome.webRequest.OnBeforeRedirectDetails);
      tab.url = destination;
      return {id: 7} as chrome.tabs.Tab;
    });
    vi.mocked(chrome.permissions.contains).mockImplementation(async permission => !permission.origins?.includes('https://denied.test/*'));
    await expect(readPageCover(url)).rejects.toThrow('权限');
    expect(inject).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('rejects a redirected fetch response when the final image permission is missing', async () => {
    response.responseUrl = 'https://denied.test/cover.jpg';
    vi.mocked(chrome.permissions.contains).mockImplementation(async permission => !permission.origins?.includes('https://denied.test/*'));
    await expect(readPageCover(url)).rejects.toThrow('权限');
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('cancels stalled reads and cleans up its tab without waiting for page JavaScript', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    inject.mockImplementation(async (options: any) => {
      if (options.func === readCoverInPage) {
        started();
        return new Promise(() => { });
      }
      return [{ frameId: 0, documentId: 'document-1', result: url }];
    });
    const rejected = expect(readPageCover(url, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    expect(inject).toHaveBeenLastCalledWith(expect.objectContaining({ world: 'MAIN', target: { tabId: 7, documentIds: ['document-1'] }, args: [expect.stringContaining('nc-source-request-cancel:'), inject.mock.calls[0][0].args[0]] }));
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
    expect(records).toEqual({});
  });
  it('times out a page that never finishes loading', async () => {
    vi.useFakeTimers();
    tab.status = 'loading';
    const rejected = expect(readPageCover(url)).rejects.toThrow('完整加载');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it.each([401, 403])('reports HTTP %s once without direct HTTP fallback', async (status) => {
    response = { ...response, status, challenge: true, data: '' };
    await expect(readPageCover(url)).rejects.toMatchObject({ details: { status } });
    expect(inject).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).toHaveBeenCalledOnce();
  });
  it('preserves rate limiting metadata without retries', async () => {
    response = { ...response, status: 429, data: '', retryAfter: '7' };
    await expect(readPageCover(url)).rejects.toMatchObject({ details: { status: 429, retryAfter: 7 } });
    expect(inject).toHaveBeenCalledTimes(2);
  });
  it.each([{ type: 'text/html' }, { data: 'not base64' }, { data: '' }, { data: 'A'.repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4 + 4) },
  { pageUrl: url + '?other' }, { error: 'size' as const }])('rejects invalid image replies %j', async (changed) => {
    response = { ...response, ...changed };
    await expect(readPageCover(url)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('recovers expired exact-image tabs without touching a different image or a live lease', async () => {
    records['nc-catalog-tab:7'] = { url, exact: true, expiresAt: Date.now() - 1 };
    tab.pendingUrl = url + '?other';
    await recoverSourceTabs();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(records).toEqual({});
    delete tab.pendingUrl;
    records['nc-catalog-tab:7'] = { url, exact: true, expiresAt: Date.now() + 60000 };
    await recoverSourceTabs();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    records['nc-catalog-tab:7'] = { url, exact: true, expiresAt: Date.now() - 1 };
    await recoverSourceTabs();
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(records).toEqual({});
  });
  it('does not delay an older lease when another image tab is registered', async () => {
    const first = Date.now() + 30000;
    vi.mocked(chrome.alarms.get).mockImplementation(async () => ({ name: 'nc-source-tabs', scheduledTime: first }));
    await rememberSourceTab(7, url, first + 60000, true);
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    await rememberSourceTab(8, url, first - 1, true);
    expect(chrome.alarms.create).toHaveBeenCalledExactlyOnceWith('nc-source-tabs', { when: first - 1 });
  });
  it('recovers abandoned image tabs from a source alarm without library synchronization', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 150000;
    records['nc-catalog-tab:7'] = { url, exact: true, expiresAt: deadline };
    registerSourceTabRecovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(chrome.alarms.create).toHaveBeenCalledWith('nc-source-tabs', { when: deadline });
    const alarm = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(150000);
    alarm({ name: 'nc-source-tabs', scheduledTime: deadline });
    await vi.advanceTimersByTimeAsync(0);
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(records).toEqual({});
    expect(chrome.alarms.clear).toHaveBeenCalledWith('nc-source-tabs');
  });
});
describe('serialized cover read', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { href: url });
    vi.stubGlobal('document', { [Symbol.for('nc-source-page-document')]: 'cover-document' });
  });
  const input = () => ({ pageUrl: url, cancelEvent: 'cover-cancel', documentToken: 'cover-document' });
  it('reads original bytes in the exact image document and reuses the navigation cache', async () => {
    const bytes = Uint8Array.from({ length: 80000 }, (_, i) => i % 256);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })));
    const result = await readCoverInPage(input());
    expect(result).toMatchObject({ status: 200, type: 'image/jpeg', challenge: false });
    expect(Uint8Array.from(atob(result.data), char => char.charCodeAt(0))).toEqual(bytes);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ cache: 'force-cache', credentials: 'include', redirect: 'follow', referrerPolicy: 'no-referrer' }));
  });
  it('rejects a changed or foreign image document before reading', async () => {
    expect(await readCoverInPage({ ...input(), pageUrl: 'https://other.test/image.jpg' })).toMatchObject({ error: 'changed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a reloaded same-URL document before fetching even without documentIds', async () => {
    vi.stubGlobal('document', {});
    expect(await readCoverInPage(input())).toMatchObject({ error: 'changed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards challenge and non-image bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } })));
    expect(await readCoverInPage(input())).toMatchObject({ status: 403, challenge: true, data: '' });
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }));
    expect(await readCoverInPage(input())).toMatchObject({ error: 'type', data: '' });
  });
  it('bounds bytes before encoding them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })));
    expect(await readCoverInPage(input())).toMatchObject({ error: 'size', data: '' });
  });
  it.each(['cover-cancel', 'pagehide'])('aborts on %s and removes listeners', async (event) => {
    const remove = vi.spyOn(window, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn((_url: string, { signal }: {
      signal: AbortSignal;
    }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const pending = readCoverInPage(input());
    window.dispatchEvent(new Event(event));
    expect(await pending).toMatchObject({ error: 'aborted', data: '' });
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('aborts a stalled request after 30 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, { signal }: {
      signal: AbortSignal;
    }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const pending = readCoverInPage(input());
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ error: 'aborted', data: '' });
  });
});
