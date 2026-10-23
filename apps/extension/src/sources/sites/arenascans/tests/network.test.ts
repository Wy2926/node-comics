import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, fixtureSite, readerHtml, searchHtml, workDocument} from '../../../shared/mangathemesia/tests/fixtures';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, location, origin} from '../definition';
import {network, parseCatalog, parsePages, parseSearch, searchUrl} from '../network';
import {describeWork} from '../page';

const work = 'sample', chapter = 'unrelated-release-1', second = 'unrelated-release-2.5', url = catalogUrl(work), reader = chapterUrl(chapter);
const fixture = {...fixtureSite('arenascans'), origin, location, catalogKey, catalogUrl, chapterKey, chapterUrl, emptySearchText: 'Not Found',
  searchUrl: (query: string, page: number) => searchUrl({siteId: 'arenascans', query, ...(page > 1 ? {cursor: 'page:' + page} : {})})};
const catalog = () => catalogHtml(fixture, [second, chapter]);
const pages = (images?: string[]) => readerHtml(fixture, images).replaceAll('sample-chapter-1', chapter);

describe('Arena Scans', () => {
  it('provides lightweight work titles for catalog and bare chapter tabs', () => {
    for (const current of [url, reader]) {
      const {document} = workDocument(current, 'Sample & Book', current === reader ? url : undefined);
      expect(describeWork({document, location: definition.identify(new URL(current))!, signal: new AbortController().signal}))
        .toEqual({status: 'ready', value: {title: 'Sample & Book', catalogId: catalogKey(work), catalogUrl: url}});
    }
  });
  it('declares verified HTTP capabilities, local injection scope and generic inline recognition', () => {
    expect(definition.capabilities).toEqual({importable: true, catalog: true, pages: true, inline: true, completePageList: true});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720}});
    expect(definition.sites![0]).toMatchObject({adaptedOn: '2026-10-15', pricing: 'free', contentTags: ['manhwa', 'manhua'],
      primaryLanguages: ['en'], isRaw: false, search: true});
    expect(network).not.toHaveProperty('pageTransport');
  });
  it('keeps chapter identity independent of the verified catalog binding', () => {
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey(work), catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', pageKey: chapterKey(chapter)});
    expect(definition.identify(new URL(reader))?.catalog).toBeUndefined();
    expect(definition.identify(new URL(chapterUrl(chapter, work)))).toMatchObject({pageKey: chapterKey(chapter), catalog: {key: catalogKey(work), url}});
    expect(location(new URL(chapterUrl('100-year-old-top-chef-70')))).toEqual({chapterSlug: '100-year-old-top-chef-70'});
    expect(location(new URL(chapterUrl(second, work)))).toEqual({chapterSlug: second, catalogSlug: work});
  });
  it.each(['http://', 'https://www.', 'https://user:pass@', 'ftp://'])('rejects unverified origin %s', prefix => {
    expect(definition.identify(new URL(prefix + new URL(origin).hostname + '/manga/sample/'))).toBeNull();
  });
  it('rejects forged hosts and ports', () => {
    expect(definition.identify(new URL(origin + '.evil.test/manga/sample/'))).toBeNull();
    expect(definition.identify(new URL(origin + ':444/manga/sample/'))).toBeNull();
  });
  it.each(['/news/', '/manga/sample/?x=1', '/manga/sample/#x', '/manga/a%2Fb/', '/manga/a%252Fb/', '/manga/sample/extra/',
    '/%zz/', '/%23chapter-1/', '/' + chapter + '/?x=1', '/' + chapter + '/#x', '/' + chapter + '/#nodelane-arenascans=',
    '/' + chapter + '/#nodelane-arenascans=sample&other', '/' + chapter + '/#nodelane-other=sample'])('does not import unsupported URL %s', path => {
    expect(location(new URL(origin + path))).toBeNull();
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('uses source ordering, independent chapter names, stable slots and public HTTP images', () => {
    const snapshot = validateCatalog(parseCatalog(catalog(), url), [definition]);
    expect(snapshot.entries.map(e => [e.id, e.url, e.order])).toEqual([
      [chapterKey(chapter), chapterUrl(chapter, work), 0], [chapterKey(second), chapterUrl(second, work), 1]]);
    expect(snapshot).toMatchObject({sourceId: 'arenascans', complete: true, defaultEntryId: chapterKey(chapter)});
    const image = 'https://new-public-cdn.example/pages/one.jpg', bound = chapterUrl(chapter, work);
    const body = validatePages(parsePages(pages([image, image]), bound), definition.identify(new URL(bound))!);
    expect(body).toMatchObject({adapter: 'arenascans', direction: 'ltr', discoveryComplete: true, knownTotal: 2});
    expect(body.items.map(p => [p.id, p.resource])).toEqual([
      ['page-0', {kind: 'http', url: image}], ['page-1', {kind: 'http', url: image}]]);
  });
  it('rejects a forged binding and cross-origin catalog membership', () => {
    expect(() => parsePages(pages(), chapterUrl(chapter, 'other'))).toThrow();
    expect(() => parseCatalog(catalog().replace(chapterUrl(chapter), 'https://foreign.example/' + chapter + '/'), url)).toThrow();
  });
  it.each(['', 'data:image/png;base64,AA==', 'ftp://cdn.example/page.jpg', 'https://user:pass@cdn.example/page.jpg',
    'https://cdn.example/page.jpg#fragment'])('rejects unsafe image URL %s', image => {
    expect(() => parsePages(pages([image]), reader)).toThrow();
  });
  it('performs one request per operation and never sends the local catalog fragment', async () => {
    const request = vi.fn().mockResolvedValueOnce(pages()).mockResolvedValueOnce(catalog()).mockResolvedValueOnce(pages());
    expect(await network.resolveCatalog(reader, {request})).toBe(url);
    await network.catalog(url, {request}); await network.pages(chapterUrl(chapter, work), {request});
    expect(request.mock.calls).toEqual([[reader], [url], [reader]]);
    request.mockClear();
    await expect(network.catalog(reader, {request})).rejects.toThrow();
    await expect(network.pages(url, {request})).rejects.toThrow();
    await expect(network.resolveCatalog('https://foreign.example/' + chapter + '/', {request})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('uses query-bound lightweight search and explicit empty results', async () => {
    const input = {siteId: 'arenascans', query: 'a & 日本語'}, request = vi.fn(async () => searchHtml(fixture, 1, 1, true, input.query));
    const found = await network.search(input, {request});
    expect(found.items[0]).toMatchObject({catalogId: catalogKey('sample-0'), catalogUrl: catalogUrl('sample-0')});
    expect(found.nextCursor).toBe('page:2');
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/?s=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
    expect(searchUrl({...input, cursor: found.nextCursor})).toBe(origin + '/page/2/?s=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
    expect(parseSearch(searchHtml(fixture, 0, 1, false, input.query), input)).toEqual({items: []});
    expect(() => searchUrl({...input, siteId: 'other'})).toThrow();
  });
});
