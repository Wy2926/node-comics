import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {definition, comicLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {catalog, cover, image, origin, pages, readerUrl, row, searchHtml, title, workUrl} from './fixtures';

describe('Read Comics Online identities and static catalogs', () => {
  it('declares verified metadata, page transports and bounded search', () => {
    expect(definition.sites![0]).toMatchObject({primaryLanguages: ['en'], pricing: 'free', isRaw: false, contentTags: ['western'], search: true, searchPageSize: 60});
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
      capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
      installation: {autoContentMatches: [], optionalContentMatches: [origin + '/*']}});
    expect(network.pageTransport).toEqual(['catalog', 'pages']);
  });
  it('binds work, named issues, decimal issues and page links without changing issue identity', () => {
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', pageKey: 'readcomicsonline:test-comic-2026'});
    for (const suffix of ['', '/2', '/45/?utm_source=reader#top'])
      expect(definition.identify(new URL(readerUrl + suffix))).toMatchObject({kind: 'reader', pageKey: 'readcomicsonline:test-comic-2026:1',
        catalog: {key: 'readcomicsonline:test-comic-2026', url: workUrl}});
    for (const chapter of ['1.1', 'annual2026', 'halloween-annual-2026'])
      expect(comicLocation(new URL(workUrl + '/' + chapter))?.chapter).toBe(chapter);
    for (const base of [origin + '.evil.test', origin + ':444', origin.replace('https:', 'http:'), origin.replace('://', '://user@'), 'https://www.readcomicsonline.ru'])
      expect(definition.identify(new URL(base + '/comic/test-comic-2026'))).toBeNull();
    for (const path of ['/comic/a/b/all', '/comic/a/b/0', '/comic/a/b/01', '/comic/a/b/1/2', '/comic/a/%2f', '/comic/a//b'])
      expect(comicLocation(new URL(origin + path))).toBeNull();
    expect(definition.identify(new URL(origin + '/advanced-search'))?.kind).toBe('other');
  });
  it('preserves source titles and the actual reading chain, including nonnumeric releases', () => {
    const result = validateCatalog(parseCatalog(catalog, workUrl), [definition]);
    expect(result).toMatchObject({sourceId: 'readcomicsonline', title, complete: true, cover: {url: cover}});
    expect(result.entries.map(e => e.remoteId)).toEqual(['1', '1.1', '2', 'annual2026']);
    expect(result.entries.map(e => e.order)).toEqual([0, 1, 2, 3]);
    expect(result.entries[1].title).toBe(title + ' #1 Noir Edition');
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    expect(result.entries.every(e => e.sequenceId === result.id && e.catalogId === result.id && !e.contentLanguage)).toBe(true);
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it.each([
    (s: string) => s.replace('rel="canonical"', 'rel="other"'),
    (s: string) => s.replace(`href="${workUrl}"`, `href="${workUrl}/1"`),
    (s: string) => s.replace('/test-comic-2026/cover/', '/wrong/cover/'),
    (s: string) => s.replace(row('2'), row('1')),
    (s: string) => s.replace(`${workUrl}/2`, `${origin}/comic/wrong/2`),
    (s: string) => s.replace('</section>', '<button>Load more</button></section>'),
    (s: string) => s.replace('</div>', '<a rel="next" href="?page=2">Next</a></div>'),
    (s: string) => s.replace('</div>', '<span>Not loaded</span></div>'),
    (s: string) => s.replace('</section>', ''),
    (s: string) => s.replace('</div>', ''),
    (s: string) => s.replace('>Read First<', '>Changed<'),
  ])('rejects wrong ownership, duplicate issues, partial or changed catalogs', mutate => {
    expect(() => parseCatalog(mutate(catalog), workUrl)).toThrow();
  });
});

describe('Read Comics Online complete page lists', () => {
  it('uses the whole strip, checks declared page slots, and preserves duplicate images', () => {
    const url = readerUrl + '/2', result = validatePages(parsePages(pages, url), definition.identify(new URL(url))!);
    expect(result).toMatchObject({url, title: title + ' #1', discoveryComplete: true, knownTotal: 2, direction: 'ltr'});
    expect(result.items.map(p => [p.id, p.order, p.resource])).toEqual([
      ['page-0', 0, {kind: 'http', url: image}], ['page-1', 1, {kind: 'http', url: image}],
    ]);
  });
  it.each([
    (s: string) => s.replace('rel="canonical"', 'rel="other"'),
    (s: string) => s.replace(`href="${readerUrl}"`, `href="${workUrl}/2"`),
    (s: string) => s.replace(`href="${workUrl}"`, `href="${origin}/comic/wrong"`),
    (s: string) => s.replace(' selected>', '>'),
    (s: string) => s.replace('selected>Chapter #1', 'selected>Chapter #2'),
    (s: string) => s.replace('>Page 2<', '>Page 3<'),
    (s: string) => s.replace(`value="${readerUrl}/2"`, `value="${workUrl}/2/2"`),
    (s: string) => s.replace(' #1 page 2', ' #1 page 1'),
    (s: string) => s.replace('<div id="reader-all">', '<div id="reader-all"><img src="/ad.jpg">'),
    (s: string) => s.replace('id="reader-all"', 'id="unknown"'),
    (s: string) => s.replace('</main>', ''),
    (s: string) => s.replace(/<img src="[^"]+" loading="lazy" alt="[^"]+ page 2">/, ''),
    (s: string) => s.replaceAll('/test-comic-2026/chapters/', '/wrong/chapters/'),
    (s: string) => s.replaceAll('/chapters/1/', '/chapters/2/'),
    (s: string) => s.replaceAll('https://cdn.readcomicsonline.ru/', 'https://cdn.readcomicsonline.ru.evil.test/'),
    (s: string) => s.replaceAll(image, 'javascript:alert(1)'),
    (s: string) => s.replace(/<\/div><\/main>$/, ''),
  ])('refuses incomplete/foreign pages without silently renumbering', mutate => {
    expect(() => parsePages(mutate(pages), readerUrl)).toThrow();
  });
  it('fetches one document per operation, normalizing a single-page deep link', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce(pages);
    await network.catalog(workUrl, {request}); await network.pages(readerUrl + '/2', {request});
    expect(request.mock.calls).toEqual([[workUrl], [readerUrl]]);
  });
  it('rejects verification pages and preserves previous catalogs on failure, cancellation and update', async () => {
    const previous = parseCatalog(catalog, workUrl), original = structuredClone(previous);
    await expect(network.catalog(workUrl, {request: vi.fn().mockResolvedValue('<title>Just a moment...</title>'), previous})).rejects.toThrow();
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return catalog;});
    await expect(network.catalog(workUrl, {request, previous, signal: controller.signal})).rejects.toThrow();
    await expect(network.pages(readerUrl, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    const updated = await network.catalog(workUrl, {request: vi.fn().mockResolvedValue(catalog.replace(row('2'), row('3') + row('2'))), previous});
    expect(updated.entries).toHaveLength(5); expect(previous).toEqual(original);
  });
});

describe('Read Comics Online name search', () => {
  const input = {siteId: 'readcomicsonline', query: 'Test'};
  it('returns a single bounded page, including its verified 60-card size and terminal/empty pages', async () => {
    const request = vi.fn().mockResolvedValue(searchHtml(61));
    const result = await network.search(input, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/advanced-search?name=Test');
    expect(result.items).toHaveLength(60); expect(result.nextCursor).toBe('page:2');
    expect(parseSearch(searchHtml(61, 2), {...input, cursor: result.nextCursor})).toMatchObject({items: [expect.objectContaining({catalogId: 'readcomicsonline:comic-60'})]});
    expect(parseSearch(searchHtml(), input).items).toHaveLength(2);
    expect(parseSearch(searchHtml(0), input)).toEqual({items: []});
    expect(result.items[0]).not.toHaveProperty('contentLanguages');
  });
  it('normalizes source title spacing consistently with image alt labels', () => {
    expect(parseSearch(searchHtml().replaceAll('Comic 0', 'Comic  0'), input).items[0].title).toBe('Comic 0');
    const spaced = title.replace('Comic ', 'Comic  ');
    expect(parseCatalog(catalog.replaceAll(title, spaced), workUrl).title).toBe(title);
    expect(parsePages(pages.replaceAll(title, spaced), readerUrl).title).toBe(title + ' #1');
  });
  it.each([
    (s: string) => s.replace('value="Test"', 'value="Different"'),
    (s: string) => s.replaceAll('page=2', 'page=3'),
    (s: string) => s.replaceAll('name=Test', 'name=Different'),
    (s: string) => s.replaceAll('rel="next"', 'rel="other"'),
    (s: string) => s.replaceAll('aria-current="page"', 'aria-current="other"'),
    (s: string) => s.replace('comic/comic-1', 'comic/comic-0'),
    (s: string) => s.replace('comic/comic-1', 'comic/comic-1/1'),
    (s: string) => s.replace('/manga/comic-1/cover/', '/manga/foreign/cover/'),
    (s: string) => s.replace('rel="next" href="https://readcomicsonline.ru/', 'rel="next" href="https://evil.test/'),
    (s: string) => s.replace('</main>', ''),
  ])('rejects incomplete cards, wrong query, ownership and forged pagination', mutate => {
    expect(() => parseSearch(mutate(searchHtml(61)), input)).toThrow();
  });
  it('validates requests and checks cancellation before/after HTTP', async () => {
    for (const bad of [{...input, query: ''}, {...input, query: 'x\n'}, {...input, siteId: 'other'}, {...input, cursor: 'page:0'},
      {...input, cursor: 'https://evil.test'}, {...input, query: 'x'.repeat(257)}]) expect(() => searchUrl(bad)).toThrow();
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return searchHtml();});
    await expect(network.search(input, {request, signal: controller.signal})).rejects.toThrow();
    await expect(network.search(input, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
