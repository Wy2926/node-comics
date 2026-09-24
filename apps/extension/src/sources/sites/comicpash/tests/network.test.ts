import {describe, expect, it, vi} from 'vitest';
import {network, parseContents, parseReader} from '../network';
import {definition, episodeUrl} from '../definition';
import {validateSourceCatalog} from '../../../index';

const series = '1fafeeae328df', episode = '17f11c20955a2', viewer = 'a598aba404a952d2822908e7d58a8aa0';
const base = `https://comicpash.jp/series/${series}`, url = episodeUrl(episode, series);
const heading = `<link rel="canonical" href="${base}"><meta property="og:title" content="Story &amp; Test">`;
const paging = `<a class="series-sort-link" href="${base}">1<!-- -->-<!-- -->2</a><a class="series-sort-link" href="${base}/2">3-3</a>`;
const entry = (id: string) => `<a class="series-eplist-item-link" href="/episodes/${id}"><span class="series-eplist-item-h-text">Chapter ${id}</span></a>`;
const html = (ids: string[]) => heading + paging + ids.map(entry).join('');
const reader = `<link rel="canonical" href="${episodeUrl(episode)}"><meta property="og:title" content="Chapter"><div id="comici-viewer" data-comici-viewer-id="${viewer}" data-series-id="${series}" data-api-domain="/api"></div>`;
const row = (sort: number) => ({sort, width: 720, height: 1024, scramble: JSON.stringify(Array.from({length: 16}, (_, i) => 15 - i)),
  imageUrl: `https://viewer.comicpash.jp/book/${viewer}/page.jpg?signature=synthetic`});
const contents = (sorts = [0, 1]) => ({totalPages: 2, scrollDirection: '横', result: sorts.map(row)});
describe('Comic PASH public network source', () => {
  it('uses the series artwork with og:image as an optional fallback, never an episode thumbnail', async () => {
    for (const main of [true,false]) {
      const artwork=`<meta property="og:image" content="https://cdn-public.comici.jp/series/social.webp">${main?'<img class="series-h-img" src="//cdn-public.comici.jp/series/main.webp">':''}<img class="series-eplist-item-img" src="/episode.webp">`;
      const source=validateSourceCatalog(await network.catalog(base,{request:async target=>artwork+html(target.endsWith('/2')?['third']:[episode,'second'])}));
      expect(source.cover?.url).toBe('https://cdn-public.comici.jp/series/'+(main?'main':'social')+'.webp');
      expect(source.entries).toHaveLength(3);
    }
  });
  it('binds paginated catalogs and episode identities without trusting arbitrary hosts or bindings', () => {
    expect(definition.identify(new URL(base + '/new'))?.catalog?.key).toBe('comicpash:series:' + series);
    expect(definition.identify(new URL(url))?.pageKey).toBe(definition.identify(new URL(episodeUrl(episode)))?.pageKey);
    for (const invalid of ['https://comicpash.jp.evil.test/episodes/a', 'https://user@comicpash.jp/episodes/a', 'http://comicpash.jp/episodes/a', 'https://comicpash.jp:8443/episodes/a'])
      expect(definition.identify(new URL(invalid))).toBeNull();
    expect(definition.identify(new URL('https://comicpash.jp/'))?.kind).toBe('other');
    expect(definition.identify(new URL(episodeUrl(episode) + '#nodelane-comicpash=bad/extra'))?.kind).toBe('other');
  });
  it('collects all numbered catalog pages, preserves source order and rechecks the first page', async () => {
    const request = vi.fn(async (url: string) => url.endsWith('/2') ? html(['third']) : html([episode, 'second']));
    const result = validateSourceCatalog(await network.catalog(base, {request}));
    expect(result).toMatchObject({complete: true, title: 'Story & Test', defaultEntryId: 'comicpash:episode:' + episode});
    expect(result.entries.map(e => e.remoteId)).toEqual([episode, 'second', 'third']);
    expect(request.mock.calls.map(c => c[0])).toEqual([base + '/1', base + '/2', base + '/1']);
    expect(result.entries.every(e => e.url.endsWith('#nodelane-comicpash=' + series))).toBe(true);
  });
  it.each(['missing', 'duplicate', 'foreign', 'changed'])('rejects %s catalog pages without publishing partial results', async mode => {
    let calls = 0;
    const previous = await network.catalog(base, {request: async u => u.endsWith('/2') ? html(['third']) : html([episode, 'second'])});
    const before = JSON.stringify(previous);
    const request = async (u: string) => {
      calls++;
      if (mode === 'changed' && calls === 3) return html([episode, 'changed']);
      if (!u.endsWith('/2')) return html([episode, 'second']);
      if (mode === 'missing') return html([]);
      if (mode === 'duplicate') return html([episode]);
      if (mode === 'foreign') return html(['third']).replace('rel="canonical" href="' + base, 'rel="canonical" href="https://comicpash.jp/series/foreign');
      return html(['third']);
    };
    await expect(network.catalog(base, {request, previous})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(before);
  });
  it('reads a complete ordered image manifest, keeping repeated URLs as separate slots', async () => {
    const request = vi.fn(async (u: string) => u.includes('/episodes/') ? reader : JSON.stringify(contents(u.endsWith('page-to=0') ? [0] : [1, 0])));
    const result = await network.pages(url, {request});
    expect(result).toMatchObject({knownTotal: 2, discoveryComplete: true, direction: 'rtl', url});
    expect(result.items.map(i => [i.id, i.order])).toEqual([['page-0', 0], ['page-1', 1]]);
    expect(result.items[0].resource).toEqual(result.items[1].resource);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(['missing', 'duplicate', 'host', 'owner', 'scramble', 'dimensions'])('rejects %s image data', mode => {
    const body = contents();
    if (mode === 'missing') body.result = [];
    if (mode === 'duplicate') body.result[1].sort = 0;
    if (mode === 'host') body.result[0].imageUrl = body.result[0].imageUrl.replace('viewer.comicpash.jp', 'viewer.comicpash.jp.evil.test');
    if (mode === 'owner') body.result[0].imageUrl = body.result[0].imageUrl.replace(viewer, 'foreign');
    if (mode === 'scramble') body.result[0].scramble = '[0,0]';
    if (mode === 'dimensions') body.result[0].width = 20001;
    expect(() => parseContents(JSON.stringify(body), viewer)).toThrow();
  });
  it('rejects restricted readers, cross-series bindings and changing/incomplete page counts', async () => {
    expect(() => parseReader(heading, url)).toThrow();
    expect(() => parseReader(reader, episodeUrl(episode, 'foreign'))).toThrow();
    await expect(network.pages(url, {request: async u => u.includes('/episodes/') ? reader : JSON.stringify(contents([0]))})).rejects.toThrow();
  });
  it('honors cancellation before and after requests', async () => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return reader;});
    await expect(network.pages(url, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    await expect(network.catalog(base, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
});
