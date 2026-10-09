import {describe, expect, it, vi} from 'vitest';
import {catalogUrl, definition, episodeUrl, origin} from '../definition';
import {network, parseCatalogPage, parseContents, parseReader, parseSearch, searchUrl} from '../network';
import {sourceFor, validateSourceCatalog} from '../../../index';
import {validateSearchPage} from '../../../core/search';

const series = 'fixture', episode = 'first', viewer = '0123456789abcdef0123456789abcdef';
const base = catalogUrl(series), url = episodeUrl(episode, series);
const entry = (id: string) => `<a class="series-eplist-item-link" href="/episodes/${id}"><span class="series-eplist-item-h-text">Chapter ${id}</span></a>`;
const catalog = (ids: string[], last = false) => `<link rel="canonical" href="${base}"><meta property="og:title" content="Work &amp; Test">
  <img class="series-h-img" src="https://cdn-public.comici.jp/series/fixture/cover.webp">
  <a class="series-sort-link" href="${base}/new">最新話から</a><a class="series-sort-link" href="${base}${last ? '/1' : ''}">1<!-- -->-<!-- -->2</a>
  <a class="series-sort-link">...</a><a class="series-sort-link" href="${base}${last ? '' : '/2'}">3-3</a>${ids.map(entry).join('')}`;
const reader = `<link rel="canonical" href="${episodeUrl(episode)}"><meta property="og:title" content="Chapter">
  <div id="comici-viewer" data-api-domain="/api" data-series-id="${series}" data-comici-viewer-id="${viewer}"></div>`;
const row = (sort: number) => ({sort, width: 844, height: 1200,
  scramble: '[11,13,9,10,1,5,15,0,14,6,4,3,2,7,8,12]',
  imageUrl: `https://comicsviewer.heros-web.com/book/${viewer}/page.jpg?signature=synthetic`});
const contents = (sorts = [1, 0]) => ({totalPages: 2, scrollDirection: '横', result: sorts.map(row)});
const read = async (target: string) => target.includes('/episodes/') ? reader : target.includes('/api/book/')
  ? JSON.stringify(contents(target.endsWith('page-to=0') ? [0] : undefined))
  : target.endsWith('/2') ? catalog(['third'], true) : catalog(['first', 'second']);

describe("HERO'S Web comici adapter", () => {
  it('registers complete capabilities and keeps identity separate from Comic PASH', () => {
    expect(sourceFor(url).definition).toBe(definition);
    expect(definition.capabilities).toMatchObject({importable: true, catalog: true, pages: true, inline: true, completePageList: true});
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
    expect(definition.sites?.[0]).toMatchObject({search: true, adaptedOn: '2026-10-09', primaryLanguages: ['ja']});
    expect(definition.sites?.[0].isFree).not.toBe(true);
    expect(definition.identify(new URL(base + '/new'))?.catalog?.key).toBe('heros:series:fixture');
    expect(definition.identify(new URL(url))?.pageKey).toBe('heros:episode:first');
    expect(definition.identify(new URL(episodeUrl(episode)))?.catalog).toBeUndefined();
    for (const invalid of ['http://heros-web.com/episodes/a', 'https://heros-web.com.evil.test/episodes/a',
      'https://user@heros-web.com/episodes/a', 'https://heros-web.com:8443/episodes/a', 'https://comicpash.jp/episodes/a'])
      expect(definition.identify(new URL(invalid))).toBeNull();
    for (const suffix of ['/', '/episodes/a/extra', '/episode/123', '/episodes/a#nodelane-heros=bad/extra'])
      expect(definition.identify(new URL(origin + suffix))?.kind).toBe('other');
  });
  it('reads numbered full pages (not the collapsed homepage), rechecks and resolves chapter ownership', async () => {
    const request = vi.fn(read);
    const result = validateSourceCatalog(await network.catalog(base + '/new', {request}));
    expect(result).toMatchObject({id: 'heros:series:fixture', complete: true, title: 'Work & Test', groups: []});
    expect(result.entries.map(e => [e.remoteId, e.order])).toEqual([['first', 0], ['second', 1], ['third', 2]]);
    expect(result.entries.every(e => e.catalogId === result.id && e.url.endsWith('#nodelane-heros=fixture'))).toBe(true);
    expect(result.cover?.url).toContain('/series/fixture/cover.webp');
    expect(request.mock.calls.map(c => c[0])).toEqual([base + '/1', base + '/2', base + '/1']);
    expect(await network.resolveCatalog(episodeUrl(episode), {request})).toBe(base);
    await expect(network.resolveCatalog(episodeUrl(episode, 'other'), {request})).rejects.toThrow();
  });
  it.each(['missing', 'duplicate', 'foreign', 'changed', 'range'])('rejects %s directories and preserves previous snapshots', async mode => {
    const previous = await network.catalog(base, {request: read}), before = JSON.stringify(previous);
    let calls = 0;
    const request = async (target: string) => {
      calls++;
      if (mode === 'changed' && calls === 3) return catalog(['first', 'changed']);
      if (!target.endsWith('/2')) return read(target);
      if (mode === 'missing') return catalog([], true);
      if (mode === 'duplicate') return catalog(['first'], true);
      if (mode === 'foreign') return catalog(['third'], true).replace('rel="canonical" href="' + base, 'rel="canonical" href="' + catalogUrl('other'));
      if (mode === 'range') return catalog(['third'], true).replace('3-3', '4-4');
      return read(target);
    };
    await expect(network.catalog(base, {request, previous})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(before);
  });
  it('rejects foreign canonical, viewer/API ownership and inert fake markup', () => {
    expect(() => parseReader(reader.replace('data-series-id="fixture"', 'data-series-id="foreign"'), url)).toThrow();
    expect(() => parseReader(reader.replace('data-api-domain="/api"', 'data-api-domain="https://evil.test"'), url)).toThrow();
    expect(() => parseReader(reader.replace('/episodes/first', '/episodes/other'), url)).toThrow();
    expect(() => parseReader(reader.replace('<div', '<!-- <div').replace('</div>', '</div> -->'), url)).toThrow();
    expect(() => parseReader(`<link rel="canonical" href="${episodeUrl(episode)}"><p>ログイン</p>`, url)).toThrow('源站');
    expect(() => parseCatalogPage(catalog(['first']).replace('/episodes/first', 'https://evil.test/episodes/first'), base)).toThrow();
  });
  it('keeps original page order and repeated URLs; only accepts source-owned images', async () => {
    const result = await network.pages(url, {request: read});
    expect(result).toMatchObject({adapter: 'heros', knownTotal: 2, discoveryComplete: true, direction: 'rtl'});
    expect(result.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-1', 1]]);
    expect(result.items[0].resource).toEqual(result.items[1].resource);
    expect(result.items[0].resource).toMatchObject({processing: 'comici-v1:844:1200:11,13,9,10,1,5,15,0,14,6,4,3,2,7,8,12'});
    for (const imageUrl of [row(0).imageUrl.replace(viewer, 'foreign'), row(0).imageUrl.replace('comicsviewer.heros-web.com', 'viewer.comicpash.jp'),
      row(0).imageUrl.replace('comicsviewer.heros-web.com', 'comicsviewer.heros-web.com.evil.test'), row(0).imageUrl.replace('https:', 'http:'),
      row(0).imageUrl.replace('https://', 'https://user@'), row(0).imageUrl.replace('.com/', '.com:8443/')])
      expect(() => parseContents(JSON.stringify({...contents(), result: [{...row(0), imageUrl}]}), viewer)).toThrow();
  });
  it('rejects invalid, missing and changing manifests and honors cancellation', async () => {
    for (const body of [contents([0, 0]), {...contents(), totalPages: 0}, {...contents(), scrollDirection: 'unknown'},
      {...contents(), result: [{...row(0), scramble: '[0,0]'}]}, {...contents(), result: [{...row(0), width: 0}]}])
      expect(() => parseContents(JSON.stringify(body), viewer)).toThrow();
    await expect(network.pages(url, {request: async target => target.includes('/api/book/') ? JSON.stringify(contents([0])) : reader})).rejects.toThrow();
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return reader;});
    await expect(network.pages(url, {request, signal: controller.signal})).rejects.toThrow();
    await expect(network.catalog(base, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it('searches only titles with bounded pagination, rejecting cross-site or incomplete results', async () => {
    const query = {siteId: 'heros', query: 'クウガ & + %'};
    const hit = (id: string) => ({id, name: id, author: [{name: '作者'}]});
    const body = (rows: unknown[], total = rows.length) => JSON.stringify({searchResult: {
      series: {total, series: rows}, episode: {total: 1, episodes: [hit('ignored')]}, seriesByAuthor: {total: 1, seriesByAuthor: [hit('ignored')]}}});
    expect(new URL(searchUrl(query).url).searchParams.get('q')).toBe(query.query);
    const first = parseSearch(body(Array.from({length: 24}, (_, i) => hit('work' + i)), 25), query);
    expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(24);
    expect(first.nextCursor).toBe('page:2');
    expect(parseSearch(body([hit('last')], 25), {...query, cursor: first.nextCursor}).items[0].catalogId).toBe('heros:series:last');
    expect(parseSearch(body([]), query)).toEqual({items: []});
    for (const raw of [body([hit('same'), hit('same')]), body([hit('../bad')]), body([hit('first')], 25), '{}', '<h1>Verify</h1>'])
      expect(() => parseSearch(raw, query)).toThrow();
    expect(() => searchUrl({...query, siteId: 'comicpash'})).toThrow();
    expect(() => searchUrl({...query, cursor: 'page:0'})).toThrow();
    const request = vi.fn(async () => body([hit('result')]));
    expect((await network.search(query, {request})).items).toHaveLength(1);
    expect(request).toHaveBeenCalledExactlyOnceWith(searchUrl(query).url);
  });
});
