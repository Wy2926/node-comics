import { rememberSourceTab, releaseSourceTab } from './source-tabs';
import { SourceHttpError } from './http';
import { msg } from '../../i18n/runtime';
import { safeImageUrl } from '../shared/urls';

export interface PageRequestInput {
  pageUrl: string;
  documentToken: string;
  cancelEvent: string;
}

interface PageDocument {
  url: string;
  signal: AbortSignal;
  request<I extends PageRequestInput, R>(
    func: (input: I) => Promise<R>,
    input: Omit<I, keyof PageRequestInput>,
  ): Promise<R>;
}

interface PageTarget {
  url: string;
  matches: (url: string | undefined) => boolean;
  authorize: (signal: AbortSignal, url?: string) => Promise<unknown>;
  exact?: true;
  followRedirects?: true;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, 200);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Shared bounded document lifetime for explicitly selected page requests, never an HTTP fallback. */
export async function withPageDocument<T>(
  target: PageTarget,
  signal: AbortSignal,
  read: (page: PageDocument) => Promise<T>,
): Promise<T> {
  return navigator.locks.request('nc-source-page-network', { signal }, async () => {
    signal.throwIfAborted();
    // Permissions can be revoked while another source session holds the lock.
    await target.authorize(signal);
    signal.throwIfAborted();
    const { url, matches } = target;
    const origin = new URL(url).origin;
    const existing = (await chrome.tabs.query({ url: origin + '/*' })).find(tab =>
      tab.id !== undefined && tab.status === 'complete' && matches(tab.url) &&
      (!tab.pendingUrl || matches(tab.pendingUrl)),
    );
    signal.throwIfAborted();
    // Observe native navigation redirects, not arbitrary user navigation. Register
    // before creating the tab so even a cached redirect belongs to this chain.
    let navigationTabId: number | undefined;
    const destinations = new Map<number, string>();
    const redirects = target.followRedirects && !existing ? chrome.webRequest?.onBeforeRedirect : undefined;
    const redirected = (details: chrome.webRequest.OnBeforeRedirectDetails) => {
      if (existing || navigationTabId !== undefined && details.tabId !== navigationTabId ||
          details.url !== (destinations.get(details.tabId) ?? url) ||
          safeImageUrl(details.redirectUrl, details.url) !== details.redirectUrl) return;
      destinations.set(details.tabId, details.redirectUrl);
    };
    redirects?.addListener(redirected, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });
    try {
      const tab = existing ?? await chrome.tabs.create({ url, active: false });
      if (tab.id === undefined) throw Error(msg('无法打开来源页面。'));
      navigationTabId = tab.id;
      const tabId = tab.id, owned = !existing, controller = new AbortController();
      const matchesNavigation = (value: string | undefined) => matches(value) ||
        owned && value !== undefined && value === destinations.get(tabId);
      const lifetime = AbortSignal.any([signal, controller.signal]);
      const documentToken = crypto.randomUUID();
      let pageUrl: string | undefined, documentId: string | undefined;
      const changed = () => controller.abort(Error(msg('来源页面已变化，请重新发现。')));
      const updated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
        if (id === tabId && pageUrl && (change.url !== undefined || change.status === 'loading')) changed();
      };
      const removed = (id: number) => { if (id === tabId) changed(); };
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      try {
        if (owned) await rememberSourceTab(tabId, url, Date.now() + 150_000, target.exact);
        lifetime.throwIfAborted();
        const deadline = Date.now() + 20_000;
        while (!pageUrl) {
          lifetime.throwIfAborted();
          const current = await chrome.tabs.get(tabId);
          if (current.pendingUrl && !matchesNavigation(current.pendingUrl) ||
              current.status === 'complete' && !matchesNavigation(current.url)) {
            throw Error(msg('来源页面跳转，请回源核实。'));
          }
          if (current.status === 'complete') {
            await target.authorize(lifetime, current.url);
            lifetime.throwIfAborted();
            const [probe] = await abortable(chrome.scripting.executeScript({
              target: { tabId, frameIds: [0] }, world: 'MAIN',
              func: (token: string) => {
                // One marker per document, not DOM/business data. A same-URL reload loses it.
                // Firefox versions without documentIds still check this before any fetch.
                Object.defineProperty(document, Symbol.for('nc-source-page-document'), {
                  value: token, configurable: true,
                });
                return location.href;
              },
              args: [documentToken],
            }), lifetime);
            if (probe?.frameId !== 0 || typeof probe.result !== 'string' || !matchesNavigation(probe.result)) {
              throw Error(msg('来源页面已变化，请重新发现。'));
            }
            pageUrl = probe.result;
            documentId = probe.documentId;
            if (owned && target.followRedirects && pageUrl !== url) await rememberSourceTab(tabId, pageUrl, Date.now() + 150_000, target.exact);
          } else {
            if (Date.now() >= deadline) throw Error(msg('目录未完整加载，请打开来源页处理后重试。'));
            await delay(lifetime);
          }
        }
        const injectionTarget = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
        const assertCurrent = async () => {
          lifetime.throwIfAborted();
          const current = await chrome.tabs.get(tabId);
          if (current.status !== 'complete' || current.url !== pageUrl ||
              current.pendingUrl && current.pendingUrl !== pageUrl) changed();
          lifetime.throwIfAborted();
        };
        const page: PageDocument = {
          url: pageUrl, signal: lifetime,
          async request(func, input) {
            await assertCurrent();
            const cancelEvent = 'nc-source-request-cancel:' + crypto.randomUUID();
            const cancel = () => {
              void chrome.scripting.executeScript({
                target: injectionTarget, world: 'MAIN',
                func: (event: string, token: string) => {
                  if (Reflect.get(document, Symbol.for('nc-source-page-document')) === token) {
                    window.dispatchEvent(new Event(event));
                  }
                },
                args: [cancelEvent, documentToken],
              }).catch(() => {});
            };
            lifetime.addEventListener('abort', cancel, { once: true });
            try {
              lifetime.throwIfAborted();
              const [response] = await abortable(chrome.scripting.executeScript({
                target: injectionTarget, world: 'MAIN', func,
                args: [{ ...input, pageUrl: pageUrl!, documentToken, cancelEvent } as Parameters<typeof func>[0]],
              }), lifetime);
              await assertCurrent();
              if (response?.frameId !== 0 || response.result === undefined ||
                  documentId && response.documentId !== documentId) {
                throw new SourceHttpError('invalid-response', '来源响应无效或超过限制。');
              }
              return response.result;
            } finally {
              lifetime.removeEventListener('abort', cancel);
            }
          },
        };
        const result = await read(page);
        await assertCurrent();
        return result;
      } finally {
        controller.abort();
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        if (owned) await releaseSourceTab(tabId, target.followRedirects ? pageUrl ?? destinations.get(tabId) ?? url : url, target.exact);
      }
    } finally { redirects?.removeListener(redirected); }
  });
}
