import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerOptionalSourceContent, syncOptionalSourceContent} from '../src/sources/runtime/optional-content';
afterEach(() => vi.unstubAllGlobals());
describe('optional site entries', () => {
  it('injects newly numbered hosts on startup and navigation only with source identity and host access', async () => {
    const url = 'https://www.goodtoon012.com/manga/gt-42/', injected = vi.fn(async () => []), removed = vi.fn();
    let allowed = true;
    const permission = vi.fn(async ({origins}: {origins: string[]}) => allowed && origins[0] === 'https://www.goodtoon012.com/*');
    const updated = vi.fn(), event = {addListener: vi.fn()};
    vi.stubGlobal('navigator', {locks: {request: async (_key: string, run: () => Promise<void>) => run()}});
    vi.stubGlobal('chrome', {
      permissions: {contains: permission, onAdded: event, onRemoved: event}, runtime: {onInstalled: event},
      tabs: {query: async () => [{id: 7, url, status: 'complete'}, {id: 8, url: url.replace('.com', '.com.evil.test')},
        {id: 9, url, status: 'loading'}], onUpdated: {addListener: updated}},
      scripting: {getRegisteredContentScripts: async () => [{id: 'nc-source-entry-goodtoon'}],
        unregisterContentScripts: removed, executeScript: injected},
    });
    registerOptionalSourceContent();
    await vi.waitFor(() => expect(injected).toHaveBeenCalledExactlyOnceWith({target: {tabId: 7}, files: ['content-scripts/content.js']}));
    expect(removed).toHaveBeenCalledWith({ids: ['nc-source-entry-goodtoon']});
    injected.mockClear();
    const listener = updated.mock.calls[0][0];
    listener(10, {status: 'complete'}, {id: 10, url, status: 'complete'});
    await vi.waitFor(() => expect(injected).toHaveBeenCalledExactlyOnceWith({target: {tabId: 10}, files: ['content-scripts/content.js']}));
    injected.mockClear(); allowed = false;
    await syncOptionalSourceContent(true);
    expect(injected).not.toHaveBeenCalled();
  });
  it.each([['naver', 'https://comic.naver.com/*'], ['comix', 'https://comix.to/*']])('registers %s only after host grant, injects existing tabs, updates idempotently, and removes after revocation', async (id, origin) => {
    let allowed = false;
    const scripts: chrome.scripting.RegisteredContentScript[] = [], injected = vi.fn(async () => []);
    vi.stubGlobal('navigator', {locks: {request: async (_key: string, run: () => Promise<void>) => run()}});
    vi.stubGlobal('chrome', {
      permissions: {contains: async ({origins}: {origins: string[]}) => allowed && origins.every(value => value === origin)}, tabs: {query: async () => [{id: 7}]},
      scripting: {
        getRegisteredContentScripts: async () => [...scripts],
        registerContentScripts: async (rows: chrome.scripting.RegisteredContentScript[]) => scripts.push(...rows),
        updateContentScripts: async (rows: chrome.scripting.RegisteredContentScript[]) => {for (const row of rows) scripts[scripts.findIndex(s => s.id === row.id)] = row;},
        unregisterContentScripts: async ({ids}: {ids: string[]}) => {for (const id of ids) scripts.splice(scripts.findIndex(s => s.id === id), 1);},
        executeScript: injected,
      },
    });
    await syncOptionalSourceContent(true); expect(scripts).toEqual([]); expect(injected).not.toHaveBeenCalled();
    allowed = true; await syncOptionalSourceContent(true);
    expect(scripts).toEqual([expect.objectContaining({id: 'nc-source-entry-'+id, matches: [origin], allFrames: false})]);
    expect(injected).toHaveBeenCalledWith({target: {tabId: 7}, files: ['content-scripts/content.js']});
    await syncOptionalSourceContent(); expect(scripts).toHaveLength(1);
    scripts.push({id: 'another-feature', matches: ['https://example.com/*'], js: ['other.js']});
    allowed = false; await syncOptionalSourceContent(); expect(scripts.map(s => s.id)).toEqual(['another-feature']);
  });
});
