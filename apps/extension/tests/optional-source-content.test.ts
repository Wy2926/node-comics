import {afterEach, describe, expect, it, vi} from 'vitest';
import {syncOptionalSourceContent} from '../src/sources/runtime/optional-content';
afterEach(() => vi.unstubAllGlobals());
describe('optional site entries', () => {
  it('registers only after host grant, injects existing tabs, updates idempotently, and removes after revocation', async () => {
    let allowed = false;
    const scripts: chrome.scripting.RegisteredContentScript[] = [], injected = vi.fn(async () => []);
    vi.stubGlobal('navigator', {locks: {request: async (_key: string, run: () => Promise<void>) => run()}});
    vi.stubGlobal('chrome', {
      permissions: {contains: async ({origins}: {origins: string[]}) => allowed && origins.every(origin => origin === 'https://comic.naver.com/*')}, tabs: {query: async () => [{id: 7}]},
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
    expect(scripts).toEqual([expect.objectContaining({id: 'nc-source-entry-naver', matches: ['https://comic.naver.com/*'], allFrames: false})]);
    expect(injected).toHaveBeenCalledWith({target: {tabId: 7}, files: ['content-scripts/content.js']});
    await syncOptionalSourceContent(); expect(scripts).toHaveLength(1);
    scripts.push({id: 'another-feature', matches: ['https://example.com/*'], js: ['other.js']});
    allowed = false; await syncOptionalSourceContent(); expect(scripts.map(s => s.id)).toEqual(['another-feature']);
  });
});
