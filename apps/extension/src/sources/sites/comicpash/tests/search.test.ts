import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {definition} from '../definition';
import {validateSearchPage} from '../../../core/search';

const request = {siteId: 'comicpash', query: '異世界 & Love + %'};
const row = (id = 'abc123') => ({id, name: '作品', author: [{name: '漫画家'}, {name: '原作者'}],
  thumbnailImages: [{size: 'large', url: 'https://cdn-public.comici.jp/series/cover.webp'}]});
const body = (rows: unknown[] = [row()], total = rows.length) => JSON.stringify({searchResult: {
  series: {total, series: rows}, episode: {total: 1, episodes: [{name: '章节不能成为候选'}]},
  seriesByAuthor: {total: 1, seriesByAuthor: [row('unrelated')]}}});

describe('Comic PASH search', () => {
  it('encodes name queries and only returns series matched by name', async () => {
    const read = vi.fn(async (target: string) => {
      const url = new URL(target);
      expect(url.origin + url.pathname).toBe('https://comicpash.jp/api/search');
      expect(Object.fromEntries(url.searchParams)).toEqual({q: request.query, page: '1', size: '12'});
      return body();
    });
    const page = await search(request, {request: read});
    expect(read).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(1);
    expect(validateSearchPage(page, definition, definition.sites![0], [definition]).items[0]).toMatchObject({
      catalogId: 'comicpash:series:abc123', catalogUrl: 'https://comicpash.jp/series/abc123', authors: ['漫画家', '原作者']});
    expect(page.items[0]).not.toHaveProperty('contentLanguages');
    expect(parseSearch(body([]), request)).toEqual({items: []});
  });
  it('preserves order, paginates by series count and tolerates absent optional metadata', () => {
    const rows = Array.from({length: 12}, (_, i) => row('work' + i));
    const first = parseSearch(body(rows, 13), request);
    expect(first.nextCursor).toBe('page:2');
    expect(first.items.map(item => item.catalogId)).toEqual(rows.map(row => 'comicpash:series:' + row.id));
    const next = {...request, cursor: first.nextCursor};
    expect(new URL(searchUrl(next).url).searchParams.get('page')).toBe('2');
    expect(parseSearch(body([{id: 'last', name: '最終作品'}], 13), next)).toMatchObject({items: [{catalogId: 'comicpash:series:last'}]});
    expect(parseSearch(body([{id: 'last', name: '最終作品'}], 13), next).nextCursor).toBeUndefined();
  });
  it('rejects malformed identities, duplicates, incomplete pages and verification pages', () => {
    for (const id of ['../evil', 'https://evil.test', 'abc#binding', '']) expect(() => parseSearch(body([{...row(), id}]), request)).toThrow();
    for (const raw of [body([row(), row()]), body([row()], 13), body([row()], -1), '{}', '<h1>Verify</h1>']) {
      expect(() => parseSearch(raw, request)).toThrow();
    }
    for (const cursor of ['https://evil.test', 'page:0', 'page:10000']) expect(() => searchUrl({...request, cursor})).toThrow();
    expect(() => searchUrl({...request, siteId: 'other'})).toThrow();
  });
  it('does not publish aborted responses or swallow a transport error', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return body();});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    const failure = Error('offline');
    await expect(search(request, {request: async () => {throw failure;}})).rejects.toBe(failure);
  });
});
