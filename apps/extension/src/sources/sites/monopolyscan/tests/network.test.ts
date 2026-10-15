import {describe, expect, it, vi} from 'vitest';
import {catalogKey, chapterKey, definition, mangaLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {artwork, catalogHtml, chaptersHtml, image, origin, reader, readerHtml, searchHtml, slug, url} from './fixtures';

describe('Monopoly Scan Madara integration', () => {
  it('declares exact-origin direct HTTP, Spanish manhua and generic inline support', () => {
    expect(definition).toMatchObject({id: 'monopolyscan', embeddedEntry: 'floating', inlineRecognition: 'generic',
      capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
      catalogSync: {intervalMinutes: 720}});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.sites![0]).toMatchObject({pricing: 'unknown', primaryLanguages: ['es'], contentTags: ['manhua'],
      isRaw: false, search: true, adaptedOn: '2026-10-15'});
    expect(definition.sites![0].icon).toMatch(/^data:image\/svg\+xml,/);
    expect('pageTransport' in network).toBe(false);
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey(slug)});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', catalog: {key: catalogKey(slug), url}});
  });
  it.each(['http://monopolymanhua.com', 'https://www.monopolymanhua.com', 'https://monopolymanhua.com.evil.test',
    'https://monopolymanhua.com:444', 'https://secret@monopolymanhua.com', 'https://lhtranslation.net'])('does not claim %s', host => {
    expect(definition.identify(new URL(host + '/manga/fixture-warrior/'))).toBeNull();
  });
  it.each(['capitulo-1', 'capitulo-12.5', 'capitulo-1_abc123', '0'])('preserves opaque %s identity across reader styles', chapter => {
    expect(mangaLocation(new URL(url + chapter + '/'))).toEqual({slug, chapter});
    for (const style of ['', '?style=list', '?style=paged'])
      expect(definition.identify(new URL(url + chapter + '/' + style))?.pageKey).toBe(chapterKey({slug, chapter}));
  });
  it.each(['/manga/a%2fb/', '/manga/a/capitulo-1/extra/', '/manga/a/?style=list',
    '/manga/a/capitulo-1/?style=unknown', '/manga/a/capitulo-1/?style=list&style=paged',
    '/manga/a/capitulo-1/?other=1', '/manga/a/capitulo-1/#fragment'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('reads exactly one detail and one complete AJAX list, preserving source identities', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(chaptersHtml());
    const result = await network.catalog(url, {request});
    expect(request.mock.calls).toEqual([[url], [url + 'ajax/chapters/', {referer: url, form: {}}]]);
    expect(result).toMatchObject({id: catalogKey(slug), sourceId: 'monopolyscan', complete: true, cover: {url: artwork}});
    expect(result.entries.map(entry => [entry.remoteId, entry.order])).toEqual([['capitulo-1', 0], ['capitulo-2_abc123', 1]]);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(entry => entry.id));
  });
  it('rejects invalid work identity before the second request and rejects foreign chapters', async () => {
    const request = vi.fn(async () => catalogHtml().replace('postid-321', 'postid-322'));
    await expect(network.catalog(url, {request})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(() => parseCatalog(catalogHtml(), url, chaptersHtml().replace(reader, origin + '/manga/other/capitulo-1/'))).toThrow();
  });
  it('uses one list request, validates three navigation holders and retains duplicate-image slots', async () => {
    const request = vi.fn(async () => readerHtml()), result = await network.pages(reader + '?style=paged', {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(reader + '?style=list');
    expect(result).toMatchObject({adapter: 'monopolyscan', direction: 'ltr', discoveryComplete: true, knownTotal: 2});
    expect(result.items.map(item => [item.id, item.order, item.resource])).toEqual([
      ['image-0', 0, {kind: 'http', url: image}], ['image-1', 1, {kind: 'http', url: image}]]);
    expect(() => parsePages(readerHtml().replace('data-manga="321"', 'data-manga="322"'), reader)).toThrow();
    expect(() => parsePages(readerHtml().replace('id="image-1"', 'id="image-2"'), reader)).toThrow();
  });
  it('requests each search page only on demand and ends on a verified terminal page', async () => {
    const request = vi.fn().mockResolvedValueOnce(searchHtml(12)).mockResolvedValueOnce(searchHtml(1, true, 12));
    const input = {siteId: 'monopolyscan', query: 'guerrero'};
    const first = await network.search!(input, {request});
    expect(first.items).toHaveLength(12);
    expect(first.nextCursor).toBe('page:2');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([origin + '/wp-admin/admin-ajax.php', {
      referer: origin + '/?s=guerrero&post_type=wp-manga', form: {action: 'madara_load_more', page: '0',
        template: 'madara-core/content/content-search', 'vars[paged]': '1', 'vars[template]': 'search',
        'vars[posts_per_page]': '12', 'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': 'guerrero'},
    }]);
    const last = await network.search!({...input, cursor: first.nextCursor}, {request});
    expect(last.items[0]).toMatchObject({catalogId: 'monopolyscan:manga:fixture-12', catalogUrl: origin + '/manga/fixture-12/'});
    expect(last.nextCursor).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].form.page).toBe('1');
  });
  it.each(['catalog', 'pages', 'search'] as const)('honors cancellation before and after the first %s request', async operation => {
    const controller = new AbortController();
    const request = vi.fn(async () => {controller.abort(Error('cancelled')); return catalogHtml();});
    const context = {request, signal: controller.signal};
    const invoke = () => operation === 'search' ? network.search!({siteId: 'monopolyscan', query: 'a'}, context) :
      network[operation](operation === 'catalog' ? url : reader, context);
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledOnce();
    request.mockClear();
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves the previous catalog when the directory request fails', async () => {
    const previous = parseCatalog(catalogHtml(), url, chaptersHtml()), saved = structuredClone(previous);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockRejectedValueOnce(Error('source unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('source unavailable');
    expect(previous).toEqual(saved);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
