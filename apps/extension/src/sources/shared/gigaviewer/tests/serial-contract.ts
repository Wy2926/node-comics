import {describe, expect, it, vi} from 'vitest';
import type {SourceDefinition} from '../../../contracts/definition';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchCapability, validateSearchPage} from '../../../core/search';
import {sourceNetworks} from '../../../registry/networks';
import {gigaViewerSerialNetwork} from '../serial-network';
import {gigaViewerSerialSearch, type GigaViewerSearchMarkup} from '../serial-search';
import type {GigaViewerSerialProtocol} from '../serial-protocol';

export function verifySerialSite(definition: SourceDefinition, protocol: GigaViewerSerialProtocol,
  network: ReturnType<typeof gigaViewerSerialNetwork>['network'] & ReturnType<typeof gigaViewerSerialSearch>,
  cdn: string, route: GigaViewerSearchMarkup, mixed: boolean, adaptedOn = '2026-10-23') {
  const {sourceId, origin, catalogUrl, episodeUrl} = protocol;
  const work = catalogUrl('7'), chapter = episodeUrl('11', '7'), query = {siteId: sourceId, query: '作品'};
  const image = `${cdn}/public/page/2/900-abcdef`, cover = `${cdn}/public/series-thumbnail/7-abcdef`;
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const data = (series = '7') => ({readableProduct: {id: '11', typeName: 'episode', permalink: episodeUrl('11'), title: '第1話',
    series: {id: series, title: '作品', thumbnailUri: cover}, pageStructure: {choJuGiga: 'baku', readingDirection: 'rtl',
      pages: [{type: 'main', src: image, width: 1125, height: 1600}, {type: 'link'},
        {type: 'main', src: image, width: 1125, height: 1600}]}}});
  const reader = (value = data()) => `<link rel="canonical" href="${episodeUrl('11')}"><script id='episode-json' data-value='${escape(JSON.stringify(value))}'></script>`;
  const entry = (id: string, readable = true) => ({readable_product_id: id, title: `第${id}話`,
    viewer_uri: episodeUrl(id), purchase_info: {can_read: readable}});
  const ssr = typeof route !== 'string';
  const searchRow = (id: string, target = episodeUrl('11'), thumbnail = 'series') => ssr ?
    `<li class="SearchResultItem_li__abc"><div><a href="${target}"><img src="${cdn}/public/${thumbnail}-thumbnail/${id}-abcdef"></a></div><div><p class="SearchResultItem_series_title__abc">作品 ${id}</p><p class="SearchResultItem_author__abc">作者</p><a class="SearchResultItem_main_link__abc" href="${target}">1話</a><a class="SearchResultItem_sub_link__abc" href="${target}">最新話</a></div></li>` :
    `<li data-title="作品 ${id}"><img src="${cdn}/public/${thumbnail}-thumbnail/${id}-abcdef"><p class="author">作者</p><a class="main-link" href="${target}">1話</a></li>`;
  const search = (ids = ['7'], other = '') => ssr ?
    `<html data-media-name="${route.mediaName}"><input name="q" value="作品"><ul class="SearchResult_search_result_list__abc">${ids.map(id => searchRow(id)).join('')}${other}${!ids.length && !other ? '<li class="SearchResult_list_empty_li__abc"><p>作品が見つかりませんでした</p></li>' : ''}</ul></html>` :
    `<html data-route="${route}"><input name="q" value="作品"><ul class="${ids.length || other ? mixed ? 'search-series-list' : 'series-list' : 'list-empty'}">${ids.map(id => searchRow(id)).join('')}${other}</ul></html>`;
  function context() {
    const request = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.origin).toBe(origin);
      if (u.pathname.startsWith('/episode/')) return reader();
      if (u.pathname.endsWith('/readable_product_pagination_information')) return JSON.stringify({type: 'number', per_page: 2, readable_products_count: 3});
      if (u.pathname.endsWith('/pagination_readable_products')) return JSON.stringify(u.searchParams.get('offset') === '0' ? [entry('11'), entry('12', false)] : [entry('13')]);
      if (u.pathname === '/search') return search();
      throw Error('Unexpected request');
    });
    return {request};
  }
  describe(`${sourceId} verified serial contract`, () => {
    it('registers explicit Japanese raw metadata, install scope, catalog sync and network search', () => {
      expect(sourceNetworks[sourceId]).toBe(network);
      expect(validateSearchCapability(definition, definition.sites![0])).toBe(true);
      expect(definition.sites![0]).toMatchObject({isRaw: true, primaryLanguages: ['ja'], contentTags: ['manga'], adaptedOn});
      expect(definition.catalogSync?.intervalMinutes).toBe(720);
      expect(definition.installation.optionalContentMatches).toContain(origin + '/episode/*');
      expect(definition.identify(new URL(work))).toMatchObject({kind: 'catalog', catalog: {key: `${sourceId}:series:7`}});
      expect(definition.identify(new URL(chapter))).toMatchObject({kind: 'reader', catalog: {url: work}});
      expect(definition.identify(new URL(episodeUrl('11')))?.catalog).toBeUndefined();
    });
    it('rejects forged hosts, credentials, volumes, encoded paths and malformed bindings', () => {
      for (const url of [origin + '.evil.test/episode/11', origin.replace('https:', 'http:') + '/episode/11',
        origin.replace('https://', 'https://user:secret@') + '/episode/11']) expect(definition.identify(new URL(url))).toBeNull();
      for (const path of ['/volume/11', '/series/7', '/episode/0', '/episode/11%2fextra', `/episode/11#nodelane-${sourceId}=bad`])
        expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
    });
    it('validates a complete ordered catalog without losing locked chapters or opening a redirecting series page', async () => {
      const ctx = context();
      expect(await network.resolveCatalog(episodeUrl('11'), ctx)).toBe(work);
      const result = validateCatalog(await network.catalog(work, ctx), [definition]);
      expect(result).toMatchObject({id: `${sourceId}:series:7`, complete: true, cover: {url: cover}});
      expect(result.entries.map(e => [e.remoteId, e.order, e.readable])).toEqual([['11', 0, true], ['12', 1, false], ['13', 2, true]]);
      expect(ctx.request.mock.calls.some(([u]) => u.includes('first_episode'))).toBe(false);
    });
    it.each(['duplicate', 'partial', 'foreign', 'changed', 'binding'])('rejects %s catalog without mutating the previous snapshot', async mode => {
      const ctx = context(), previous = await network.catalog(work, ctx), before = structuredClone(previous);
      const read = ctx.request.getMockImplementation()!; let infoReads = 0;
      ctx.request.mockImplementation(async url => {
        if (mode === 'binding' && url.includes('/episode/')) return reader(data('8'));
        if (mode === 'changed' && url.includes('pagination_information') && ++infoReads > 1)
          return JSON.stringify({type: 'number', per_page: 2, readable_products_count: 4});
        if (url.includes('offset=2')) return JSON.stringify(mode === 'duplicate' ? [entry('11')] : mode === 'partial' ? [] :
          mode === 'foreign' ? [{...entry('13'), viewer_uri: 'https://foreign.test/episode/13'}] : [entry('13')]);
        return read(url);
      });
      await expect(network.catalog(work, {...ctx, previous})).rejects.toThrow();
      expect(previous).toEqual(before);
    });
    it('keeps duplicate image URLs in separate source slots and rejects foreign episode or series metadata', async () => {
      const pages = validatePages(await network.pages(chapter, context()), definition.identify(new URL(chapter))!);
      expect(pages).toMatchObject({knownTotal: 2, discoveryComplete: true, direction: 'rtl'});
      expect(pages.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-2', 1]]);
      expect(pages.items[0].resource).toMatchObject({url: image, processing: 'gigaviewer-baku:1125:1600'});
      expect(() => protocol.parsePages(data('8'), chapter)).toThrow();
      expect(() => protocol.parseReader(reader(), episodeUrl('12'))).toThrow();
      expect(() => protocol.parseReader(reader() + reader(), chapter)).toThrow();
      const value = data(); value.readableProduct.pageStructure.pages[0].src = image.replace(cdn, origin);
      expect(() => protocol.parsePages(value, chapter)).toThrow();
    });
    it('rejects locked content and cancellation before/after I/O', async () => {
      const locked = data(); Object.assign(locked.readableProduct, {pageStructure: null});
      await expect(network.pages(chapter, {request: async () => reader(locked)})).rejects.toThrow('当前不可读取');
      const ctx = context(), abort = new AbortController(); abort.abort(Error('cancelled'));
      await expect(network.catalog(work, {...ctx, signal: abort.signal})).rejects.toThrow('cancelled');
      expect(ctx.request).not.toHaveBeenCalled();
      const late = new AbortController();
      await expect(network.pages(chapter, {signal: late.signal, request: async () => {late.abort(Error('late')); return reader();}})).rejects.toThrow('late');
    });
    it('only accepts dedicated source-owned covers, including the verified resize wrapper', () => {
      expect(protocol.coverUrl('https://cdn-scissors.gigaviewer.com/image/scale/x/' + encodeURIComponent(cover), '7')).toEqual({url: cover, series: '7'});
      for (const url of [image, cover.replace(cdn, cdn + '.evil.test'), cover.replace('https:', 'http:'),
        cover.replace('https://', 'https://user@'), cover.replace('/7-', '/8-')]) expect(() => protocol.coverUrl(url, '7')).toThrow();
    });
    it('keeps name search lightweight and bounds pages with query/result-bound cursors', async () => {
      const ctx = context(), result = await network.search(query, ctx);
      expect(validateSearchPage(result, definition, definition.sites![0], [definition]).items).toHaveLength(1);
      expect(ctx.request).toHaveBeenCalledTimes(1);
      const html = search(Array.from({length: 51}, (_, i) => String(i + 1)));
      const first = await network.parseSearch(html, query);
      expect(first.items).toHaveLength(50);
      expect((await network.parseSearch(html, {...query, cursor: first.nextCursor})).items).toHaveLength(1);
      await expect(network.parseSearch(search(), {...query, cursor: first.nextCursor})).rejects.toThrow();
      await expect(network.parseSearch(html, {...query, query: 'different', cursor: first.nextCursor})).rejects.toThrow();
      expect((await network.parseSearch(search([]), query)).items).toEqual([]);
      await expect(network.parseSearch('<h1>404</h1>', query)).rejects.toThrow();
      await expect(network.parseSearch(search().replace(origin, 'https://foreign.test'), query)).rejects.toThrow();
    });
    if (mixed) it('skips only source-owned book/magazine search hits, never treating them as episode series', async () => {
      const volume = searchRow('9', origin + '/volume/9', 'volume');
      expect((await network.parseSearch(search(['7'], volume), query)).items).toHaveLength(1);
      expect((await network.parseSearch(search([], volume), query)).items).toEqual([]);
      await expect(network.parseSearch(search([], volume.replace(origin + '/volume', 'https://foreign.test/volume')), query)).rejects.toThrow();
    });
    if (ssr) {
      it('reads only inert SSR result markup, tolerates CSS build hashes and ignores inline hydration data', async () => {
        const html = search().replaceAll('__abc', '__Other-hash') +
          '<script>throw Error("Do not execute");</script><template>' + searchRow('8') + '</template>';
        expect((await network.parseSearch(html, query)).items).toMatchObject([{title: '作品 7', authors: ['作者']}]);
        expect((await network.parseSearch(html, query)).items).toHaveLength(1);
      });
      it('rejects wrong media, missing or duplicated titles/lists, and false empty results', async () => {
        for (const html of [search().replace(`data-media-name="${route.mediaName}"`, 'data-media-name="foreign"'),
          search().replace('SearchResultItem_series_title__abc', 'unrecognized'),
          search().replace('</li>', '<p class="SearchResultItem_series_title__abc">other</p></li>'),
          search().replace('</html>', '<ul class="SearchResult_search_result_list__def"></ul></html>'),
          search([]).replace('</li>', '<img src="https://foreign.test/cover"></li>'),
          search([]).replace('</ul>', searchRow('7') + '</ul>'),
          search([]).replace('SearchResult_list_empty_li__abc', 'unrecognized')])
          await expect(network.parseSearch(html, query)).rejects.toThrow();
      });
    }
  });
}
