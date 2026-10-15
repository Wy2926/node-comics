import {describe, expect, it, vi} from 'vitest';
import type {SourceDefinition} from '../../../contracts/definition';
import type {CreateSourcePage} from '../../../contracts/page';
import type {SourceImageAdapter} from '../../../contracts/image';
import {sourceFor, validateSourceCatalog} from '../../../index';
import {validateSearchPage} from '../../../core/search';
import type {ComiciSite} from '../config';
import {comiciNetwork} from '../network';
import {decodeImage} from '../images';

export function verifyComiciAdapter({definition, protocol, network, createPage, image, imageOrigin}: {
  definition: SourceDefinition; protocol: ComiciSite; network: ReturnType<typeof comiciNetwork>['network'];
  createPage: CreateSourcePage; image: SourceImageAdapter; imageOrigin: string;
}) {
  const {id, origin, catalogUrl, episodeUrl} = protocol;
  const parser = comiciNetwork(protocol), viewer = '0123456789abcdef0123456789abcdef';
  const base = catalogUrl('work'), url = episodeUrl('first', 'work');
  const episode = () => ({episode: {id: 'first', series: {id: 'work'}, summary: {id: 'first', title: 'Chapter'},
    contentId: 24, access: {episodeId: 'first', hasAccess: true}, content: [{type: 'viewer', viewerId: viewer}]}});
  const entry = (remote: string) => `<a class="series-eplist-item-link" href="${episodeUrl(remote)}"><span class="series-eplist-item-h-text">${remote}</span></a>`;
  const catalog = (last = false) => `<link rel="canonical" href="${base}"><meta property="og:title" content="Work &amp; Test">
    <img class="series-h-img" src="/cover.webp"><a class="series-sort-link" href="${base}${last ? '/1' : ''}">1-2</a>
    <a class="series-sort-link" href="${base}${last ? '' : '/2'}">3-3</a>${(last ? ['third'] : ['first', 'second']).map(entry).join('')}`;
  const row = (sort: number) => ({sort, width: 777, height: 1200, scramble: JSON.stringify(Array.from({length: 16}, (_, n) => 15 - n)),
    imageUrl: `${imageOrigin}/book/${viewer}/page.jpg?signature=fixture`});
  const contents = (sorts = [1, 0]) => ({totalPages: 2, scrollDirection: '横', result: sorts.map(row)});
  const read = async (target: string) => target.includes('/api/episodes/') ? JSON.stringify(episode())
    : target.includes('/api/book/') ? JSON.stringify(contents(target.endsWith('page-to=0') ? [0] : undefined))
    : catalog(target.endsWith('/2'));

  describe(`${id} ComiciViewer adapter`, () => {
    it('registers isolated identity, complete capabilities, source icon and installation scope', () => {
      expect(sourceFor(url).definition).toBe(definition);
      expect(definition.capabilities).toMatchObject({importable: true, catalog: true, pages: true, inline: true, completePageList: true});
      expect(definition.catalogSync?.intervalMinutes).toBe(720);
      expect(definition.embeddedEntry).toBe('floating');
      expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
      expect(definition.sites?.[0]).toMatchObject({id, search: true, adaptedOn: '2026-10-15', pricing: 'freemium', primaryLanguages: ['ja'], isRaw: true});
      expect(image.decode).toBe(decodeImage);
      expect(definition.identify(new URL(base + '/new'))?.catalog?.key).toBe(id + ':series:work');
      expect(definition.identify(new URL(url))?.pageKey).toBe(id + ':episode:first');
      expect(definition.identify(new URL(episodeUrl('first')))?.catalog).toBeUndefined();
      for (const invalid of [origin.replace('https:', 'http:') + '/series/work', origin + '.evil.test/series/work',
        origin.replace('https://', 'https://user@') + '/series/work', origin + ':8443/series/work', 'https://unregistered.test/series/work'])
        expect(definition.identify(new URL(invalid))).toBeNull();
      for (const suffix of ['/', '/series/work/extra', '/episodes/first/extra', `/episodes/first#nodelane-${id}=bad/extra`])
        expect(definition.identify(new URL(origin + suffix))?.kind).toBe('other');
    });
    it('reads complete numbered catalogs and verifies ownership without rewriting previous snapshots', async () => {
      const request = vi.fn(read), result = validateSourceCatalog(await network.catalog(base, {request}));
      expect(result).toMatchObject({complete: true, id: id + ':series:work', title: 'Work & Test'});
      expect(result.entries.map(row => [row.remoteId, row.order])).toEqual([['first', 0], ['second', 1], ['third', 2]]);
      expect(result.entries.every(row => row.catalogId === result.id && row.url.endsWith(`#nodelane-${id}=work`))).toBe(true);
      expect(request.mock.calls.map(call => call[0])).toEqual([base + '/1', base + '/2', base + '/1']);
      expect(result.cover?.url).toBe(origin + '/cover.webp');
      const saved = JSON.stringify(result);
      await expect(network.catalog(base, {previous: result, request: async () => catalog().replace('3-3', '4-4')})).rejects.toThrow();
      expect(JSON.stringify(result)).toBe(saved);
      expect(await network.resolveCatalog(episodeUrl('first'), {request})).toBe(base);
      await expect(network.resolveCatalog(episodeUrl('first', 'foreign'), {request})).rejects.toThrow();
    });
    it('uses the verified public JSON episode endpoint and contentId, keeping repeated page URLs as distinct slots', async () => {
      const request = vi.fn(read), result = await network.pages(url, {request});
      expect(result).toMatchObject({adapter: id, knownTotal: 2, discoveryComplete: true, direction: 'rtl'});
      expect(result.items.map(page => [page.id, page.order])).toEqual([['page-0', 0], ['page-1', 1]]);
      expect(result.items[0].resource).toEqual(result.items[1].resource);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[0][0]).toBe(origin + '/api/episodes/first');
      for (const [target] of request.mock.calls.slice(1)) {
        const requestUrl = new URL(target);
        expect(requestUrl.searchParams.get('contentId')).toBe('24');
        expect(requestUrl.searchParams.get('user-id')).toBe('');
        expect(requestUrl.searchParams.get('comici-viewer-id')).toBe(viewer);
      }
    });
    it('identifies locked chapters but never requests protected image manifests or user/unlock APIs', async () => {
      const body = episode(); body.episode.access.hasAccess = false;
      // A leaked viewer ID must not override the explicit source access decision.
      const request = vi.fn(async () => JSON.stringify(body));
      expect(await network.resolveCatalog(episodeUrl('first'), {request})).toBe(base);
      request.mockClear();
      await expect(network.pages(url, {request})).rejects.toThrow('源站');
      expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/api/episodes/first');
      body.episode.access.hasAccess = true; body.episode.content = [];
      await expect(network.pages(url, {request})).rejects.toThrow('源站');
    });
    it.each(['episode', 'series', 'summary', 'access', 'contentId', 'viewer', 'duplicate', 'html'])('rejects invalid %s metadata', mode => {
      const body = episode();
      if (mode === 'episode') body.episode.id = 'foreign';
      if (mode === 'series') body.episode.series.id = 'foreign';
      if (mode === 'summary') body.episode.summary.id = 'foreign';
      if (mode === 'access') body.episode.access.episodeId = 'foreign';
      if (mode === 'contentId') body.episode.contentId = -1;
      if (mode === 'viewer') body.episode.content[0].viewerId = 'bad';
      if (mode === 'duplicate') body.episode.content.push(body.episode.content[0]);
      expect(() => parser.parseEpisode(mode === 'html' ? '<html>Verify</html>' : JSON.stringify(body), url)).toThrow();
    });
    it('rejects foreign image hosts, viewer ownership, missing pages and invalid recipes', async () => {
      for (const imageUrl of [row(0).imageUrl.replace(imageOrigin, imageOrigin + '.evil.test'),
        row(0).imageUrl.replace(viewer, 'foreign'), row(0).imageUrl.replace('https:', 'http:'),
        row(0).imageUrl.replace('https://', 'https://user@')])
        expect(() => parser.parseContents(JSON.stringify({...contents(), result: [{...row(0), imageUrl}]}), viewer)).toThrow();
      for (const body of [contents([0, 0]), {...contents(), totalPages: 0},
        {...contents(), result: [{...row(0), scramble: '[0,0]'}]}, {...contents(), result: [{...row(0), width: 0}]}])
        expect(() => parser.parseContents(JSON.stringify(body), viewer)).toThrow();
      await expect(network.pages(url, {request: async target => target.includes('/api/book/') ? JSON.stringify(contents([0])) : read(target)})).rejects.toThrow();
    });
    it('bounds title-only search, handles empty results and rejects incomplete pages', async () => {
      const query = {siteId: id, query: '作品 & + %'}, hit = (n: number) => ({id: 'work' + n, name: 'Work ' + n});
      const response = (rows: unknown[], total = rows.length) => JSON.stringify({searchResult: {series: {total, series: rows},
        seriesByAuthor: {total: 1, series: [hit(999)]}}});
      const first = parser.parseSearch(response(Array.from({length: 24}, (_, n) => hit(n)), 25), query);
      expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(24);
      expect(first.nextCursor).toBe('page:2');
      expect(parser.parseSearch(response([hit(24)], 25), {...query, cursor: first.nextCursor}).items).toHaveLength(1);
      expect(parser.parseSearch(response([]), query)).toEqual({items: []});
      expect(new URL(parser.searchUrl(query).url).searchParams.get('q')).toBe(query.query);
      expect(() => parser.parseSearch(response([hit(0)], 25), query)).toThrow();
      expect(() => parser.searchUrl({...query, siteId: 'foreign'})).toThrow();
      expect(() => parser.searchUrl({...query, cursor: 'page:0'})).toThrow();
    });
    it('honors aborts before and after source requests', async () => {
      const controller = new AbortController(), request = vi.fn(async target => {controller.abort(); return read(target);});
      await expect(network.pages(url, {request, signal: controller.signal})).rejects.toThrow();
      await expect(network.catalog(base, {request, signal: controller.signal})).rejects.toThrow();
      await expect(network.resolveCatalog(url, {request, signal: controller.signal})).rejects.toThrow();
      await expect(network.search({siteId: id, query: 'Work'}, {request, signal: controller.signal})).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    });
    it('only reads rendered body canvases on demand and rejects disposed handles', async () => {
      const encode = vi.fn((done: BlobCallback) => done(new Blob(['pixels'], {type: 'image/png'})));
      const canvas = {width: 777, height: 1200, isConnected: true, toBlob: encode};
      const page = {classList: {contains: () => true}, querySelector: () => canvas, contains: () => true};
      const document = {title: 'Chapter', querySelector: () => ({getAttribute: () => viewer}), querySelectorAll: () => [page],
        addEventListener() {}, removeEventListener() {}} as unknown as Document;
      const session = createPage({document, location: definition.identify(new URL(url))!, signal: new AbortController().signal});
      expect(session.snapshot()).toMatchObject({adapter: id, discoveryComplete: false, knownTotal: 1});
      expect(encode).not.toHaveBeenCalled();
      const target = session.inlineTargets()[0];
      expect(await target.read!()).toBeInstanceOf(Blob);
      expect(await session.discoverPages()).toMatchObject({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
      session.dispose(); await expect(target.read!()).rejects.toThrow();
    });
  });
}
