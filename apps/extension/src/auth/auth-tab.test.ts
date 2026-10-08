import {afterEach, describe, expect, it, vi} from 'vitest';
import {launchLoginWindow} from './auth-window';

const redirect = 'https://extension.extensions.allizom.org/oidc';
const authorization = 'https://identity.example/authorize?' + new URLSearchParams({redirect_uri: redirect, state: 'ours'});
const callback = redirect + '?state=ours&code=fixture-code';

function fixture() {
  const event = () => {
    const listeners = new Set<(...args: any[]) => void>();
    return {addListener: vi.fn((listener: (...args: any[]) => void, _filter?: unknown) => listeners.add(listener)),
      removeListener: (listener: (...args: any[]) => void) => listeners.delete(listener),
      emit: (...args: any[]) => [...listeners].forEach(listener => listener(...args)), listeners};
  };
  const updated = event(), removed = event(), requested = event();
  const getCurrent = vi.fn(async () => ({id: 3, windowId: 103} as chrome.tabs.Tab | undefined));
  const create = vi.fn(async () => ({id: 7, windowId: 107}));
  const update = vi.fn(async (_id: number, _options: unknown) => ({} as chrome.tabs.Tab));
  const remove = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {tabs: {getCurrent, create, update, remove, onUpdated: updated, onRemoved: removed}, webRequest: {onBeforeRequest: requested}});
  const noListeners = () => expect(updated.listeners.size + removed.listeners.size + requested.listeners.size).toBe(0);
  return {updated, removed, requested, getCurrent, create, update, remove, noListeners};
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('mobile login tab', () => {
  it('binds listeners before navigating and captures a callback before its dummy page loads', async () => {
    const f = fixture();
    f.update.mockImplementation(async (id) => {
      if (id === 3) { f.noListeners(); return {} as chrome.tabs.Tab; }
      expect(f.requested.listeners.size).toBe(1);
      f.requested.emit({tabId: 7, frameId: 0, type: 'main_frame', url: callback});
      f.updated.emit(7, {url: callback});
      return {} as chrome.tabs.Tab;
    });
    expect(await launchLoginWindow(authorization)).toBe(callback);
    expect(f.getCurrent).toHaveBeenCalledOnce();
    expect(f.getCurrent.mock.invocationCallOrder[0]).toBeLessThan(f.create.mock.invocationCallOrder[0]);
    expect(f.create).toHaveBeenCalledExactlyOnceWith({url: 'about:blank', active: true});
    expect(f.update.mock.calls).toEqual([[7, {url: authorization}], [3, {active: true}]]);
    expect(f.requested.addListener.mock.calls[0][1]).toEqual({urls: ['https://extension.extensions.allizom.org/*'], types: ['main_frame']});
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7);
    f.noListeners();
  });

  it('ignores unrelated tabs, subframes, URLs and window IDs', async () => {
    const f = fixture(), result = launchLoginWindow(authorization);
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    f.updated.emit(8, {url: callback}, {windowId: 107});
    f.requested.emit({tabId: 8, frameId: 0, type: 'main_frame', url: callback});
    f.requested.emit({tabId: 7, frameId: 1, type: 'main_frame', url: callback});
    f.requested.emit({tabId: 7, frameId: 0, type: 'sub_frame', url: callback});
    f.updated.emit(7, {url: callback.replace('/oidc?', '/oidc/other?')});
    f.updated.emit(7, {url: callback.replace('allizom.org', 'allizom.org.attacker.test')});
    f.removed.emit(8);
    expect(f.remove).not.toHaveBeenCalled();
    f.updated.emit(7, {url: callback});
    expect(await result).toBe(callback);
    f.noListeners();
  });

  it.each(['state=other&code=fixture', 'state=ours&state=other&code=fixture', 'state=ours&code=fixture#fragment'])(
    'rejects an invalid callback before token exchange: %s', async query => {
      const f = fixture(), result = launchLoginWindow(authorization);
      const rejected = expect(result).rejects.toThrow('登录状态无效');
      await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
      f.updated.emit(7, {url: redirect + '?' + query});
      await rejected;
      expect(f.remove).toHaveBeenCalledExactlyOnceWith(7); f.noListeners();
    },
  );

  it('returns provider denial to the common OIDC validation', async () => {
    const f = fixture(), result = launchLoginWindow(authorization);
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    const denial = redirect + '?state=ours&error=access_denied';
    f.updated.emit(7, {url: denial});
    expect(await result).toBe(denial); f.noListeners();
  });

  it('cleans up a user-closed tab and allows retry', async () => {
    const f = fixture(), result = launchLoginWindow(authorization);
    const rejected = expect(result).rejects.toThrow('登录窗口已关闭');
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    f.removed.emit(7); await rejected; f.noListeners();
    expect(f.update).toHaveBeenLastCalledWith(3, {active: true});
    const retried = launchLoginWindow(authorization);
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledTimes(3));
    f.updated.emit(7, {url: callback});
    expect(await retried).toBe(callback); f.noListeners();
  });

  it('expires and closes only its own tab', async () => {
    vi.useFakeTimers();
    const f = fixture(), result = launchLoginWindow(authorization);
    const rejected = expect(result).rejects.toThrow('登录状态无效或已过期');
    await vi.advanceTimersByTimeAsync(600000);
    await rejected;
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7); f.noListeners();
  });

  it('sanitizes navigation failures and releases listeners', async () => {
    const f = fixture();
    f.update.mockRejectedValue(Error('internal URL with secret'));
    await expect(launchLoginWindow(authorization)).rejects.toThrow('未收到登录结果');
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7); f.noListeners();
  });

  it.each(['remove', 'caller'] as const)('keeps the result when %s disappears during cleanup', async missing => {
    const f = fixture();
    if (missing === 'remove') f.remove.mockRejectedValue(Error('Tab already closed'));
    else f.update.mockImplementation(async id => {
      if (id === 3) throw Error('Caller already closed');
      return {} as chrome.tabs.Tab;
    });
    const result = launchLoginWindow(authorization);
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    f.updated.emit(7, {url: callback});
    expect(await result).toBe(callback);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.update).toHaveBeenLastCalledWith(3, {active: true});
    f.noListeners();
  });

  it('cleans up partially registered listeners and returns to the caller if registration fails', async () => {
    const f = fixture();
    f.requested.addListener.mockImplementation(() => { throw Error('Permission changed'); });
    await expect(launchLoginWindow(authorization)).rejects.toThrow('未收到登录结果');
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.update).toHaveBeenCalledExactlyOnceWith(3, {active: true});
    f.noListeners();
  });

  it('closes the authorization tab when its extension page unloads', async () => {
    const page = new EventTarget();
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
    const f = fixture(), result = launchLoginWindow(authorization);
    const rejected = expect(result).rejects.toThrow('登录窗口已关闭');
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    page.dispatchEvent(new Event('pagehide')); await rejected;
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(7); f.noListeners();
  });

  it('does not open a tab without the required observer APIs', async () => {
    const f = fixture();
    Object.assign(chrome, {webRequest: undefined});
    await expect(launchLoginWindow(authorization)).rejects.toThrow('不支持安全登录');
    expect(f.create).not.toHaveBeenCalled(); f.noListeners();
  });

  it.each(['api', 'tab'] as const)('does not open a tab without the caller %s', async missing => {
    const f = fixture();
    if (missing === 'api') Object.assign(chrome.tabs, {getCurrent: undefined});
    else f.getCurrent.mockResolvedValue(undefined);
    await expect(launchLoginWindow(authorization)).rejects.toThrow('不支持安全登录');
    expect(f.create).not.toHaveBeenCalled(); f.noListeners();
  });
});
