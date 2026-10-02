import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {searchPage, title, titleId} from './fixtures';

const request = {siteId: 'mangaball', query: 'fixture 名前'};
describe('MangaBall name-only GET search', () => {
  it('returns lightweight artwork and explicitly supplied languages without fetching catalogs', async () => {
    const fetcher = vi.fn(async (_url: string) => JSON.stringify(searchPage()));
    const result = await search(request, {request: fetcher});
    expect(result.items[0]).toMatchObject({catalogId: 'mangaball:' + titleId, title: 'Fixture work', contentLanguages: ['en', 'zh-Hans'], authors: ['Author']});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/title/search-advanced'); expect(url.searchParams.get('keyword')).toBe(request.query);
    expect(url.searchParams.has('language')).toBe(false); expect(url.searchParams.has('user_id')).toBe(false);
    expect(parseSearch(searchPage([]), request)).toEqual({items: []});
    const zeroPages = searchPage([]); zeroPages.pagination.total_pages = 0;
    expect(parseSearch(zeroPages, request)).toEqual({items: []});
    const row = {...title().data, availableTranslatedLanguages: undefined, author: undefined, image: undefined};
    expect(parseSearch(searchPage([row]), request).items[0].contentLanguages).toBeUndefined();
    expect(parseSearch(searchPage([{...row, availableTranslatedLanguages: 'en'}]), request).items[0].contentLanguages).toEqual(['en']);
  });
  it('bounds cursors and rejects changed pagination or duplicated results', () => {
    const rows = Array.from({length: 20}, (_, n) => ({...title().data, id: (n + 1).toString(16).padStart(24, '0'), _id: (n + 1).toString(16).padStart(24, '0')}));
    expect(parseSearch(searchPage(rows, 21), request).nextCursor).toBe('page:2');
    expect(new URL(searchUrl({...request, cursor: 'page:2'}).url).searchParams.get('page')).toBe('2');
    for (const cursor of ['', 'page:0', 'page:1', 'page:02', 'page:5001', 'https://evil.test']) expect(() => searchUrl({...request, cursor})).toThrow();
    expect(() => searchUrl({...request, siteId: 'another'})).toThrow();
    expect(() => parseSearch(searchPage(rows, 20, 2), request)).toThrow();
    expect(() => parseSearch(searchPage([title().data, title().data]), request)).toThrow();
    expect(() => parseSearch(searchPage([], 1), request)).toThrow();
  });
  it('honors cancellation before and after the only request', async () => {
    const before = new AbortController(), fetcher = vi.fn(); before.abort();
    await expect(search(request, {signal: before.signal, request: fetcher})).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const during = new AbortController();
    await expect(search(request, {signal: during.signal, request: async () => {during.abort(); return JSON.stringify(searchPage());}})).rejects.toThrow();
  });
});
