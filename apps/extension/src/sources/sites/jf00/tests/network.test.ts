import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {validateSourceCatalog, sourceFor} from '../../../index';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';
import {catalogHtml, readerHtml, searchHtml, url, reader, image, title} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('漫画猫 isolated HTTP adapter', () => {
  it('recognizes exact host, stable parent and chapter identities', () => {
    expect(sourceFor(url).location.catalog?.key).toBe('jf00:123');
    expect(sourceFor(reader).location).toMatchObject({pageKey: 'jf00:123:chapter:11', catalog: {url}});
    for (const bad of [url.replace('https:', 'http:'), url.replace('.com', '.com.evil.test'), url.replace('www.', 'user:pass@www.'), url.replace('.com', '.com:444')])
      expect(definition.identify(new URL(bad))).toBeNull();
    for (const bad of [url.replace('123', '0'), url.replace('comic_', 'unknown_'), reader.replace('_11.', '_01.')])
      expect(definition.identify(new URL(bad))?.kind).toBe('other');
    expect(definition.installation.optionalContentMatches).toEqual(['https://www.00jf.com/*']);
    expect(definition.sites![0].search).toBe(true);
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('keeps source oldest-first order and dedicated cover, including empty complete directories', () => {
    const value = validateSourceCatalog(parseCatalog(catalogHtml(), url));
    expect(value.title).toBe(title);
    expect(value.entries.map(e => e.remoteId)).toEqual(['11', '7', '50']);
    expect(value.groups[0].entryIds).toEqual(value.entries.map(e => e.id));
    for (const entry of value.entries) expect(entry.id).toBe(definition.identify(new URL(entry.url))?.pageKey);
    expect(value.cover?.url).toContain('/comic/cover/');
    expect(value.defaultEntryId).toBe(value.entries[0].id);
    expect(parseCatalog(catalogHtml([]), url)).toMatchObject({complete: true, entries: []});
    expect(parseCatalog(catalogHtml().replace('comic.5um.net', 'evil.test'), url).cover).toBeUndefined();
  });
  it.each(['duplicate', 'owner', 'canonical', 'foreign-link', 'unclosed-list', 'pagination', 'nested', 'ambiguous'])('rejects %s directory', mode => {
    let html = catalogHtml();
    if (mode === 'duplicate') html = catalogHtml(['11', '11']);
    if (mode === 'owner') html = html.replace('/chapter_123_7', '/chapter_456_7');
    if (mode === 'canonical') html = html.replace('href="' + url, 'href="' + url.replace('123', '456'));
    if (mode === 'foreign-link') html = html.replace('/chapter_123_7.html', 'https://evil.test/chapter_123_7.html');
    if (mode === 'unclosed-list') html = html.replace('</a></div>', '</a>');
    if (mode === 'pagination') html = html.replace('</a></div>', '</a></div><a href="?page=2">Next</a>');
    if (mode === 'nested') html = html.replace('Chapter 7 &amp; title', '<div>Chapter 7</div>');
    if (mode === 'ambiguous') html += html;
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('keeps duplicated URLs in distinct stable slots with complete source markup', () => {
    const value = parsePages(readerHtml(), reader);
    expect(value).toMatchObject({adapter: 'jf00', discoveryComplete: true, knownTotal: 2, title: 'Chapter 11'});
    expect(value.items.map(p => [p.id, p.order, p.resource])).toEqual([
      ['page-0', 0, {kind: 'http', url: image}], ['page-1', 1, {kind: 'http', url: image}],
    ]);
  });
  it.each(['empty', 'gap', 'owner', 'chapter', 'canonical', 'host', 'cover', 'mixed-directory', 'private', 'unclosed', 'extra', 'ambiguous'])('rejects %s reader before indexing', mode => {
    let html = readerHtml();
    if (mode === 'empty') html = readerHtml([]);
    if (mode === 'gap') html = html.replace('第2张图', '第3张图');
    if (mode === 'owner') html = html.replace('www.00jf.com/comic_123.html', 'www.00jf.com/comic_456.html');
    if (mode === 'chapter') html = html.replace('readPic(123,11', 'readPic(123,12');
    if (mode === 'canonical') html = html.replace('href="www.00jf.com/chapter_123_11.html', 'href="www.00jf.com/chapter_123_12.html');
    if (mode === 'host') html = html.replaceAll('manhua.5um.net', 'manhua.5um.net.evil.test');
    if (mode === 'cover') html = html.replaceAll(image, 'https://comic.5um.net/comic/cover/one.webp');
    if (mode === 'mixed-directory') html = readerHtml([image, image.replace('/1/', '/2/')]);
    if (mode === 'private') html = html.replace('readPic(123,11,0,0)', 'readPic(123,11,1,0)');
    if (mode === 'unclosed') html = html.replace('</div>', '');
    if (mode === 'extra') html = html.replace('</div>', '<p>Loading more</p></div>');
    if (mode === 'ambiguous') html += html;
    expect(() => parsePages(html, reader)).toThrow();
  });
  it('uses full search titles, source count and exact bound pagination without language inference', () => {
    const request = {siteId: 'jf00', query: 'Work'};
    expect(searchUrl(request).url).toBe('https://www.00jf.com/search?key=Work');
    const first = parseSearch(searchHtml('Work', 44), request);
    expect(first.items).toHaveLength(30); expect(first.nextCursor).toBe('page:2');
    expect(first.items[0]).toMatchObject({catalogId: 'jf00:1', title: 'Work 0 long title', authors: ['Author 0']});
    expect(first.items[0].contentLanguages).toBeUndefined();
    const second = parseSearch(searchHtml('Work', 44, 2), {...request, cursor: first.nextCursor});
    expect(second.items).toHaveLength(14); expect(second.nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml('Work', 0), request)).toEqual({items: []});
    expect(() => parseSearch(searchHtml('Different', 2), request)).toThrow();
    expect(() => parseSearch(searchHtml().replace('共2部漫画', '共3部漫画'), request)).toThrow();
    expect(() => parseSearch(searchHtml().replaceAll('/comic_2.html', '/comic_1.html'), request)).toThrow();
    expect(() => parseSearch(searchHtml().replace('/search/Work', '/search/Other'), request)).toThrow();
    expect(() => parseSearch(searchHtml().replaceAll('/comic_1.html', 'https://evil.test/comic_1.html'), request)).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test'})).toThrow();
    expect(() => searchUrl({...request, siteId: 'different'})).toThrow();
  });
  it('checks cancellation before and after each HTTP operation, without loading another source tab', async () => {
    for (const operation of ['catalog', 'pages', 'search'] as const) {
      const target = operation === 'catalog' ? url : operation === 'pages' ? reader : {siteId: 'jf00', query: 'Work'};
      const call = network[operation] as (input: typeof target, context: {signal: AbortSignal; request: () => Promise<string>}) => Promise<unknown>;
      const controller = new AbortController(), request = vi.fn(async () => readerHtml()); controller.abort();
      await expect(call(target, {request, signal: controller.signal})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
      const pending = new AbortController();
      await expect(call(target, {signal: pending.signal, request: async () => {pending.abort(); return readerHtml();}})).rejects.toThrow();
    }
    const requested: string[] = [];
    await network.catalog(url + '?tracking=1', {request: async target => {requested.push(target); return catalogHtml();}});
    await network.pages(reader + '?tracking=1', {request: async target => {requested.push(target); return readerHtml();}});
    expect(requested).toEqual([url, reader]);
  });
  it('updates once and leaves existing reading state and complete directory after failed refresh', async () => {
    const first = parseCatalog(catalogHtml(), url), comic = await importCatalog(first);
    const old = await catalog.list('entries', {index: 'comicId', range: comic.id});
    const next = await network.catalog(url, {request: async () => catalogHtml(['11', '7', '50', '20']), previous: first});
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count).toBe(1);
    for (const entry of old) expect(await catalog.get('entries', entry.id)).toEqual(entry);
    await expect(network.catalog(url, {request: async () => catalogHtml(['11', '11']), previous: next})).rejects.toThrow();
    expect((await catalog.get('catalogs', first.id))?.entries).toEqual(next.entries);
  });
});
