/** Size the browser-owned OAuth popup without replacing its redirect handling. */
export async function launchLoginWindow(url: string): Promise<string | undefined> {
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
