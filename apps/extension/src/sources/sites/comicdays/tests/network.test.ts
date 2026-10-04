import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchCapability, validateSearchPage} from '../../../core/search';
import {sourceNetworks} from '../../../registry/networks';
import {catalogUrl, definition} from '../definition';
import {network, parseEntries, parseInfo} from '../network';
import {parsePages} from '../pages';
import {coverUrl, parseReader} from '../protocol';
import {parseSearch} from '../search';
import {cover, entry, episodeUrl, imageUrl, info, readerData, readerHtml, searchHtml, workUrl} from './fixtures';

const query = {siteId: 'comicdays', query: 'テスト'};
function fixture() {
  const request = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/series/')) throw Error('redirect:error rejects the official first_episode redirect');
    if (u.pathname.startsWith('/episode/')) return readerHtml();
    if (u.pathname.endsWith('/readable_product_pagination_information')) return JSON.stringify(info);
    if (u.pathname.endsWith('/pagination_readable_products'))
      return JSON.stringify(u.searchParams.get('offset') === '0' ? [entry('11'), entry('12', false)] : [entry('13')]);
    throw Error('unexpected request');
  });
  return {request};
}

describe('Comic DAYS catalog identity and pagination', () => {
  it('registers network capabilities and binds a series separately from naked episode URLs', () => {
    expect(sourceNetworks.comicdays).toBe(network);
    expect(validateSearchCapability(definition, definition.sites![0])).toEqual({requestOrigins: ['https://comic-days.com/*']});
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', pageKey: 'comicdays:series:7',
      catalog: {key: 'comicdays:series:7', url: workUrl}});
    expect(definition.identify(new URL(episodeUrl()))?.catalog).toBeUndefined();
    expect(definition.identify(new URL(episodeUrl('11', '7')))).toMatchObject({kind: 'reader', pageKey: 'comicdays:episode:11',
      catalog: {key: 'comicdays:series:7', url: workUrl}});
    for (const path of ['/series/7', '/series/0/first_episode', '/series/7/first_episode/extra', '/episode/11#nodelane-days=evil'])
      expect(definition.identify(new URL('https://comic-days.com' + path))?.kind).toBe('other');
  });
  it('resolves parent series, preserves locked entries and returns a validated complete snapshot in reading order', async () => {
    const context = fixture();
    expect(await network.resolveCatalog(episodeUrl(), context)).toBe(workUrl);
    const catalog = validateCatalog(await network.catalog(workUrl, context), [definition]);
    expect(catalog).toMatchObject({id: 'comicdays:series:7', title: 'テスト作品', complete: true, cover: {url: cover},
      defaultEntryId: 'comicdays:episode:11'});
    expect(catalog.entries.map(e => [e.remoteId, e.order, e.readable])).toEqual([['11', 0, true], ['12', 1, false], ['13', 2, true]]);
    expect(catalog.entries.every(e => e.catalogId === catalog.id && e.sequenceId === catalog.id && e.contentLanguage === undefined)).toBe(true);
    expect(context.request.mock.calls.every(([url]) => !new URL(url).pathname.includes('/first_episode'))).toBe(true);
    const infoRequests = context.request.mock.calls.filter(([url]) => url.includes('/readable_product_pagination_information'));
    expect(infoRequests).not.toHaveLength(0);
    expect(infoRequests.every(([url]) => {
      const params = new URL(url).searchParams;
      return params.get('aggregate_id') === '7' && !params.has('readable_product_id');
    })).toBe(true);
    const pages = context.request.mock.calls.filter(([url]) => url.includes('/pagination_readable_products'));
    expect(pages.every(([url]) => {
      const params = new URL(url).searchParams;
      return params.get('aggregate_id') === '7' && params.get('sort_order') === 'asc' && params.get('limit') === '2';
    })).toBe(true);
    expect(pages.filter(([url]) => new URL(url).searchParams.get('offset') === '0')).toHaveLength(2);
    expect(pages.filter(([url]) => new URL(url).searchParams.get('offset') === '2')).toHaveLength(2);
  });
  it.each(['duplicate', 'partial', 'foreign', 'changed', 'first-changed', 'last-changed', 'mismatched-seed'])
    ('rejects %s catalog and preserves the prior snapshot', async mode => {
      const context = fixture(), previous = await network.catalog(workUrl, context), before = structuredClone(previous);
      const original = context.request.getMockImplementation()!;
      let reads = 0, firstReads = 0, lastReads = 0;
      context.request.mockImplementation(async url => {
        if (url.includes('/pagination_readable_products') && new URL(url).searchParams.get('offset') === '2') {
          ++lastReads;
          return JSON.stringify(mode === 'duplicate' ? [entry('11')] : mode === 'partial' ? [] :
            mode === 'foreign' ? [{...entry('13'), viewer_uri: 'https://evil.test/episode/13'}] :
            mode === 'last-changed' && lastReads > 1 ? [entry('14')] : [entry('13')]);
        }
        if (url.includes('/pagination_readable_products') && new URL(url).searchParams.get('offset') === '0') {
          ++firstReads;
          if (mode === 'mismatched-seed') return JSON.stringify([entry('10'), entry('12', false)]);
          if (mode === 'first-changed' && firstReads > 1) return JSON.stringify([entry('10'), entry('12', false)]);
        }
        if (mode === 'changed' && url.includes('readable_product_pagination_information') && ++reads > 1)
          return JSON.stringify({...info, readable_products_count: 4});
        return original(url);
      });
      await expect(network.catalog(workUrl, {...context, previous})).rejects.toThrow();
      expect(previous).toEqual(before);
    });
  it('validates count limits and entry ownership before marking a directory complete', () => {
    for (const changed of [{...info, readable_products_count: 0}, {...info, readable_products_count: 10001},
      {...info, per_page: 0}, {...info, per_page: 1001}, {...info, per_page: 1.5}, {...info, type: 'cursor'}])
      expect(() => parseInfo(JSON.stringify(changed))).toThrow();
    expect(() => parseInfo('{')).toThrow();
    expect(() => parseEntries(JSON.stringify([{...entry('11'), viewer_uri: episodeUrl('12')}]), '7', 0)).toThrow();
    expect(() => parseEntries(JSON.stringify([{...entry('11'), purchase_info: {can_read: 'true'}}]), '7', 0)).toThrow();
    expect(() => parseEntries(JSON.stringify([{...entry('11'), viewer_uri: episodeUrl('11', '8')}]), '7', 0)).toThrow();
  });
  it('rejects mismatched canonical, episode and series identities and duplicate metadata', () => {
    expect(() => parseReader(readerHtml(), episodeUrl('12'))).toThrow();
    expect(() => parseReader(readerHtml(), episodeUrl('11', '8'))).toThrow();
    expect(() => parseReader(readerHtml(), catalogUrl('8'))).toThrow();
    expect(() => parseReader(readerHtml().replace('rel="canonical"', 'rel="other"'), episodeUrl())).toThrow();
    expect(() => parseReader(readerHtml().replace(episodeUrl() + '"', episodeUrl('12') + '"'), episodeUrl())).toThrow();
    expect(() => parseReader(readerHtml() + readerHtml(), episodeUrl())).toThrow();
  });
  it('accepts only owned series artwork and unwraps the source image proxy', () => {
    expect(coverUrl(cover, '7')).toEqual({url: cover, series: '7'});
    expect(coverUrl('https://cdn-scissors.gigaviewer.com/image/scale=200/' + encodeURIComponent(cover), '7'))
      .toEqual({url: cover, series: '7'});
    for (const value of [cover.replace('.com/', '.com.evil.test/'), cover.replace('https:', 'http:'),
      cover.replace('https://', 'https://user:secret@'), imageUrl,
      'https://cdn-scissors.gigaviewer.com/image/' + encodeURIComponent('https://evil.test/public/series-thumbnail/7-abcdef')])
      expect(() => coverUrl(value, '7')).toThrow();
    expect(() => coverUrl(cover, '8')).toThrow();
  });
  it('honors cancellation before and after HTTP and keeps request failures visible', async () => {
    const context = fixture(), controller = new AbortController(); controller.abort(Error('cancelled'));
    await expect(network.catalog(workUrl, {...context, signal: controller.signal})).rejects.toThrow('cancelled');
    expect(context.request).not.toHaveBeenCalled();
    const late = new AbortController();
    context.request.mockImplementation(async () => {late.abort(Error('stopped')); return readerHtml();});
    await expect(network.pages(episodeUrl(), {...context, signal: late.signal})).rejects.toThrow('stopped');
    context.request.mockRejectedValue(Error('HTTP 503'));
    await expect(network.catalog(workUrl, context)).rejects.toThrow('HTTP 503');
    await expect(network.resolveCatalog(episodeUrl(), context)).rejects.toThrow('HTTP 503');
  });
});

describe('Comic DAYS complete HTTP pages and search', () => {
  it('reads current episode metadata over HTTP and retains duplicate URLs as distinct ordered slots', async () => {
    const context = fixture(), location = definition.identify(new URL(episodeUrl()))!;
    const snapshot = validatePages(await network.pages(episodeUrl(), context), location);
    expect(snapshot).toMatchObject({discoveryComplete: true, knownTotal: 2, direction: 'rtl', title: 'テスト話'});
    expect(snapshot.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-2', 1]]);
    expect(snapshot.items[0].resource).toEqual({kind: 'http', url: imageUrl, processing: 'gigaviewer-baku:1125:1600'});
    expect(context.request).toHaveBeenCalledExactlyOnceWith(episodeUrl(), undefined);
  });
  it.each(['host', 'missing', 'protocol', 'dimensions', 'type', 'locked'])('rejects %s page data', mode => {
    const data = readerData();
    if (mode === 'host') data.readableProduct.pageStructure.pages[0].src = 'https://evil.test/a';
    if (mode === 'missing') delete data.readableProduct.pageStructure.pages[0].src;
    if (mode === 'protocol') data.readableProduct.pageStructure.choJuGiga = 'unknown';
    if (mode === 'dimensions') data.readableProduct.pageStructure.pages[0].width = Number.MAX_SAFE_INTEGER + 1;
    if (mode === 'type') data.readableProduct.pageStructure.pages[0].type = 'unknown';
    if (mode === 'locked') Object.assign(data.readableProduct, {pageStructure: null});
    expect(() => parsePages(data, episodeUrl())).toThrow();
  });
  it('reports an unavailable chapter without returning an empty complete page list', async () => {
    const locked = readerData(); Object.assign(locked.readableProduct, {pageStructure: null});
    const request = vi.fn(async () => readerHtml(locked));
    await expect(network.pages(episodeUrl(), {request})).rejects.toThrow('当前不可读取');
  });
  it('paginates bounded search results with a query and result-bound cursor and keeps source metadata', async () => {
    const html = searchHtml(query.query, Array.from({length: 51}, (_, i) => String(i + 1)));
    const first = await parseSearch(html, query), second = await parseSearch(html, {...query, cursor: first.nextCursor});
    expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(50);
    expect(first.nextCursor!.length).toBeLessThan(4096);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({catalogId: 'comicdays:series:51', catalogUrl: catalogUrl('51'), authors: ['作者']});
    expect(second.items[0].contentLanguages).toBeUndefined();
    await expect(parseSearch(searchHtml(), {...query, cursor: first.nextCursor})).rejects.toThrow();
    await expect(parseSearch(html, {...query, query: '別の検索', cursor: first.nextCursor})).rejects.toThrow();
    expect((await parseSearch(searchHtml(query.query, []), query)).items).toEqual([]);
    await expect(parseSearch('<h1>404</h1>', query)).rejects.toThrow();
  });
  it('accepts a search 404 only when the page confirms the requested query and empty results', async () => {
    const request = vi.fn(async () => searchHtml(query.query, []));
    expect(await network.search(query, {request})).toEqual({items: []});
    expect(request.mock.calls[0]).toEqual([expect.stringContaining('/search?q='),
      {referer: 'https://comic-days.com/search', acceptStatuses: [404]}]);
    request.mockResolvedValue('<h1>404</h1>');
    await expect(network.search(query, {request})).rejects.toThrow();
  });
});
