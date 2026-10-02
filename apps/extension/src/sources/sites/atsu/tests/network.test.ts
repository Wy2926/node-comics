import {describe, expect, it, vi} from 'vitest';
import {definition, catalogUrl, chapterUrl} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchPath} from '../search';
import {assetUrl} from '../protocol';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {chapter, chapters, hits, metadata, pages} from './fixtures';

const catalog = catalogUrl('Work1'), reader = chapterUrl('Work1', 'Chap1');
describe('Atsumaru isolated HTTP adapter', () => {
  it('claims exact HTTPS host and binds readers to the work already present in their URLs', () => {
    expect(definition.identify(new URL(catalog))?.catalog?.key).toBe('atsu:Work1');
    expect(definition.identify(new URL(catalogUrl('K_k-')))?.catalog?.key).toBe('atsu:K_k-');
    expect(definition.identify(new URL(reader + '#rs=p:3'))).toMatchObject({kind: 'reader', pageKey: 'atsu:Work1:chapter:Chap1', catalog: {url: catalog}});
    for (const url of ['http://atsu.moe/manga/Work1', 'https://atsu.moe.evil.test/manga/Work1', 'https://atsu.moe:444/manga/Work1', 'https://u:p@atsu.moe/manga/Work1'])
      expect(definition.identify(new URL(url))).toBeNull();
    for (const path of ['/novel/Work1', '/read/Chap1', '/manga/Work1/extra', '/manga/%57ork1'])
      expect(definition.identify(new URL('https://atsu.moe' + path))?.kind).toBe('other');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.installation.optionalOrigins).toEqual(['https://atsu.moe/*', 'https://cdn.atsu.moe/*']);
    expect(definition.sites![0].search!.requestOrigins.every(origin => definition.installation.optionalOrigins!.includes(origin))).toBe(true);
  });
  it('checks total count, orders by the source index and keeps scanlation chains independent', () => {
    const result = validateCatalog(parseCatalog(metadata(), chapters(), 'Work1'), [definition]);
    expect(result.complete).toBe(true);
    expect(result.entries.map(row => row.remoteId)).toEqual(['Chap1', 'Chap2', 'Chap3']);
    expect(result.groups.map(group => group.entryIds.length)).toEqual([2, 1]);
    expect(result.entries.map(row => row.sequenceId)).toEqual(['atsu:Work1:scanlation:Scan1', 'atsu:Work1:scanlation:Scan1', 'atsu:Work1:scanlation:Scan2']);
    expect(result.entries.every(row => row.contentLanguage === undefined && row.readingSlotId === undefined)).toBe(true);
    expect(result.cover?.url).toBe('https://cdn.atsu.moe/static/posters/fixture.jpg');
    expect(result.defaultEntryId).toBe(result.entries[0].id);
    for (const row of result.entries) expect(definition.identify(new URL(row.url))?.pageKey).toBe(row.id);
  });
  it('preserves group order and reading chains at the catalog budget without changing input rows', () => {
    const meta = metadata(), groupCount = 1000, chapterCount = 10000;
    meta.mangaPage.scanlators = Array.from({length: groupCount}, (_, index) => ({id: 'Scan' + index, name: 'Group ' + index}));
    meta.mangaPage.totalChapterCount = chapterCount;
    const rows = {chapters: Array.from({length: chapterCount}, (_, index) =>
      chapter('Chap' + index, index % 10, 'Scan' + Math.floor(index / 10))).reverse()};
    const before = structuredClone(rows);
    const result = validateCatalog(parseCatalog(meta, rows, 'Work1'), [definition]);
    expect(result.entries).toHaveLength(chapterCount); expect(result.groups).toHaveLength(groupCount);
    expect(result.groups.map(group => group.id)).toEqual(meta.mangaPage.scanlators.map(group => group.id));
    expect(result.groups.every((group, index) => group.entryIds.join(',') ===
      Array.from({length: 10}, (_, offset) => chapterUrl('Work1', 'Chap' + (index * 10 + offset)))
        .map(url => definition.identify(new URL(url))!.pageKey).join(','))).toBe(true);
    expect(rows).toEqual(before);
    const empty = metadata(); empty.mangaPage.scanlators.push({id: 'Empty', name: 'Empty group'});
    expect(parseCatalog(empty, chapters(), 'Work1').groups.at(-1)?.entryIds).toEqual([]);
  });
  it.each(['owner', 'novel', 'count', 'duplicate', 'scanlator', 'index', 'cover'])('rejects %s catalog evidence', mode => {
    const meta = metadata(), rows = chapters();
    if (mode === 'owner') meta.mangaPage.id = 'Other';
    if (mode === 'novel') meta.mangaPage.medium = 'Novel';
    if (mode === 'count') meta.mangaPage.totalChapterCount++;
    if (mode === 'duplicate') rows.chapters[1].id = rows.chapters[0].id;
    if (mode === 'scanlator') rows.chapters[0].scanlationMangaId = 'Other';
    if (mode === 'index') rows.chapters[0].index = rows.chapters[2].index;
    if (mode === 'cover') meta.mangaPage.poster.image = 'https://evil.test/static/posters/fixture.jpg';
    expect(() => parseCatalog(meta, rows, 'Work1')).toThrow();
  });
  it('marks explicitly empty chapters unreadable and preserves the supplied previous snapshot on errors', async () => {
    const rows = chapters(); rows.chapters[2].pageCount = 0;
    const previous = parseCatalog(metadata(), rows, 'Work1'), before = structuredClone(previous);
    expect(previous.entries[0].readable).toBe(false); expect(previous.defaultEntryId).toBe(previous.entries[1].id);
    const request = vi.fn(async (url: string) => JSON.stringify(url.includes('allChapters') ? chapters() : metadata()));
    expect((await network.catalog(catalog, {request, previous})).entries).toHaveLength(3);
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://atsu.moe/api/manga/page?id=Work1', 'https://atsu.moe/api/manga/allChapters?mangaId=Work1']);
    expect(request).toHaveBeenCalledWith('https://atsu.moe/api/manga/page?id=Work1', {referer: catalog});
    await expect(network.catalog(catalog, {previous, request: async () => 'Just a moment...'})).rejects.toThrow('验证');
    expect(previous).toEqual(before);
  });
  it.each(['owner', 'novel', 'budget'])('stops before requesting the full directory for invalid %s metadata', async mode => {
    const meta = metadata();
    if (mode === 'owner') meta.mangaPage.id = 'Other';
    if (mode === 'novel') meta.mangaPage.medium = 'Novel';
    if (mode === 'budget') meta.mangaPage.totalChapterCount = 10001;
    const fetcher = vi.fn(async () => JSON.stringify(meta));
    await expect(network.catalog(catalog, {request: fetcher})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://atsu.moe/api/manga/page?id=Work1', {referer: catalog});
  });
  it('preserves complete page order and duplicate URLs as distinct source page slots', () => {
    const result = validatePages(parsePages(pages(), reader), definition.identify(new URL(reader))!);
    expect(result.items.map(row => [row.id, row.order])).toEqual([['Chap1-0', 0], ['Chap1-1', 1], ['Chap1-2', 2]]);
    expect(result.knownTotal).toBe(3); expect(result.items[1].resource).toEqual(result.items[2].resource);
  });
  it('accepts the explicit scanlation namespace used by current uploads', () => {
    const data = pages(); data.readChapter.pages[0].image = '/static/pages/Scan1/Chap1/aea14c372f4747ec.avif';
    expect(parsePages(data, reader, metadata()).items[0].resource).toEqual({kind: 'http', url: 'https://cdn.atsu.moe/static/pages/Scan1/Chap1/aea14c372f4747ec.avif'});
    expect(() => parsePages(data, reader)).toThrow();
    const wrong = metadata(); wrong.mangaPage.scanlators = [{id: 'Other', name: 'Other group'}];
    expect(() => parsePages(data, reader, wrong)).toThrow();
    expect(() => parsePages(data, chapterUrl('Other', 'Chap1'), metadata())).toThrow();
  });
  it('independently confirms scanlation ownership because read.chapter does not enforce the work parameter', async () => {
    const data = pages(); data.readChapter.pages[0].image = '/static/pages/Scan1/Chap1/aea14c372f4747ec.avif';
    const request = vi.fn(async (url: string) => JSON.stringify(url.includes('/api/manga/') ? metadata() : data));
    expect((await network.pages(reader, {request})).items).toHaveLength(3);
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://atsu.moe/api/read/chapter?mangaId=Work1&chapterId=Chap1', 'https://atsu.moe/api/manga/page?id=Work1']);
    await expect(network.pages(chapterUrl('Other', 'Chap1'), {request})).rejects.toThrow();
  });
  it.each(['page-id', 'order', 'dimensions'])('rejects malformed scanlation-owned %s pages before another HTTP request', async mode => {
    const data = pages(); data.readChapter.pages[0].image = '/static/pages/Scan1/Chap1/0.webp';
    if (mode === 'page-id') data.readChapter.pages[0].id = 'Other-0';
    if (mode === 'order') data.readChapter.pages[0].number = 1;
    if (mode === 'dimensions') data.readChapter.pages[0].width = -1;
    const fetcher = vi.fn(async () => JSON.stringify(data));
    await expect(network.pages(reader, {request: fetcher})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://atsu.moe/api/read/chapter?mangaId=Work1&chapterId=Chap1', {referer: reader});
  });
  it.each(['owner', 'work', 'case', 'page-id', 'order', 'dimensions', 'foreign-host', 'credentials', 'empty'])('rejects %s page data', mode => {
    const data = pages();
    if (mode === 'owner') data.readChapter.id = 'Other';
    if (mode === 'work') data.readChapter.pages[0].image = '/static/pages/Other/Chap1/0.webp';
    if (mode === 'case') data.readChapter.pages[0].image = '/static/pages/work1/Chap1/0.webp';
    if (mode === 'page-id') data.readChapter.pages[0].id = 'Other-0';
    if (mode === 'order') data.readChapter.pages[0].number = 1;
    if (mode === 'dimensions') data.readChapter.pages[0].width = -1;
    if (mode === 'foreign-host') data.readChapter.pages[0].image = 'https://cdn.atsu.moe.evil.test/static/pages/Work1/Chap1/0.webp';
    if (mode === 'credentials') data.readChapter.pages[0].image = 'https://u:p@cdn.atsu.moe/static/pages/Work1/Chap1/0.webp';
    if (mode === 'empty') data.readChapter.pages = [];
    expect(() => parsePages(data, reader)).toThrow();
  });
  it('uses one full-page HTTP operation and checks cancellation before and after each response', async () => {
    const request = vi.fn(async () => JSON.stringify(pages()));
    expect((await network.pages(reader, {request})).items).toHaveLength(3);
    expect(request).toHaveBeenCalledExactlyOnceWith('https://atsu.moe/api/read/chapter?mangaId=Work1&chapterId=Chap1', {referer: reader});
    const controller = new AbortController(); controller.abort(); request.mockClear();
    await expect(network.pages(reader, {request, signal: controller.signal})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    const pending = new AbortController();
    await expect(network.catalog(catalog, {signal: pending.signal, request: async () => {pending.abort(); return JSON.stringify(metadata());}})).rejects.toThrow();
  });
  it('normalizes only source-owned static poster forms and rejects query, path traversal and unclaimed hosts', () => {
    expect(assetUrl('/static/posters/fixture.jpg', 'cover')).toBe(assetUrl('posters/fixture.jpg', 'cover'));
    for (const url of ['posters/fixture.jpg?x=1', 'posters/%66ixture.jpg', 'https://atsu.moe/static/posters/fixture.jpg', '//evil.test/static/posters/fixture.jpg', 'posters/../pages/0.webp'])
      expect(() => assetUrl(url, 'cover')).toThrow();
  });
});
describe('Atsumaru name search', () => {
  it('requests only names/aliases without inferring content languages or copying highlights', async () => {
    const request = {siteId: 'atsu', query: 'Fixture'}, path = new URL(searchPath(request), 'https://atsu.moe');
    expect(path.searchParams.get('query_by')).toBe('title,englishTitle,otherNames,acronyms');
    expect(path.searchParams.get('filter_by')).toBe('medium:=Comic && hidden:!=true');
    expect(parseSearch(hits(), request).items[0]).toMatchObject({title: 'Fixture work', authors: ['Fixture author'], catalogUrl: catalog});
    expect(parseSearch(hits(), request).items[0].contentLanguages).toBeUndefined();
    const fetch = vi.fn(async () => JSON.stringify(hits()));
    expect((await network.search(request, {request: fetch})).items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith('https://atsu.moe' + searchPath(request), {referer: 'https://atsu.moe/explore'});
  });
  it('binds pagination to the query and rejects malformed or incomplete search pages', () => {
    const request = {siteId: 'atsu', query: 'Fixture'}, data = hits(); data.found = 25;
    data.hits = Array.from({length: 24}, (_, index) => ({document: {...hits().hits[0].document, id: 'Work' + index}}));
    const first = parseSearch(data, request); expect(first.nextCursor).toBe(JSON.stringify({query: 'Fixture', page: 2}));
    expect(new URL(searchPath({...request, cursor: first.nextCursor}), 'https://atsu.moe').searchParams.get('page')).toBe('2');
    expect(() => searchPath({...request, query: 'Other', cursor: first.nextCursor})).toThrow();
    expect(() => searchPath({...request, cursor: '{"query":"Fixture","page":1}'})).toThrow();
    data.hits.pop(); expect(() => parseSearch(data, request)).toThrow();
    expect(() => parseSearch({found: 1, page: 1, hits: []}, request)).toThrow();
    expect(() => parseSearch({found: 25, page: 2, hits: []}, {...request, cursor: JSON.stringify({query: 'Fixture', page: 2})})).toThrow();
    expect(parseSearch({...hits(), found: 25, page: 2}, {...request, cursor: JSON.stringify({query: 'Fixture', page: 2})}).nextCursor).toBeUndefined();
    const duplicate = hits(); duplicate.found = 2; duplicate.hits.push(duplicate.hits[0]); expect(() => parseSearch(duplicate, request)).toThrow();
    expect(parseSearch({found: 0, page: 1, hits: []}, request).items).toEqual([]);
  });
});
