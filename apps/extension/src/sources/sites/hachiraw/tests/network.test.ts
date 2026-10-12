import {describe, expect, it, vi} from 'vitest';
import {definition, catalogKey, chapterKey, hachiLocation, origin} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, chapter, cover, image, reader, readerHtml, searchHtml, url, work} from './fixtures';

describe('Hachiraw', () => {
  it('recognizes work/chapter ownership, installs floating entry and reuses generic tab recognition', () => {
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog'});
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(network.pageTransport).toEqual(['catalog', 'pages']);
    expect(definition.sites![0]).toMatchObject({search: true, primaryLanguages: ['ja'], adaptedOn: '2026-10-12'});
    expect(hachiLocation(new URL(origin + '/manga/' + encodeURIComponent('作品') + '/chapter-3-2/'))).toEqual({slug: '作品', chapter: 'chapter-3-2'});
  });
  it.each(['http://hachiraw.net', 'https://hachiraw.net.evil.test', 'https://hachiraw.net:444', 'https://user:pass@hachiraw.net', 'ftp://hachiraw.net'])('rejects forged origin %s', host => {
    expect(definition.identify(new URL(host + '/manga/sample'))).toBeNull();
  });
  it.each(['chapter-92-fix', 'chapter-3-2', 'chapter-92-fix2'])('keeps the complete chapter identifier %s', chapter => {
    const slug = 'tensei-shitara-slime-datta-ken', catalog = origin + '/manga/' + slug;
    expect(definition.identify(new URL(catalog))).toMatchObject({kind: 'catalog'});
    expect(definition.identify(new URL(catalog + '/' + chapter))).toMatchObject({kind: 'reader',
      pageKey: chapterKey({slug, chapter}), catalog: {key: catalogKey(slug), url: catalog}});
  });
  it.each(['chapter-fix', 'chapter-92-', 'chapter-92--fix', 'chapter-92-fix/extra', 'chapter-92%2ffix', 'chapter-92%252ffix', 'chapter-92-fix?token=x', 'chapter-92-fix#x'])('rejects malformed chapter identifiers: %s', chapter => {
    expect(definition.identify(new URL(url + '/' + chapter))?.kind).toBe('other');
  });
  it.each(['/manga/work%2fother', '/manga/work%252fother', '/manga/%FF', '/manga/work%5cother', '/manga/work?token=x', '/manga/work#x', '/manga/work/chapter-x', '/list-manga'])('does not import unsupported URL %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('includes hidden and fractional chapters in native reading order, excluding dates and badges', () => {
    const result = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(result).toMatchObject({title: 'Sample & Book', complete: true, cover: {url: cover}});
    expect(result.entries.map(e => [e.title, e.order])).toEqual([['第1話', 0], ['第2.5話', 1]]);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it('preserves corrected and original releases as separate entries and validates corrected reader ownership', async () => {
    const slug = 'tensei-shitara-slime-datta-ken', catalog = origin + '/manga/' + slug, corrected = catalog + '/chapter-92-fix';
    const html = catalogHtml().replace(chapter('2-5') + chapter('1', true),
      chapter('93') + chapter('92-fix', true).replace('第92.fix話', '第92 fix話') + chapter('92', true)).replaceAll(work, slug);
    const result = validateCatalog(parseCatalog(html, catalog), [definition]);
    expect(result.entries.map(entry => [entry.remoteId, entry.title])).toEqual([
      ['chapter-92', '第92話'], ['chapter-92-fix', '第92 fix話'], ['chapter-93', '第93話']]);
    expect(new Set(result.entries.map(entry => entry.id)).size).toBe(3);
    const body = readerHtml().replaceAll(work, slug).replaceAll('/chapter-1', '/chapter-92-fix').replaceAll('第1話', '第92 fix話');
    expect(validatePages(parsePages(body, corrected), definition.identify(new URL(corrected))!)).toMatchObject({title: '第92 fix話', knownTotal: 2});
    expect(() => parsePages(body, catalog + '/chapter-92')).toThrow('当前章节归属错误');
    const request = vi.fn().mockResolvedValueOnce(html).mockResolvedValueOnce(body);
    await network.catalog(catalog, {request}); await network.pages(corrected, {request});
    expect(request.mock.calls).toEqual([[catalog], [corrected]]);
  });
  it.each(['duplicate', 'foreign', 'cover', 'truncated', 'empty', 'pagination'])('rejects %s catalog', kind => {
    let html = catalogHtml();
    if (kind === 'duplicate') html = html.replace(chapter('1', true), chapter('2-5'));
    if (kind === 'foreign') html = html.replace('href="' + reader, 'href="' + origin + '/manga/other/chapter-1');
    if (kind === 'cover') html = html.replace('/mangacover/sample-book.jpg', '/mangacover/other.jpg');
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'empty') html = html.replace(/<a\b[\s\S]*?<\/a>/g, '');
    if (kind === 'pagination') html = html.replace('<div class="col-12">', '<div class="col-12"><a href="?page=2">More</a>');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('preserves duplicate image slots, lazy originals and source order without filename-number inference', () => {
    const result = validatePages(parsePages(readerHtml(), reader), definition.identify(new URL(reader))!);
    expect(result).toMatchObject({knownTotal: 2, discoveryComplete: true, title: '第1話', direction: 'rtl'});
    expect(result.items.map(p => p.resource)).toEqual([{kind: 'http', url: image}, {kind: 'http', url: image}]);
    expect(result.items.map(p => p.id)).toEqual(['page-0', 'page-1']);
  });
  it('excludes the observed in-gallery promotion but rejects unknown extra images', () => {
    const html = readerHtml().replace('</div></div>', '<img class="lazy" data-original="https://hachiraw.net/01.png"></div></div>');
    expect(parsePages(html, reader).items).toHaveLength(2);
    expect(() => parsePages(html.replace('/01.png', '/unknown.png'), reader)).toThrow('正文清单不完整');
  });
  it.each(['owner', 'chapter', 'count', 'truncated', 'missing', 'unsafe', 'empty'])('rejects %s reader', kind => {
    let html = readerHtml();
    if (kind === 'owner') html = html.replace(`href="${url}"`, `href="${origin}/manga/other"`);
    if (kind === 'chapter') html = html.replace(reader, url + '/chapter-2');
    if (kind === 'count') html = html.replace('Page 2', 'Page 3');
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'missing') html = html.replace('data-original=', 'data-missing=');
    if (kind === 'unsafe') html = html.replace(image, 'javascript:alert(1)');
    if (kind === 'empty') html = readerHtml([]);
    expect(() => parsePages(html, reader)).toThrow();
  });
  it('uses one request per catalog/chapter; cancellation and refresh failures preserve previous data', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = structuredClone(previous);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml());
    await network.catalog(url, {request, previous}); await network.pages(reader, {request});
    expect(request.mock.calls).toEqual([[url], [reader]]);
    request.mockRejectedValueOnce(Error('unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable');
    expect(previous).toEqual(saved);
    const signal = new AbortController(); signal.abort(Error('cancelled')); request.mockClear();
    await expect(network.pages(reader, {request, signal: signal.signal})).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
    const after = new AbortController(); request.mockImplementation(async () => {after.abort(Error('cancelled')); return readerHtml();});
    await expect(network.pages(reader, {request, signal: after.signal})).rejects.toThrow('cancelled');
  });
  it('parses lightweight paged and empty searches without reading catalogs', async () => {
    const query = {siteId: 'hachiraw', query: 'sample'};
    expect(parseSearch(searchHtml(21), query)).toMatchObject({nextCursor: 'page:2'});
    expect(parseSearch(searchHtml(21, 2), {...query, cursor: 'page:2'}).items).toHaveLength(1);
    expect(parseSearch(searchHtml(0), query)).toEqual({items: []});
    const request = vi.fn(async () => searchHtml());
    expect((await network.search(query, {request})).items[0]).toMatchObject({title: 'Sample & Book 0'});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/list-manga?search=sample');
    expect(searchUrl({...query, query: 'a & b', cursor: 'page:2'})).toBe(origin + '/list-manga/2?search=a+%26+b');
  });
  it.each(['count', 'owner', 'cover', 'cursor', 'query', 'verification'])('rejects invalid %s search', kind => {
    const request = {siteId: 'hachiraw', query: 'sample', cursor: undefined as string | undefined};
    let html = searchHtml(21);
    if (kind === 'count') html = html.replace('( 21)', '( 1)');
    if (kind === 'owner') html = html.replace('/manga/sample-book-0', 'https://evil.test/manga/sample-book-0');
    if (kind === 'cover') html = html.replace('/mangacover/sample-book-0.jpg', '/mangacover/other.jpg');
    if (kind === 'cursor') request.cursor = 'https://evil.test/';
    if (kind === 'query') html = html.replace('search=sample', 'search=other');
    if (kind === 'verification') html = '<title>Just a moment...</title>';
    expect(() => parseSearch(html, request)).toThrow();
  });
});
