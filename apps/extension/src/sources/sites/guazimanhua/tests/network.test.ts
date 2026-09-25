import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl} from '../definition';
import {network, parseCatalog, parsePages, parseReaderCatalogUrl} from '../network';
import {validateSourceCatalog, discoverEntry, sourceFor} from '../../../index';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {resolveNetworkCatalog} from '../../../runtime/network';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';
import {catalogHtml, image, reader, readerHtml, url} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('瓜子漫画 HTTP adapter', () => {
  it('recognizes precise hosts and IDs, preserves chapter identity with a verified parent fragment', () => {
    expect(sourceFor(url).location.catalog?.key).toBe('guazimanhua:123');
    expect(definition.identify(new URL(reader))?.pageKey).toBe('guazimanhua:chapter:11');
    expect(definition.identify(new URL(chapterUrl('11', '123')))?.catalog?.key).toBe('guazimanhua:123');
    for (const bad of [url.replace('https:', 'http:'), url.replace('.com', '.com.evil.test'), url.replace('www.', 'user:pass@www.'), url.replace('.com', '.com:444')])
      expect(definition.identify(new URL(bad))).toBeNull();
    for (const bad of [url + '&id=321', url.replace('123', '0'), url.replace('/comic.php', '/unknown.php'), reader + '#nodelane-guazimanhua=bad'])
      expect(definition.identify(new URL(bad))?.kind).toBe('other');
    expect(definition.installation.requiredOrigins).toEqual([]);
    expect(definition.installation.autoContentMatches).toEqual([]);
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('reads the full newest-first catalog in reading order with a dedicated cover', () => {
    const value = validateSourceCatalog(parseCatalog(catalogHtml(), url));
    expect(value.entries.map(e => e.remoteId)).toEqual(['11', '7', '50']);
    expect(value.entries[0].title).toBe('Chapter 11 & title');
    for (const entry of value.entries) expect(entry.id).toBe(definition.identify(new URL(entry.url))?.pageKey);
    expect(value.cover?.url).toContain('/comics/cover/');
    expect(value.groups[0].entryIds).toEqual(value.entries.map(e => e.id));
    expect(value.defaultEntryId).toBe(value.entries[0].id);
    expect(value.complete).toBe(true);
    expect(parseCatalog(catalogHtml([]), url).entries).toEqual([]);
  });
  it.each(['truncated', 'duplicate', 'owner', 'canonical', 'foreign-link', 'missing-count', 'unclosed-list'])('rejects %s catalog before replacing stored data', mode => {
    let html = catalogHtml();
    if (mode === 'truncated') html = catalogHtml(['11'], 2);
    if (mode === 'duplicate') html = catalogHtml(['11', '11']);
    if (mode === 'owner') html = html.replace('"url":"' + url, '"url":"' + url.replace('123', '456'));
    if (mode === 'canonical') html = html.replace('href="' + url, 'href="' + url.replace('123', '456'));
    if (mode === 'foreign-link') html = html.replace('/chapter.php?id=7', 'https://evil.test/chapter.php?id=7');
    if (mode === 'missing-count') html = html.replace('章节总数', '预览章节');
    if (mode === 'unclosed-list') html = html.replace('</a></div>', '</a>');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('preserves duplicate image URLs in distinct slots and verifies both full image lists', () => {
    const value = parsePages(readerHtml(), chapterUrl('11', '123'));
    expect(value).toMatchObject({knownTotal: 2, discoveryComplete: true, adapter: 'guazimanhua'});
    expect(value.items.map(i => [i.id, i.order, i.resource])).toEqual([
      ['page-0', 0, {kind: 'http', url: image}], ['page-1', 1, {kind: 'http', url: image}],
    ]);
    expect(parseReaderCatalogUrl(readerHtml(), reader)).toBe(url);
    expect(() => parsePages(readerHtml(), chapterUrl('11', '456'))).toThrow('不属于');
  });
  it('uses the complete reader after the 20-image SEO preview, rejecting missing or reordered later pages', () => {
    const html = readerHtml(Array(59).fill(image));
    expect(parsePages(html, reader).knownTotal).toBe(59);
    expect(() => parsePages(html.replace('data-page="59"', 'data-page="60"'), reader)).toThrow();
    expect(() => parsePages(html.replace(/<img class="reading-image" id="page-59"[^>]+>/, ''), reader)).toThrow();
  });
  it.each(['empty', 'total', 'position', 'dom-order', 'dom-missing', 'host', 'cover', 'canonical', 'chapter', 'parent', 'ambiguous'])('rejects %s reader data', mode => {
    let html = readerHtml();
    if (mode === 'empty') html = readerHtml([]);
    if (mode === 'total') html = html.replace('"numberOfItems":2', '"numberOfItems":3');
    if (mode === 'position') html = html.replace('"position":2', '"position":1');
    if (mode === 'dom-order') html = html.replace('data-page="2"', 'data-page="1"');
    if (mode === 'dom-missing') html = html.replace(/<img class="reading-image"[^>]+>/, '');
    if (mode === 'host') html = html.replaceAll('img.guazicdn.com', 'img.guazicdn.com.evil.test');
    if (mode === 'cover') html = html.replaceAll('/comics/chapters/', '/comics/cover/');
    if (mode === 'canonical') html = html.replace('href="' + reader, 'href="' + reader.replace('11', '12'));
    if (mode === 'chapter') html = html.replace('"url":"' + reader, '"url":"' + reader.replace('11', '12'));
    if (mode === 'parent') html = html.replaceAll(url, 'https://evil.test/comic.php?id=123');
    if (mode === 'ambiguous') html += html;
    expect(() => parsePages(html, reader)).toThrow();
  });
  it('reads, resolves and refreshes using HTTP without source tabs; aborts before and after requests', async () => {
    const create = vi.fn(), records: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {runtime: {id: 'test'}, tabs: {create}, storage: {local: {
      get: async (key: string) => ({[key]: records[key]}), set: async (values: object) => Object.assign(records, values),
    }}});
    const fetcher = vi.fn(async (target: string, init: RequestInit) => {
      expect(init.credentials).toBe('include'); expect(init.redirect).toBe('error');
      expect(target).not.toContain('#');
      return new Response(target.includes('chapter.php') ? readerHtml() : catalogHtml());
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await resolveNetworkCatalog(reader)).toBe(url);
    const source = await readSourceCatalog(url), progress = vi.fn();
    const manifest = await discoverEntry(source, source.entries[0].id, new AbortController().signal, progress);
    expect(manifest.pageContext).toBeUndefined();
    expect(records['manifest:' + manifest.id]).toEqual(manifest);
    await readSourceCatalog(url, {previous: source});
    expect(create).not.toHaveBeenCalled();
    for (const operation of ['catalog', 'pages', 'resolveCatalog'] as const) {
      const target = operation === 'catalog' ? url : reader, controller = new AbortController(), request = vi.fn(async () => readerHtml());
      controller.abort();
      await expect(network[operation](target, {request, signal: controller.signal})).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      const inFlight = new AbortController();
      await expect(network[operation](target, {signal: inFlight.signal, request: async () => {inFlight.abort(); return readerHtml();}})).rejects.toThrow();
    }
  });
  it('applies updates once, preserves reading state and retains old directory after failed refresh', async () => {
    const first = parseCatalog(catalogHtml(), url), comic = await importCatalog(first);
    const old = await catalog.list('entries', {index: 'comicId', range: comic.id});
    const next = await network.catalog(url, {request: async () => catalogHtml(['11', '7', '50', '20']), previous: first});
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count).toBe(1);
    for (const entry of old) expect(await catalog.get('entries', entry.id)).toEqual(entry);
    await expect(network.catalog(url, {request: async () => catalogHtml(['11'], 10), previous: next})).rejects.toThrow();
    expect((await catalog.get('catalogs', first.id))?.entries).toEqual(next.entries);
  });
});
