import {msg} from '../i18n/runtime';
import {secureIdentityUrl} from './model';
import {hostPermissionPattern} from '../host-permissions';

/** Prefer browser-owned OAuth; browsers without identity use an owned tab. */
export async function launchLoginWindow(url: string): Promise<string | undefined> {
  if (typeof chrome.identity?.launchWebAuthFlow !== 'function') return launchLoginTab(url);
  const authorization = new URL(url);
  const candidates = new Set<number>();
  let active = true;
  const cleanup = () => {
    active = false;
    chrome.windows?.onCreated?.removeListener(created);
    chrome.tabs?.onUpdated?.removeListener(updated);
  };
  const resize = (tab: chrome.tabs.Tab) => {
    if (!active || !candidates.has(tab.windowId) || !tab.url) return;
    let current: URL;
    try { current = new URL(tab.url); } catch { return; }
    if (current.origin !== authorization.origin) return;
    // The provider may redirect /authorize to its sign-in page before showing
    // the window. If a state is still present, it must belong to this request.
    const state = current.searchParams.get('state');
    if (state && state !== authorization.searchParams.get('state')) return;
    cleanup();
    void chrome.windows.update(tab.windowId, {width: 600, height: 760, state: 'normal'}).catch(() => {});
  };
  const created = (window: chrome.windows.Window) => {
    if (!active || window.type !== 'popup' || window.id === undefined) return;
    candidates.add(window.id);
    // Browser-managed authorization tabs can become visible only after their
    // first navigation, so inspect creation as well as subsequent URL updates.
    void chrome.windows.get(window.id, {populate: true}).then(value => value.tabs?.forEach(resize)).catch(() => {});
  };
  const updated = (_id: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => resize(tab);
  chrome.windows?.onCreated?.addListener(created);
  chrome.tabs?.onUpdated?.addListener(updated);
  try { return await chrome.identity.launchWebAuthFlow({url, interactive: true}); }
  finally { cleanup(); }
}

async function launchLoginTab(url: string): Promise<string> {
  const authorization = new URL(url);
  const redirect = secureIdentityUrl(authorization.searchParams.get('redirect_uri')!);
  const state = authorization.searchParams.get('state');
  if (redirect.search || redirect.hash || !state ||
      !chrome.tabs?.getCurrent || !chrome.tabs.create || !chrome.tabs.update || !chrome.tabs.remove ||
      !chrome.tabs.onUpdated || !chrome.tabs.onRemoved) {
    throw Error(msg('当前浏览器不支持安全登录，请更新浏览器后重试。'));
  }
  const callerTabId = (await chrome.tabs.getCurrent())?.id;
  if (callerTabId === undefined) throw Error(msg('当前浏览器不支持安全登录，请更新浏览器后重试。'));
  // Open a blank tab first so no callback can race its tab ID and listeners.
  const tab = await chrome.tabs.create({url: 'about:blank', active: true});
  if (tab.id === undefined) throw Error(msg('未收到登录结果，请重新登录。'));
  const tabId = tab.id;
  // iOS Safari has tabs.onUpdated but no webRequest API. Firefox also observes
  // requests because its browser-owned callback does not have to serve a page.
  const requests = chrome.webRequest?.onBeforeRequest;
  const navigation = chrome.webNavigation?.onCommitted;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback?: string, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      requests?.removeListener(requested);
      navigation?.removeListener(committed);
      globalThis.removeEventListener?.('pagehide', unloaded);
      // Never close an Android window: each tab may have a separate windowId.
      void chrome.tabs.remove(tabId).catch(() => {})
        .then(() => chrome.tabs.update(callerTabId, {active: true})).catch(() => {})
        .finally(() => { if (error) reject(error); else resolve(callback!); });
    };
    const inspect = (value?: string) => {
      if (!value) return;
      let current: URL;
      try { current = new URL(value); } catch { return; }
      if (current.origin !== redirect.origin || current.pathname !== redirect.pathname) return;
      // The website clears its query immediately. Safari can deliver that tab
      // update before the committed navigation event carrying the original URL.
      if (!current.search) return;
      if (current.username || current.password || current.hash ||
          current.searchParams.getAll('state').length !== 1 || current.searchParams.get('state') !== state) {
        finish(undefined, Error(msg('登录状态无效或已过期，请重新登录。')));
      } else if (current.searchParams.has('code') || current.searchParams.has('error')) finish(value);
    };
    const updated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab) => {
      if (id === tabId) inspect(change.url ?? (change.status === 'complete' ? tab?.url : undefined));
    };
    const requested = (request: chrome.webRequest.OnBeforeRequestDetails) => {
      if (request.tabId === tabId && request.frameId === 0 && request.type === 'main_frame') inspect(request.url);
      return undefined;
    };
    const committed = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (details.tabId === tabId && details.frameId === 0) inspect(details.url);
    };
    const removed = (id: number) => {
      if (id === tabId) finish(undefined, Error(msg('登录窗口已关闭。')));
    };
    const unloaded = () => finish(undefined, Error(msg('登录窗口已关闭。')));
    const timeout = setTimeout(() => finish(undefined, Error(msg('登录状态无效或已过期，请重新登录。'))), 600000);
    try {
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      requests?.addListener(requested, {urls: [hostPermissionPattern(redirect.href)], types: ['main_frame']});
      navigation?.addListener(committed, {url: [{urlPrefix: redirect.origin + redirect.pathname}]});
      globalThis.addEventListener?.('pagehide', unloaded, {once: true});
      void chrome.tabs.update(tabId, {url}).then(value => inspect(value?.url), () => {
        finish(undefined, Error(msg('未收到登录结果，请重新登录。')));
      });
    } catch {
      finish(undefined, Error(msg('未收到登录结果，请重新登录。')));
    }
  });
}
