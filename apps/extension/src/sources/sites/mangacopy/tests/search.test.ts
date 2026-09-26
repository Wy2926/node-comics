import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {describeWork} from '../work';

const request = {siteId: 'mangacopy', query: '海 & Love'};
const row = {path_word: 'sample', name: '原作', author: [{name: '作者'}], cover: 'https://sh.mangafunb.fun/cover.jpg'};
const body = (list: unknown[] = [row], extra = {}) => JSON.stringify({code: 200, results: {list, total: list.length, offset: 0, limit: 12, ...extra}});
describe('MangaCopy search', () => {
  it('encodes queries and gives proven mirrors the existing canonical work identity', () => {
    expect(new URL(searchUrl(request).url).searchParams.get('q')).toBe(request.query);
    expect(parseSearch(body(), request).items[0]).toMatchObject({catalogId: 'mangacopy:sample', title: '原作'});
    expect(parseSearch(body(), request).items[0]).not.toHaveProperty('contentLanguages');
    expect(parseSearch(body(), {...request, siteId: 'copy4000'}).items[0]).toMatchObject({catalogId: 'mangacopy:sample', catalogUrl: 'https://www.copy4000.com/comic/sample'});
    expect(parseSearch(body([]), request)).toEqual({items: []});
  });
  it('uses checked offset pages and rejects wrong offset, duplicate/foreign identities and challenge responses', () => {
    const rows = Array.from({length: 12}, (_, index) => ({...row, path_word: 'sample-' + index}));
    expect(parseSearch(body(rows, {total: 13}), request).nextCursor).toBe('offset:12');
    expect(() => parseSearch(body(), {...request, cursor: 'offset:12'})).toThrow();
    expect(() => parseSearch(body([{...row, path_word: '../other'}]), request)).toThrow();
    expect(() => parseSearch(body([row, row]), request)).toThrow();
    expect(() => searchUrl({...request, cursor: 'offset:13'})).toThrow();
    expect(() => parseSearch('{"code":403}', request)).toThrow('SOURCE_SEARCH_VERIFICATION_REQUIRED');
  });
  it('honors cancellation before and after HTTP', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return body();});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('uses only the dedicated work heading and leaves chapter labels untouched', () => {
    const doc = {querySelectorAll: () => [{textContent: 'Work / Part'}], querySelector: () => null} as unknown as Document;
    expect(describeWork(doc, 'https://www.mangacopy.com/comic/sample')).toMatchObject({status: 'ready', value: {title: 'Work / Part'}});
    expect(describeWork(doc, 'https://www.mangacopy.com/comic/sample/chapter/12345678-1234-1234-1234-123456789abc')).toMatchObject({status: 'not-ready'});
  });
});
