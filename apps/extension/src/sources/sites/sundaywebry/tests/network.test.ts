import {describe, expect, it, vi} from 'vitest';
import {definition, episodeUrl} from '../definition';
import {network} from '../network';
import {parsePages} from '../pages';
import {episodeData, parseReader} from '../protocol';
import {parseSearch} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchPage} from '../../../core/search';
import {entry, imageUrl, info, readerData, readerHtml, searchHtml, workUrl} from './fixtures';

const query = {siteId: 'sundaywebry', query: 'テスト'};
function fixture() {
  const request = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/episode/')) return readerHtml();
    if (u.pathname.endsWith('/readable_product_pagination_information')) return JSON.stringify(info);
    if (u.pathname.endsWith('/pagination_readable_products')) return JSON.stringify(u.searchParams.get('offset') === '0' ? [entry('11'), entry('12', false)] : [entry('13')]);
    throw Error('unexpected request');
  });
  return {request};
}
describe('Sunday Webry identity and catalogs', () => {
  it('discovers static registration metadata and separates embedded catalog identity from episode links', () => {
    expect(definition.identify(new URL(workUrl))?.catalog?.key).toBe('sundaywebry:series:7');
    expect(definition.identify(new URL(episodeUrl('11')))?.catalog).toBeUndefined();
    expect(definition.identify(new URL(episodeUrl('11', '7')))?.kind).toBe('reader');
    for (const url of ['http://www.sunday-webry.com/episode/11', 'https://www.sunday-webry.com.evil.test/episode/11',
      'https://x@www.sunday-webry.com/episode/11', 'https://www.sunday-webry.com:8443/episode/11']) expect(definition.identify(new URL(url))).toBeNull();
    for (const path of ['/episode/11.json', '/episode/no', '/series/7', '/episode/11#nodelane-webry=evil'])
      expect(definition.identify(new URL('https://www.sunday-webry.com' + path))?.kind).toBe('other');
  });
  it('resolves parent identity, paginates in source order, keeps locked entries, and rechecks a full snapshot', async () => {
    const context = fixture();
    expect(await network.resolveCatalog(episodeUrl('11'), context)).toBe(workUrl);
    const catalog = validateCatalog(await network.catalog(workUrl, context), [definition]);
    expect(catalog.entries.map(e => [e.remoteId, e.order, e.readable])).toEqual([['11', 0, true], ['12', 1, false], ['13', 2, true]]);
    expect(catalog.title).toBe('テスト作品'); expect(catalog.defaultEntryId).toBe(catalog.entries[0].id);
    expect(context.request.mock.calls.filter(([url]) => url.includes('offset=0'))).toHaveLength(2);
    expect(catalog.complete).toBe(true); expect(catalog.cover?.url).toContain('series-thumbnail/7-');
  });
  it.each(['duplicate', 'partial', 'foreign', 'changed'])('rejects %s catalogs without changing the previous snapshot', async mode => {
    const context = fixture(), previous = await network.catalog(workUrl, context), before = structuredClone(previous);
    const original = context.request.getMockImplementation()!; let reads = 0;
    context.request.mockImplementation(async url => {
      if (url.includes('offset=2')) return JSON.stringify(mode === 'duplicate' ? [entry('11')] : mode === 'partial' ? [] :
        mode === 'foreign' ? [{...entry('13'), viewer_uri: 'https://evil.test/episode/13'}] : [entry('13')]);
      if (mode === 'changed' && url.includes('readable_product_pagination_information') && ++reads > 1)
        return JSON.stringify({...info, readable_products_count: 4});
      return original(url);
    });
    await expect(network.catalog(workUrl, {...context, previous})).rejects.toThrow(); expect(previous).toEqual(before);
  });
  it('rejects forged bindings, missing parent membership, and cancellation', async () => {
    expect(() => parseReader(readerHtml(), episodeUrl('11', '8'))).toThrow();
    expect(() => parseReader(readerHtml(), episodeUrl('12'))).toThrow();
    expect(() => episodeData(readerHtml() + readerHtml())).toThrow();
    const context = fixture(), controller = new AbortController(); controller.abort();
    await expect(network.catalog(workUrl, {...context, signal: controller.signal})).rejects.toThrow();
    expect(context.request).not.toHaveBeenCalled();
    const late = new AbortController();
    context.request.mockImplementation(async () => {late.abort(); return readerHtml();});
    await expect(network.pages(episodeUrl('11'), {...context, signal: late.signal})).rejects.toThrow();
  });
});
describe('Sunday Webry pages and search', () => {
  it('keeps duplicate image URLs as separate page slots and removes ads without reordering source pages', () => {
    const location = definition.identify(new URL(episodeUrl('11')))!;
    const snapshot = validatePages(parsePages(readerData(), location.url), location);
    expect(snapshot.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-2', 1]]);
    expect(snapshot.knownTotal).toBe(2); expect(snapshot.items[0].resource).toEqual({kind: 'http', url: imageUrl, processing: 'webry-baku:67:99'});
  });
  it.each(['host', 'missing', 'protocol', 'dimensions', 'type', 'locked'])('fails closed on %s page data', mode => {
    const data = readerData();
    if (mode === 'host') data.readableProduct.pageStructure.pages[0].src = 'https://evil.test/a';
    if (mode === 'missing') delete data.readableProduct.pageStructure.pages[0].src;
    if (mode === 'protocol') data.readableProduct.pageStructure.choJuGiga = 'unknown';
    if (mode === 'dimensions') data.readableProduct.pageStructure.pages[0].width = Number.MAX_SAFE_INTEGER + 1;
    if (mode === 'type') data.readableProduct.pageStructure.pages[0].type = 'unknown';
    if (mode === 'locked') Object.assign(data.readableProduct, {pageStructure: null});
    expect(() => parsePages(data, episodeUrl('11'))).toThrow();
  });
  it('preserves large source dimensions while validating page identity and order', () => {
    const data = readerData();
    Object.assign(data.readableProduct.pageStructure.pages[0], {width: 20001, height: 20001});
    expect(parsePages(data, episodeUrl('11')).items[0]).toMatchObject({width: 20001, height: 20001});
  });
  it('returns source work metadata, bounded search pages and a query-bound cursor', async () => {
    const html = searchHtml(query.query, Array.from({length: 51}, (_, i) => String(i + 1)));
    const first = await parseSearch(html, query), second = await parseSearch(html, {...query, cursor: first.nextCursor});
    expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(50);
    expect(first.nextCursor!.length).toBeLessThan(4096); expect(second.items).toHaveLength(1);
    expect(second.items[0].authors).toEqual(['作者']); expect(second.items[0].contentLanguages).toBeUndefined();
    await expect(parseSearch(searchHtml(), {...query, cursor: first.nextCursor})).rejects.toThrow();
    await expect(parseSearch(html, {...query, query: '別の検索', cursor: first.nextCursor})).rejects.toThrow();
    expect((await parseSearch(searchHtml(query.query, []), query)).items).toEqual([]);
    await expect(parseSearch('<h1>404</h1>', query)).rejects.toThrow();
  });
  it('explicitly accepts only the source search 404 and verifies its empty-result document', async () => {
    const request = vi.fn(async () => searchHtml(query.query, []));
    expect(await network.search(query, {request})).toEqual({items: []});
    expect(request.mock.calls[0]).toEqual([expect.stringContaining('/search?q='), {referer: 'https://www.sunday-webry.com/search', acceptStatuses: [404]}]);
  });
});
