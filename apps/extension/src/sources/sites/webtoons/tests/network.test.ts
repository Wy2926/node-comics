import {describe, expect, it, vi} from 'vitest';
import {definition, languages} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {validateSourceCatalog, sourceFor} from '../../../index';
import {catalogHtml, catalogUrl, episodeUrl, image, readerHtml, searchHtml} from './fixtures';

describe('WEBTOON international', () => {
  it('isolates language, Originals and Canvas identities and rejects forged/ambiguous URLs', () => {
    for (const language of Object.keys(languages)) {
      const url = catalogUrl.replace('/en/', `/${language}/`);
      expect(definition.identify(new URL(url))?.pageKey).toBe(`webtoons:${language}:canvas:7`);
      expect(definition.identify(new URL(url.replace('/canvas/', '/romance/')))?.pageKey).toBe(`webtoons:${language}:originals:7`);
    }
    expect(sourceFor(episodeUrl()).definition.id).toBe('webtoons');
    for (const url of [catalogUrl.replace('www.webtoons.com', 'www.webtoons.com.evil.test'), catalogUrl.replace('https:', 'http:'), catalogUrl.replace('www.', 'user:pass@www.')])
      expect(definition.identify(new URL(url))).toBeNull();
    for (const url of [catalogUrl + '&title_no=8', catalogUrl + '&episode_no=1', episodeUrl() + '&episode_no=2', catalogUrl.replace('=7', '=0'), catalogUrl.replace('/en/', '/xx/')])
      expect(definition.identify(new URL(url))?.kind).toBe('other');
    expect(definition.sites).toHaveLength(7);
    expect(definition.installation.optionalContentMatches).toContain('https://www.webtoons.com/*');
  });
  it('reads every page, checks the head again, orders oldest first and accepts episode gaps', async () => {
    const request = vi.fn(async (url: string) => catalogHtml(Number(new URL(url).searchParams.get('page')) || 1));
    const result = validateSourceCatalog(await network.catalog(catalogUrl, {request}));
    expect(result.entries.map(e => e.remoteId)).toEqual(['1', '2', '3']);
    expect(result.entries.map(e => e.order)).toEqual([0, 1, 2]);
    expect(result.cover?.url).toBe(image); expect(request).toHaveBeenCalledTimes(3);
    expect(result.entries.every(e => e.contentLanguage === 'en')).toBe(true);
    const gaps = await network.catalog(catalogUrl, {request: async () => catalogHtml(1, [9, 4, 1], 1)});
    expect(gaps.entries.map(e => e.remoteId)).toEqual(['1', '4', '9']);
  });
  it('rejects partial, duplicate, wrong-work and moving catalog pages without mutating previous', async () => {
    const previous = await network.catalog(catalogUrl, {request: async () => catalogHtml(1, [1], 1)}), saved = JSON.stringify(previous);
    for (const bad of [catalogHtml(2, [2]), catalogHtml(1), catalogHtml(2).replace('data-episode-no="1"', 'data-episode-no="9"'),
      catalogHtml(2).replaceAll('title_no=7', 'title_no=8'), catalogHtml(2).replace('</ul>', '')]) {
      await expect(network.catalog(catalogUrl, {previous, request: async url => url.includes('page=2') ? bad : catalogHtml(1)})).rejects.toThrow();
      expect(JSON.stringify(previous)).toBe(saved);
    }
    let calls = 0;
    await expect(network.catalog(catalogUrl, {request: async () => ++calls === 1 ? catalogHtml(1) : calls === 2 ? catalogHtml(2) : catalogHtml(1, [4, 3])})).rejects.toThrow();
    expect(() => parseCatalog(catalogHtml(1).replace('&page=2', '&page=3'), catalogUrl, 1)).toThrow();
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
