import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import {definition, location} from '../definition';
import {network, parseCatalog, parsePages, parseSearch, searchUrl} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {definitions} from '../../../registry/definitions';
import {sourceNetworks} from '../../../registry/networks';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';
import {catalogBody, chapter, comic, envelope, imageUrl, manga, mangaReader, original, pageInfo, pagesBody, reader} from './fixtures';

describe('再漫画 isolated source adapter', () => {
  it('registers both website entries, generic inline and bounded update metadata without core registration', () => {
    expect(definitions.find(d => d.id === 'zaimanhua')).toBe(definition);
    expect(sourceNetworks.zaimanhua).toBe(network);
    expect(definition.sites).toHaveLength(2);
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.installation.optionalContentMatches).toHaveLength(4);
    expect(definition.sites!.every(site => site.search && site.pricing === 'freemium')).toBe(true);
  });
  it('recognizes verified URL forms and namespaces with strict hosts and numeric identities', () => {
    expect(definition.identify(new URL(original))?.catalog?.key).toBe('zaimanhua:original:fixture');
    expect(definition.identify(new URL(manga))?.catalog?.key).toBe('zaimanhua:manga:42');
    expect(definition.identify(new URL(reader))?.catalog?.url).toBe(original);
    expect(definition.identify(new URL(mangaReader))?.catalog?.url).toBe(manga);
    expect(definition.identify(new URL(original.replace('/info/', '/details/%E6%B5%8B%E8%AF%95/')))?.pageKey)
      .toBe(definition.identify(new URL(original))?.pageKey);
    expect(definition.identify(new URL(reader.replace('https:', 'http:') + '?utm_source=test#3'))?.pageKey)
      .toBe(definition.identify(new URL(reader))?.pageKey);
    for (const bad of [original.replace('.com', '.com.evil.test'), original.replace('www.', 'news.'),
      original.replace('www.', 'user:pass@www.'), original.replace('.com', '.com:444'), original.replace('https:', 'ftp:')])
      expect(definition.identify(new URL(bad))).toBeNull();
    for (const bad of [reader.replace('/42/', '/0/'), reader.replace('/11', '/011'), reader + '/extra',
      original.replace('fixture', 'bad%2fslug'), manga.replace('/42', '/42abc')]) expect(location(new URL(bad))).toBeNull();
    expect(definition.identify(new URL('https://www.zaimanhua.com/'))?.kind).toBe('other');
  });
  it.each([original, manga])('keeps full groups, dedicated artwork, source order and fee restrictions for %s', url => {
    const snapshot = validateCatalog(parseCatalog(catalogBody(), url), [definition]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.map(e => e.remoteId)).toEqual(['11', '50', '7', '80', '90']);
    expect(snapshot.groups.map(g => g.title)).toEqual(['连载', '番外']);
    expect(snapshot.entries[1].readable).toBe(false);
    expect(snapshot.entries[0].sequenceId).not.toBe(snapshot.entries[3].sequenceId);
    expect(snapshot.cover?.url).toBe('https://images.example/cover.jpg');
    expect(snapshot.defaultEntryId).toBe(snapshot.entries[0].id);
    for (const entry of snapshot.entries) expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
  });
  it.each(['slug', 'id', 'duplicate', 'group', 'missing', 'empty', 'latest', 'fee', 'order', 'restricted', 'cover'])('rejects %s catalog data', mode => {
    const info = comic();
    if (mode === 'slug') info.comicPy = 'foreign';
    if (mode === 'id') info.id = 43;
    if (mode === 'duplicate') info.chapterList[0].data.push(chapter(11, 40));
    if (mode === 'group') info.chapterList.push(info.chapterList[0]);
    if (mode === 'missing') Reflect.deleteProperty(info, 'chapterList');
    if (mode === 'empty') info.chapterList = [];
    if (mode === 'latest') info.lastUpdateChapterId = 999;
    if (mode === 'fee') Reflect.deleteProperty(info.chapterList[0].data[0], 'is_fee');
    if (mode === 'order') info.chapterList[0].data[0].chapter_order = -1;
    if (mode === 'restricted') info.canRead = false;
    if (mode === 'cover') info.cover = 'javascript:alert(1)';
    expect(() => parseCatalog(envelope({comicInfo: info}), mode === 'id' ? manga : original)).toThrow();
  });
  it('preserves duplicate image URLs and zero picnum without downloading/decrypting images', () => {
    const pages = validatePages(parsePages(pagesBody(), reader), definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({knownTotal: 3, discoveryComplete: true});
    expect(pages.items.map(item => item.order)).toEqual([0, 1, 2]);
    expect(pages.items.slice(0, 2).map(item => item.resource)).toEqual([{kind: 'http', url: imageUrl}, {kind: 'http', url: imageUrl}]);
    expect(pages.items[0].contentKey).toBeUndefined();
  });
  it.each(['comic', 'chapter', 'missing', 'empty', 'url', 'credentials', 'too-many', 'error', 'html'])('rejects %s chapter responses', mode => {
    const info = pageInfo();
    if (mode === 'comic') info.comic_id = 43;
    if (mode === 'chapter') info.chapter_id = 12;
    if (mode === 'missing') Reflect.deleteProperty(info, 'page_url');
    if (mode === 'empty') info.page_url = [];
    if (mode === 'url') info.page_url[0] = 'data:image/png;base64,AA';
    if (mode === 'credentials') info.page_url[0] = 'https://secret:password@images.example/page.jpg';
    if (mode === 'too-many') info.page_url = Array(1501).fill(imageUrl);
    const body = mode === 'error' ? '{"errno":403}' : mode === 'html' ? '<html>验证</html>' : envelope({chapterInfo: info});
    expect(() => parsePages(body, reader)).toThrow();
  });
  it('verifies catalog membership and free status before requesting the chapter; no extra requests/images', async () => {
    const request = vi.fn(async (url: string) => url.includes('/chapter/') ? pagesBody() : catalogBody());
    expect((await network.pages(reader, {request})).knownTotal).toBe(3);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/comic1/comic/detail', '/api/v1/comic1/chapter/detail']);
    for (const url of [reader.replace('/11', '/50'), reader.replace('/11', '/99'), reader.replace('/42/', '/43/'), reader.replace('fixture', 'foreign')]) {
      request.mockClear(); await expect(network.pages(url, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
    }
    request.mockClear(); await expect(network.pages(mangaReader.replace('fixture', 'wrong'), {request})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('aborts before and after HTTP without issuing a late chapter request', async () => {
    for (const operation of ['catalog', 'pages', 'search'] as const) {
      const run = (context: Parameters<typeof network.catalog>[1]) => operation === 'search'
        ? network.search({siteId: 'zaimanhua', query: 'test'}, context) : network[operation](operation === 'pages' ? reader : original, context);
      const controller = new AbortController(), request = vi.fn(async () => catalogBody()); controller.abort();
      await expect(run({request, signal: controller.signal})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
      const pending = new AbortController(), late = vi.fn(async () => {pending.abort(); return catalogBody();});
      await expect(run({request: late, signal: pending.signal})).rejects.toThrow(); expect(late).toHaveBeenCalledTimes(1);
    }
  });
  it('searches both content areas without reading catalogs and binds cursors to query/site', async () => {
    const input = {siteId: 'zaimanhua', query: '名称 & 漫画'}, rows = Array.from({length: 24}, (_, index) => ({id: index + 1,
      title: '作品 ' + index, comic_py: 'comic' + index, copyright: index % 2, authors: '作者', cover: 'https://images.example/cover.jpg', last_name: '第1话'}));
    const body = envelope({list: rows, page: 1, size: 24, total: 25});
    const request = vi.fn(async () => body), result = await network.search(input, {request});
    expect(request).toHaveBeenCalledTimes(1);
    expect(new URL(searchUrl(input)).searchParams.get('keyword')).toBe(input.query);
    expect(result.items[0].catalogUrl).toBe('https://manhua.zaimanhua.com/details/1');
    expect(result.items[1].catalogUrl).toBe('https://www.zaimanhua.com/info/comic1.html');
    expect(result.items[0].contentLanguages).toBeUndefined();
    const next = {...input, cursor: result.nextCursor};
    expect(new URL(searchUrl(next)).searchParams.get('page')).toBe('2');
    expect(parseSearch(envelope({list: [rows[0]], page: 2, size: 24, total: 25}), next).nextCursor).toBeUndefined();
    expect(() => searchUrl({...next, query: 'other'})).toThrow();
    expect(() => searchUrl({...next, siteId: 'zaimanhua-manga'})).toThrow();
    expect(() => parseSearch(envelope({list: [], page: 1, size: 24, total: 25}), input)).toThrow();
    expect(parseSearch(envelope({list: [], page: 1, size: 24, total: 0}), input).items).toEqual([]);
    rows[1] = rows[0]; expect(() => parseSearch(envelope({list: rows, page: 1, size: 24, total: 24}), input)).toThrow();
  });
  it('applies refresh once, preserves existing entries and leaves the catalog on failed refresh', async () => {
    const first = parseCatalog(catalogBody(), original), imported = await importCatalog(first);
    const before = await catalog.listEntries(imported.id, {limit: 10000});
    const position = {id: before[0].id, comicId: imported.id, entryId: before[0].id, contentId: before[0].contentId!, pageId: 'saved-page', relativeOffset: 0.4, updatedAt: 123};
    await catalog.put('positions', position);
    const updated = comic(); updated.chapterList[0].data.unshift(chapter(99, 50)); updated.lastUpdateChapterId = 99;
    const next = await network.catalog(original, {previous: first, request: async () => envelope({comicInfo: updated})});
    await applyCatalogRefresh(imported.id, imported.source.generation, next);
    await applyCatalogRefresh(imported.id, imported.source.generation, next);
    expect((await catalog.get('comics', imported.id))?.catalogUpdates?.count).toBe(1);
    for (const entry of before) expect(await catalog.get('entries', entry.id)).toMatchObject({id: entry.id, contentId: entry.contentId,
      sourceEntryId: entry.sourceEntryId, indexState: entry.indexState, generation: entry.generation});
    await expect(network.catalog(original, {previous: next, request: async () => '{"errno":403}'})).rejects.toThrow();
    expect((await catalog.get('catalogs', first.id))?.entries).toEqual(next.entries);
    expect(await catalog.get('positions', position.id)).toEqual(position);
  });
  it('parses a representative bounded 10000-entry catalog', () => {
    const info = comic(); info.chapterList = [{title: '连载', data: Array.from({length: 10000}, (_, i) => chapter(10000 - i, 10000 - i))}];
    info.lastUpdateChapterId = 10000;
    const body = envelope({comicInfo: info}), start = performance.now(), snapshot = parseCatalog(body, original);
    expect(snapshot.entries).toHaveLength(10000);
    console.log(JSON.stringify({adapter: 'zaimanhua', entries: snapshot.entries.length, jsonBytes: new TextEncoder().encode(body).length, parseMs: Math.round(performance.now() - start)}));
    info.chapterList[0].data.push(chapter(10001, 10001)); expect(() => parseCatalog(envelope({comicInfo: info}), original)).toThrow();
  });
});
