import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search} from '../search';
import {definition} from '../definition';
import {encodeRequest, decodeResponse} from '../protocol';
import {validateSearchPage} from '../../../core/search';

const request = {siteId: 'comix', query: '海 & One Piece + %'};
const row = (id = 'sample') => ({hid: id, url: '/title/' + id + '-work', title: '作品', originalLanguage: 'ja',
  poster: {large: 'https://static.comix.to/cover.jpg'}, latestChapter: 1.5});
const result = (items = [row()], page = 1, total = items.length) => ({items,
  meta: {perPage: 12, page, total, lastPage: Math.max(1, Math.ceil(total / 12)), hasNext: page * 12 < total}});

describe('Comix search', () => {
  it('uses the bounded signed name API, with encoded transport and both response forms', async () => {
    for (const encrypted of [false, true]) {
      const read = vi.fn(async (target: string) => {
        const url = new URL(target);
        expect(url.origin + url.pathname).toBe('https://comix.to/api/v1/manga');
        expect(url.searchParams.get('keyword')).toBe(request.query);
        expect(decodeResponse(url.searchParams.get('_')!)).toBe('/manga?keyword=' + request.query + '&limit=12&order[relevance]=desc&page=1');
        expect([...url.searchParams.keys()].sort()).toEqual(['_', 'keyword', 'limit', 'order[relevance]', 'page']);
        const body = {status: 'ok', result: result()};
        return JSON.stringify(encrypted ? {e: encodeRequest(JSON.stringify(body))} : body);
      });
      const page = await search(request, {request: read});
      expect(read).toHaveBeenCalledTimes(1);
      expect(validateSearchPage(page, definition, definition.sites![0], [definition]).items[0]).toMatchObject({
        catalogId: 'comix:sample', catalogUrl: 'https://comix.to/title/sample-work', title: '作品', latestLabel: 'Chapter 1.5'});
      expect(page.items[0]).not.toHaveProperty('contentLanguages');
    }
  });
  it('handles full, final and empty pages without losing source order', () => {
    const rows = Array.from({length: 12}, (_, i) => row('work' + i));
    const first = parseSearch(result(rows, 1, 13), request);
    expect(first.nextCursor).toBe('page:2');
    expect(first.items.map(item => item.catalogId)).toEqual(rows.map(row => 'comix:' + row.hid));
    expect(parseSearch(result([row('last')], 2, 13), {...request, cursor: first.nextCursor}).nextCursor).toBeUndefined();
    expect(parseSearch(result([]), request)).toEqual({items: []});
  });
  it('rejects foreign, mismatched, duplicate and chapter identities and incomplete pagination', () => {
    for (const bad of [{...row(), url: 'https://comix.to.evil.test/title/sample-work'}, {...row(), url: '/title/other-work'},
      {...row(), url: '/title/sample-work/1-chapter-1'}, {...row(), url: 'https://user@comix.to/title/sample-work'}]) {
      expect(() => parseSearch(result([bad]), request)).toThrow();
    }
    expect(() => parseSearch(result([row(), row()]), request)).toThrow();
    expect(() => parseSearch(result([row()], 1, 13), request)).toThrow();
    expect(() => parseSearch(result(), {...request, cursor: 'page:2'})).toThrow();
  });
  it('rejects arbitrary cursors and verification/error payloads and propagates transport failures', async () => {
    const read = vi.fn(async () => '');
    for (const cursor of ['https://evil.test/', 'page:0', 'page:10000']) await expect(search({...request, cursor}, {request: read})).rejects.toThrow();
    await expect(search({...request, siteId: 'other'}, {request: read})).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    for (const body of ['<h1>Verify your browser</h1>', '{"status":"error"}', '{"status":"ok","result":{}}']) {
      await expect(search(request, {request: async () => body})).rejects.toThrow();
    }
    const failure = Error('offline');
    await expect(search(request, {request: async () => {throw failure;}})).rejects.toBe(failure);
  });
  it('does not send aborted searches or publish late responses', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return JSON.stringify({status: 'ok', result: result()});});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
