import {describe, expect, it, vi} from 'vitest';
import {definition, languages} from '../definition';
import {network, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {validateSourceCatalog, sourceFor} from '../../../index';
import {catalogHtml, catalogUrl, episodePage, episodeUrl, image, readerHtml, searchHtml} from './fixtures';

const endpoint = 'https://m.webtoons.com/api/v1/canvas/7/episodes?pageSize=100';

describe('WEBTOON international', () => {
  it('isolates language, Originals and Canvas identities and rejects forged/ambiguous URLs', () => {
    for (const language of Object.keys(languages)) {
      for (const host of ['www', 'm']) {
        const url = catalogUrl.replace('/en/', `/${language}/`).replace('www.', host + '.');
        expect(definition.identify(new URL(url))).toMatchObject({pageKey: `webtoons:${language}:canvas:7`,
          catalog: {url: catalogUrl.replace('/en/', `/${language}/`)}});
        expect(definition.identify(new URL(url.replace('/canvas/', '/romance/')))?.pageKey).toBe(`webtoons:${language}:originals:7`);
      }
    }
    expect(sourceFor(episodeUrl()).definition.id).toBe('webtoons');
    for (const url of [catalogUrl.replace('www.webtoons.com', 'www.webtoons.com.evil.test'), catalogUrl.replace('www.', 'm.').replace('https:', 'http:'),
      catalogUrl.replace('www.', 'm.').replace('.com', '.com:8443'), catalogUrl.replace('www.', 'm.').replace('.com', '.com.evil.test'),
      catalogUrl.replace('www.', 'user:pass@m.')])
      expect(definition.identify(new URL(url))).toBeNull();
    for (const url of [catalogUrl + '&title_no=8', catalogUrl + '&episode_no=1', episodeUrl() + '&episode_no=2', catalogUrl.replace('=7', '=0'), catalogUrl.replace('/en/', '/xx/')])
      expect(definition.identify(new URL(url))?.kind).toBe('other');
    expect(definition.sites).toHaveLength(7);
    expect(definition.installation.optionalContentMatches).toContain('https://www.webtoons.com/*');
    expect(definition.installation.optionalContentMatches).toContain('https://m.webtoons.com/*');
  });
  it.each(['canvas', 'romance'])('imports mobile %s links through the API with identical work, episode and page identities', async section => {
    const mobile = (url: string) => url.replace('www.', 'm.');
    const work = catalogUrl.replace('/canvas/', `/${section}/`), chapter = episodeUrl().replace('/canvas/', `/${section}/`);
    const request = vi.fn(async (url: string) => (url.includes('/api/') ? JSON.stringify(episodePage([1]))
      : new URL(url).pathname.endsWith('/viewer') ? readerHtml() : catalogHtml()).replaceAll('/canvas/', `/${section}/`));
    const catalog = validateSourceCatalog(await network.catalog(mobile(work), {request}));
    expect(catalog).toMatchObject({id: `webtoons:en:${section === 'canvas' ? 'canvas' : 'originals'}:7`, url: work});
    expect(catalog.entries[0].url).toBe(chapter);
    const url = mobile(chapter);
    const result = await network.pages(url, {request});
    expect(result).toEqual({...parsePages(readerHtml().replaceAll('/canvas/', `/${section}/`), chapter), url});
    expect(sourceFor(url).location.pageKey).toBe(sourceFor(chapter).location.pageKey);
    expect(request.mock.calls).toEqual([[work, {desktop: true}],
      [endpoint.replace('/canvas/', section === 'canvas' ? '/canvas/' : '/webtoon/'), undefined], [chapter, {desktop: true}]]);
  });
  it('uses the returned episode cursor across gaps and keeps a short nonterminal page', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(JSON.stringify(episodePage([1, 4], 4)))
      .mockResolvedValueOnce(JSON.stringify(episodePage([9])));
    const result = validateSourceCatalog(await network.catalog(catalogUrl, {request}));
    expect(result.entries.map(e => e.remoteId)).toEqual(['1', '4', '9']);
    expect(result.entries.map(e => e.order)).toEqual([0, 1, 2]);
    expect(result.cover?.url).toBe(image);
    expect(result.entries.every(e => e.contentLanguage === 'en')).toBe(true);
    expect(request.mock.calls).toEqual([[catalogUrl, {desktop: true}], [endpoint, undefined], [endpoint + '&cursor=4', undefined]]);
  });
  it('requires the explicit terminal cursor when a page is exactly full', async () => {
    const ids = Array.from({length: 100}, (_, i) => i + 1);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(JSON.stringify(episodePage(ids, 100)))
      .mockResolvedValueOnce(JSON.stringify(episodePage([])));
    expect((await network.catalog(catalogUrl, {request})).entries).toHaveLength(100);
    expect(request).toHaveBeenLastCalledWith(endpoint + '&cursor=100', undefined);
  });
  it('rejects malformed, duplicate, wrong-owner and stalled pages without publishing a partial catalog', async () => {
    const page = episodePage([3]), first = JSON.stringify(episodePage([1, 2], 2));
    for (const bad of ['<html>Login</html>', 'null', '{}', JSON.stringify({...page, success: false}),
      JSON.stringify({success: true, result: {episodeList: []}}), JSON.stringify(episodePage([], 2)),
      JSON.stringify(episodePage([2, 3])), JSON.stringify(episodePage([3, 3])), JSON.stringify(episodePage([4, 3])),
      JSON.stringify(episodePage([3], 2)), JSON.stringify(episodePage([3], 4)),
      JSON.stringify({...page, result: {...page.result, nextCursor: '0'}}),
      ...['title_no=8', 'title_no=7&title_no=7'].map(value => JSON.stringify(page).replace('title_no=7', value)),
      JSON.stringify(page).replace('episode_no=3', 'episode_no=4'), JSON.stringify(page).replace('/en/canvas/', '/fr/canvas/'),
      JSON.stringify(page).replace('/en/canvas/', '/en/romance/'), JSON.stringify(page).replace('Episode 3', ''),
      JSON.stringify(page).replace('"/en/canvas/', '"https://evil.test/en/canvas/'),
      JSON.stringify(episodePage(Array.from({length: 101}, (_, i) => i + 3)))]) {
      const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(first).mockResolvedValue(bad);
      await expect(network.catalog(catalogUrl, {request})).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(3);
    }
    const request = vi.fn().mockResolvedValueOnce(catalogHtml().replace('title_no=7', 'title_no=8'));
    await expect(network.catalog(catalogUrl, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledOnce();
  });
  it('preserves the previous catalog on transport failure and cancellation at every request boundary', async () => {
    const previous = await network.catalog(catalogUrl, {request: async url => url === catalogUrl ? catalogHtml() : JSON.stringify(episodePage())});
    const saved = JSON.stringify(previous), failure = new Error('offline');
    for (const stage of [0, 1, 2, 3]) {
      const controller = new AbortController(); if (!stage) controller.abort();
      const request = vi.fn(async () => {
        if (request.mock.calls.length === stage) controller.abort();
        return request.mock.calls.length === 1 ? catalogHtml() : JSON.stringify(episodePage([1], 1));
      });
      await expect(network.catalog(catalogUrl, {previous, request, signal: controller.signal})).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(stage);
    }
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(JSON.stringify(episodePage([1], 1))).mockRejectedValue(failure);
    await expect(network.catalog(catalogUrl, {previous, request})).rejects.toBe(failure);
    await expect(network.catalog(catalogUrl, {previous, request: async url => url === catalogUrl ? catalogHtml() : JSON.stringify(episodePage([]))})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(saved);
  });
  it('preserves repeated images as distinct slots, excludes outside images and never runs scripts', () => {
    const result = parsePages(`<script>throw Error('never')</script><img src="https://evil.test/ad">` + readerHtml(), episodeUrl());
    expect(result.items.map(p => p.id)).toEqual(['page-0', 'page-1', 'page-2']);
    expect(result.knownTotal).toBe(3); expect(result.discoveryComplete).toBe(true);
    expect(result.items.every(p => p.resource.kind === 'http' && p.resource.url === image)).toBe(true);
    for (const bad of [readerHtml().replace('episode_no=1', 'episode_no=2'), readerHtml().replace(/<\/div>$/, ''),
      readerHtml().replaceAll(image, 'https://webtoon-phinf.pstatic.net.evil.test/ad'), readerHtml().replace('data-url=', 'missing='),
      readerHtml().replace('height="1200"', 'height="NaN"'), '<html>Login required</html>'])
      expect(() => parsePages(bad, episodeUrl())).toThrow();
  });
  it('searches Originals then Canvas, validates ownership, pagination and empty results', () => {
    const request = {siteId: 'webtoons-en', query: 'fixture'};
    expect(parseSearch(searchHtml('originals'), request)).toEqual({items: [], nextCursor: 'canvas:1'});
    const canvas = {...request, cursor: 'canvas:1'};
    const result = parseSearch(searchHtml(), canvas);
    expect(result.items[0]).toMatchObject({catalogId: 'webtoons:en:canvas:7', title: 'WEBTOON fixture', authors: ['Author']});
    expect(result.nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml() + '<a class="pagination" href="/en/search/canvas?keyword=fixture&page=2">2</a>', canvas).nextCursor).toBe('canvas:2');
    expect(() => parseSearch(searchHtml(), {...canvas, cursor: 'canvas:2'})).toThrow();
    expect(parseSearch(searchHtml() + '<a class="pagination" aria-current="true" href="#">2</a>', {...canvas, cursor: 'canvas:2'}).items).toHaveLength(1);
    for (const bad of [searchHtml().replace('title_no=7', 'title_no=8'), searchHtml().replace('/en/canvas/', '/fr/canvas/'), '<html>Error</html>'])
      expect(() => parseSearch(bad, canvas)).toThrow();
    for (const cursor of ['canvas:0', 'https://evil.test', 'canvas:1000']) expect(() => searchUrl({...request, cursor})).toThrow();
  });
  it('honors cancellation before and after requests', async () => {
    const controller = new AbortController(), request = vi.fn(async () => readerHtml()); controller.abort();
    await expect(network.pages(episodeUrl(), {request, signal: controller.signal})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    const later = new AbortController();
    await expect(network.pages(episodeUrl(), {signal: later.signal, request: async () => {later.abort(); return readerHtml();}})).rejects.toThrow();
  });
  it('continues into Canvas when Originals has no matches', async () => {
    const request = vi.fn(async (url: string) => searchHtml(new URL(url).pathname.split('/').at(-1)));
    const result = await network.search({siteId: 'webtoons-en', query: 'fixture'}, {request});
    expect(result.items[0].catalogId).toBe('webtoons:en:canvas:7'); expect(request).toHaveBeenCalledTimes(2);
  });
});
