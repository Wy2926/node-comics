import {afterEach, describe, expect, it, vi} from 'vitest';
import {launchLoginWindow} from './auth-window';

function fixture() {
  const event = () => {
    const listeners = new Set<(...args: any[]) => void>();
    return {addListener: (listener: (...args: any[]) => void) => listeners.add(listener),
      removeListener: (listener: (...args: any[]) => void) => listeners.delete(listener),
      emit: (...args: any[]) => listeners.forEach(listener => listener(...args)), listeners};
  };
  const created = event(), updated = event();
  let resolve!: (value: string) => void, reject!: (reason: Error) => void;
  const flow = new Promise<string>((yes, no) => {resolve = yes; reject = no;});
  const update = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({tabs: [] as chrome.tabs.Tab[]}));
  vi.stubGlobal('chrome', {windows: {onCreated: created, update, get}, tabs: {onUpdated: updated},
    identity: {launchWebAuthFlow: vi.fn(() => flow)}});
  return {created, updated, update, get, resolve, reject};
}
afterEach(() => vi.unstubAllGlobals());

describe('browser-owned login popup', () => {
  it('sizes only a new provider popup and leaves existing windows, other sites and other states alone', async () => {
    const f = fixture(), result = launchLoginWindow('https://identity.example/authorize?state=ours');
    const navigate = (windowId: number, url: string) => f.updated.emit(1, {url}, {windowId, url});
    navigate(1, 'https://identity.example/login');
    f.created.emit({id: 1, type: 'normal'}); navigate(1, 'https://identity.example/login');
    f.created.emit({id: 2, type: 'popup'});
    navigate(2, 'https://other.example/login');
    navigate(2, 'https://identity.example/authorize?state=another-request');
    expect(f.update).not.toHaveBeenCalled();
    navigate(2, 'https://identity.example/login');
    expect(f.update).toHaveBeenCalledExactlyOnceWith(2, {width: 600, height: 760, state: 'normal'});
    f.resolve('https://extension.chromiumapp.org/oidc?code=fixture');
    expect(await result).toContain('/oidc?code=fixture');
    expect(f.created.listeners.size + f.updated.listeners.size).toBe(0);
  });

  it('handles a provider page already loaded when Chrome exposes the popup', async () => {
    const f = fixture();
    f.get.mockResolvedValue({tabs: [{windowId: 3, url: 'https://identity.example/login'} as chrome.tabs.Tab]});
    const result = launchLoginWindow('https://identity.example/authorize?state=ours');
    f.created.emit({id: 3, type: 'popup'});
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
    f.resolve('callback'); await result;
  });

  it('removes listeners after cancellation and ignores a late window lookup', async () => {
    const f = fixture();
    let finish!: (value: {tabs: chrome.tabs.Tab[]}) => void;
    f.get.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const result = launchLoginWindow('https://identity.example/authorize?state=ours');
    f.created.emit({id: 3, type: 'popup'});
    const rejected = expect(result).rejects.toThrow('closed'); f.reject(Error('closed')); await rejected;
    finish({tabs: [{windowId: 3, url: 'https://identity.example/login'} as chrome.tabs.Tab]});
    await Promise.resolve();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.created.listeners.size + f.updated.listeners.size).toBe(0);
  });
});
