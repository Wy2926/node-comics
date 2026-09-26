import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchPath} from '../search';
import {definition} from '../definition';
import {validateSearchPage} from '../../../core/search';
import {searchResult} from './fixtures';
const request = {siteId: 'mangadot', query: 'fixture'};
describe('MangaDot name search', () => {
  it('encodes names without language filters and returns lightweight candidates with optional metadata omitted', () => {
    const path = new URL(searchPath({...request, query: '灰宮 & français 日本語'}), 'https://mangadot.net');
    expect(path.searchParams.get('search')).toBe('灰宮 & français 日本語');
    expect([...path.searchParams.keys()]).toEqual(['search', 'limit', 'sortBy', 'sortOrder']);
    const parsed = parseSearch(searchResult(), request), result = validateSearchPage(parsed, definition, definition.sites![0], [definition]);
    expect(result.items[0].catalogId).toBe('mangadot:7');
    expect(result.items[0].contentLanguages).toBeUndefined();
    expect(result.items[0].authors).toBeUndefined();
  });
  it('round trips opaque source cursors as query values, binds them to the query and refuses loops', () => {
    const data = searchResult(); data.pagination.next_cursor = 'opaque+value/=';
    const first = parseSearch(data, request), next = {...request, cursor: first.nextCursor};
    expect(new URL(searchPath(next), 'https://mangadot.net').searchParams.get('cursor')).toBe('opaque+value/=');
    expect(() => searchPath({...next, query: 'different'})).toThrow();
    expect(() => parseSearch(data, next)).toThrow();
    for (const cursor of ['https://evil.test', '{}', '{"query":"fixture","value":""}']) expect(() => searchPath({...request, cursor})).toThrow();
  });
  it('shows the source latest chapter number, including decimals and zero, and leaves missing numbers unspecified', () => {
    for (const [latest, label] of [[42, 'Ch. 42'], ['12.50', 'Ch. 12.5'], [0, 'Ch. 0'], [null, undefined], [undefined, undefined]] as const) {
      const data = searchResult();
      const value = {...data, manga_list: data.manga_list.map(row => ({...row, latest_chapter_number: latest}))};
      expect(parseSearch(value, request).items[0].latestLabel).toBe(label);
      expect(parseSearch(value, request).items[0].authors).toBeUndefined();
    }
  });
  it('accepts explicit empty results and rejects malformed, duplicate or foreign candidates', () => {
    const empty = searchResult(); empty.manga_list = []; empty.pagination.total_results = 0;
    expect(parseSearch(empty, request)).toEqual({items: []});
    for (const mode of ['duplicate', 'owner', 'count', 'cover', 'query', 'empty-cursor']) {
      const data = searchResult();
      if (mode === 'duplicate') {data.manga_list.push(data.manga_list[0]); data.pagination.total_results = 2;}
      if (mode === 'owner') data.manga_list[0].id = 0;
      if (mode === 'count') data.pagination.total_results = -1;
      if (mode === 'cover') data.manga_list[0].photo = 'https://evil.test/a.webp';
      if (mode === 'query') data.query = 'other';
      if (mode === 'empty-cursor') {data.manga_list = []; data.pagination.next_cursor = 'next';}
      expect(() => parseSearch(data, request)).toThrow();
    }
  });
  it('uses one request with search Referer, refuses foreign site IDs and honors cancellation', async () => {
    const context = {request: vi.fn(async () => JSON.stringify(searchResult()))};
    await search(request, context);
    expect(context.request).toHaveBeenCalledExactlyOnceWith('https://mangadot.net' + searchPath(request), {referer: 'https://mangadot.net/search'});
    await expect(search({...request, siteId: 'other'}, context)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(search(request, {...context, signal: controller.signal})).rejects.toThrow();
    expect(context.request).toHaveBeenCalledTimes(1);
  });
});
