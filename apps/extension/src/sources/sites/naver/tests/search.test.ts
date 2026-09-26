import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchPosition, searchUrl} from '../search';
import {definition, levels, type Section} from '../definition';
import {validateSearchPage} from '../../../core/search';

const request = {siteId: 'naver', query: '마음 & Love + %'};
const row = (section: Section, titleId = 123) => ({titleId, titleName: '마음', webtoonLevelCode: levels[section],
  thumbnailUrl: 'https://image-comic.pstatic.net/cover.jpg', communityArtists: [{name: '作家'}], publishDescription: '10화 완결'});
const body = (section: Section, page = 1, total = 1) => JSON.stringify({pageInfo: {
  totalRows: total, totalPages: Math.max(1, Math.ceil(total / 10)), pageSize: 10, page},
  searchList: Array.from({length: Math.min(10, Math.max(0, total - (page - 1) * 10))}, (_, i) => row(section, (page - 1) * 10 + i + 1))});

describe('NAVER search', () => {
  it('searches every supported section once and keeps independent source identities', async () => {
    const read = vi.fn(async (target: string) => {
      const url = new URL(target), section = url.pathname.split('/').at(-1) as Section;
      expect(url.origin).toBe('https://comic.naver.com');
      expect(url.pathname).toBe('/api/search/' + section);
      expect(decodeURIComponent(url.searchParams.get('keyword')!)).toBe(request.query);
      expect([...url.searchParams.keys()]).toEqual(['keyword', 'page']);
      return body(section);
    });
    const page = await search(request, {request: read});
    expect(read).toHaveBeenCalledTimes(3);
    expect(page.items.map(item => item.catalogId)).toEqual(['naver:webtoon:1', 'naver:bestChallenge:1', 'naver:challenge:1']);
    expect(validateSearchPage(page, definition, definition.sites![0], [definition]).items).toHaveLength(3);
    expect(page.items.every(item => !('contentLanguages' in item))).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });
  it('advances only unfinished sections and does not request full catalogs', async () => {
    const totals = {webtoon: 1, bestChallenge: 11, challenge: 0};
    const read = vi.fn(async (target: string) => {
      const url = new URL(target), section = url.pathname.split('/').at(-1) as Section;
      return body(section, Number(url.searchParams.get('page')), totals[section]);
    });
    const first = await search(request, {request: read});
    expect(first.items).toHaveLength(11);
    expect(first.nextCursor).toBe('page:2:bestChallenge');
    const second = await search({...request, cursor: first.nextCursor}, {request: read});
    expect(read).toHaveBeenCalledTimes(4);
    expect(second.items.map(item => item.catalogId)).toEqual(['naver:bestChallenge:11']);
    expect(second.nextCursor).toBeUndefined();
    expect(await search(request, {request: async url => body(new URL(url).pathname.split('/').at(-1) as Section, 1, 0)})).toEqual({items: []});
  });
  it('rejects changed section identity, duplicate rows, bad metadata and unknown cursors', () => {
    const valid = JSON.parse(body('webtoon'));
    expect(() => parseSearch(body('challenge'), 'webtoon', 1)).toThrow();
    for (const rows of [[row('webtoon', 0)], [row('webtoon'), row('webtoon')]]) {
      expect(() => parseSearch(JSON.stringify({...valid, searchList: rows, pageInfo: {...valid.pageInfo, totalRows: rows.length}}), 'webtoon', 1)).toThrow();
    }
    for (const meta of [{page: 2}, {pageSize: 50}, {totalRows: 12}, {totalPages: 0}]) {
      expect(() => parseSearch(JSON.stringify({...valid, pageInfo: {...valid.pageInfo, ...meta}}), 'webtoon', 1)).toThrow();
    }
    for (const cursor of ['https://evil.test', 'page:1:webtoon', 'page:2:seriesComic', 'page:2:challenge,webtoon', 'page:2:webtoon,webtoon']) {
      expect(() => searchPosition({...request, cursor})).toThrow();
    }
    expect(() => searchPosition({...request, siteId: 'other'})).toThrow();
    expect(() => parseSearch('<h1>Verify</h1>', 'webtoon', 1)).toThrow();
    expect(new URL(searchUrl(request.query, 'webtoon', 1)).searchParams.get('keyword')).toBe(encodeURIComponent(request.query));
  });
  it('uses displayAuthor only when the source has no artist names, and omits missing metadata', () => {
    const value = JSON.parse(body('webtoon'));
    value.searchList = [{...row('webtoon'), communityArtists: [], displayAuthor: '原作者 / 漫画家'}];
    expect(parseSearch(JSON.stringify(value), 'webtoon', 1).items[0].authors).toEqual(['原作者 / 漫画家']);
    value.searchList = [{titleId: 123, titleName: '마음', webtoonLevelCode: 'WEBTOON'}];
    expect(parseSearch(JSON.stringify(value), 'webtoon', 1).items[0].authors).toBeUndefined();
  });
  it('stops between sections on cancellation or failure and never returns a partial success', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return body('webtoon');});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    const failure = Error('offline'), partial = vi.fn(async (target: string) => {
      if (target.includes('/bestChallenge?')) throw failure;
      return body('webtoon');
    });
    await expect(search(request, {request: partial})).rejects.toBe(failure);
    expect(partial).toHaveBeenCalledTimes(2);
  });
});
