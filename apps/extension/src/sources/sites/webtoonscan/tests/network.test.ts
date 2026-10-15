import {describe, expect, it, vi} from 'vitest';
import {definition, catalogKey, chapterKey, webtoonLocation} from '../definition';
import {network, parseCatalog, parsePages, parseSearch, searchUrl} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {artwork, catalogHtml, chapter, image, lazyCoverHtml, origin, poster, reader, readerHtml, recentChapterHtml, searchHtml, slug, url} from './fixtures';

describe('WebtoonScan', () => {
  it('registers network import/search, floating entry, complete catalogs and generic tab recognition', () => {
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', catalog: {key: catalogKey(slug), url}});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog'});
    expect(definition).toMatchObject({inlineRecognition: 'generic', embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(network.pageTransport).toEqual(['catalog', 'pages']);
    expect(definition.sites![0]).toMatchObject({search: true, primaryLanguages: ['en', 'ko'], adaptedOn: '2026-10-12'});
    expect(definition.identify(new URL(origin + '/?s=sample'))?.kind).toBe('other');
  });
  it.each(['http://webtoonscan.com', 'https://webtoonscan.com.evil.test', 'https://webtoonscan.com:444',
    'https://user:pass@webtoonscan.com', 'ftp://webtoonscan.com', 'https://www.webtoonscan.com'])('rejects unverified origin %s', host => {
    expect(definition.identify(new URL(host + '/manhwa/sample-book/'))).toBeNull();
  });
  it.each(['112', 'chapter-345.5', 'chapter-160-5', 'chapter-25.02', '0'])('retains opaque chapter identity %s', id => {
    expect(webtoonLocation(new URL(url + id + '/'))).toEqual({slug, chapter: id});
    expect(definition.identify(new URL(url + id + '/?style=paged'))?.pageKey).toBe(chapterKey({slug, chapter: id}));
  });
  it.each(['/manhwa/a%2fb/', '/manhwa/a%252fb/', '/manhwa/a%5cb/', '/manhwa/a/chapter-1/extra/',
    '/manhwa/a/?token=x', '/manhwa/a/chapter-1/?style=unknown', '/manhwa/a/chapter-1/?style=list&style=paged',
    '/manhwa/a/chapter-1/#other', '/manga/'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('retains full hidden/static native chapter order and dedicated cover', () => {
    const result = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(result).toMatchObject({complete: true, cover: {url: artwork}});
    expect(result.entries.map(e => [e.remoteId, e.order])).toEqual([['0', 0], ['chapter-1', 1], ['chapter-2.5', 2]]);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it('deduplicates only the observed identical chapter links and labels', () => {
    const result = parseCatalog(catalogHtml(['chapter-1', 'chapter-1', '0']), url);
    expect(result.entries.map(e => [e.remoteId, e.order])).toEqual([['0', 0], ['chapter-1', 1]]);
  });
  it('keeps all 76 chapters in native order when a recent-release badge repeats the newest link', () => {
    const ids = Array.from({length: 76}, (_, i) => `chapter-${75 - i}`);
    const result = validateCatalog(parseCatalog(recentChapterHtml(catalogHtml(ids), ids[0]), url), [definition]);
    expect(result.complete).toBe(true);
    expect(result.entries.map(e => e.remoteId)).toEqual([...ids].reverse());
    expect(result.entries.map(e => e.order)).toEqual(ids.map((_, i) => i));
    expect(result.entries.at(-1)?.title).toBe('chapter-75');
  });
  it.each(['different-chapter', 'foreign', 'missing-title', 'unmarked-extra', 'outside-row'])('rejects %s recent-release links', kind => {
    let html = recentChapterHtml(catalogHtml());
    if (kind === 'different-chapter') html = html.replace(`href="${url}chapter-2.5/" title`, `href="${reader}" title`);
    if (kind === 'foreign') html = html.replace(`href="${url}chapter-2.5/" title`, `href="${origin}/manhwa/other/chapter-2.5/" title`);
    if (kind === 'missing-title') html = html.replace(`<a href="${url}chapter-2.5/">chapter-2.5</a>`, '');
    if (kind === 'unmarked-extra') html = html.replace('class="c-new-tag"', 'class="unknown"');
    if (kind === 'outside-row') html = html.replace('</ul>', `<a href="${reader}" class="c-new-tag">New</a></ul>`);
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('reads lazy catalog and search covers without counting noscript backups twice', () => {
    expect(parseCatalog(lazyCoverHtml(catalogHtml()), url).cover).toEqual({url: artwork});
    expect(parseSearch(lazyCoverHtml(searchHtml()), {siteId: 'webtoonscan', query: 'sample'}).items[0].cover).toEqual({url: artwork});
  });
  it.each(['missing', 'duplicate', 'unsafe', 'credentials'])('still rejects %s lazy covers', kind => {
    let html = lazyCoverHtml(poster());
    if (kind === 'missing') html = html.replace(/<img\b[^>]*>/, '');
    if (kind === 'duplicate') html = html.replace('<noscript>', `<img src="${artwork}"><noscript>`);
    if (kind === 'unsafe') html = html.replace(`data-lazy-src="${artwork}"`, 'data-lazy-src="javascript:alert(1)"');
    if (kind === 'credentials') html = html.replace(`data-lazy-src="${artwork}"`, 'data-lazy-src="https://secret@images.test/cover.jpg"');
    expect(() => parseCatalog(catalogHtml().replace(poster(), html), url)).toThrow();
  });
  it.each(['canonical', 'foreign', 'duplicate', 'cover', 'truncated', 'empty', 'pagination', 'group'])('rejects invalid %s catalog', kind => {
    let html = catalogHtml();
    if (kind === 'canonical') html = html.replace(`href="${url}"`, `href="${origin}/manhwa/other/"`);
    if (kind === 'foreign') html = html.replace(reader, `${origin}/manhwa/other/chapter-1/`);
    if (kind === 'duplicate') html = html.replace(chapter('0'), chapter('chapter-1').replace('>chapter-1<', '>conflicting title<'));
    if (kind === 'cover') html = html.replace('<a href="' + url + '"><img', '<a href="' + reader + '"><img');
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'empty') html = catalogHtml([]);
    if (kind === 'pagination') html = html.replace('</ul>', '<a href="?page=2">More</a></ul>');
    if (kind === 'group') html = html.replace('no-volumn', 'has-volumn');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('keeps duplicate image URLs as distinct slots, strips whitespace and reads lazy originals', () => {
    const html = readerHtml().replace('src="\n\t', 'src="data:image/gif;base64,placeholder" data-src="\n\t');
    const result = validatePages(parsePages(html, reader), definition.identify(new URL(reader))!);
    expect(result).toMatchObject({discoveryComplete: true, knownTotal: 2, direction: 'ltr'});
    expect(result.items.map(p => [p.id, p.order, p.resource])).toEqual([
      ['image-0', 0, {kind: 'http', url: image}], ['image-1', 1, {kind: 'http', url: image}]]);
    expect(parsePages(readerHtml() + '<img src="https://ads.test/ad.jpg">', reader).items).toHaveLength(2);
  });
  it.each(['canonical', 'selected', 'current', 'order', 'empty', 'truncated', 'unsafe', 'credential', 'video', 'extra'])('rejects invalid %s reader', kind => {
    let html = readerHtml();
    if (kind === 'canonical') html = html.replace(reader, url + 'chapter-2/');
    if (kind === 'selected') html = html.replace('data-redirect="' + reader, 'data-redirect="' + url + 'chapter-2/');
    if (kind === 'current') html = html.replace('data-id="42" value="chapter-1"', 'data-id="42" value="chapter-2"');
    if (kind === 'order') html = html.replace('id="image-1"', 'id="image-2"');
    if (kind === 'empty') html = readerHtml([]);
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'unsafe') html = html.replace(image, 'javascript:alert(1)');
    if (kind === 'credential') html = html.replace(image, 'https://secret@images.test/page.jpg');
    if (kind === 'video') html = html.replace('<div class="reading-content">', '<div class="reading-content"><video src="movie.mp4"></video>');
    if (kind === 'extra') html = html.replace('<div class="reading-content">', '<div class="reading-content"><img src="https://ads.test/a.jpg">');
    expect(() => parsePages(html, reader)).toThrow();
  });
  it('uses one request per catalog/reader operation; failure never mutates previous catalog', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = structuredClone(previous);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml());
    await network.catalog(url, {request, previous}); await network.pages(reader + '?style=paged', {request});
    expect(request.mock.calls).toEqual([[url], [reader + '?style=list']]);
    request.mockRejectedValueOnce(Error('unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable');
    expect(previous).toEqual(saved);
  });
  it.each(['catalog', 'pages', 'search'] as const)('rejects cancelled %s before and after the request', async operation => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(Error('cancelled')); return '';});
    const invoke = () => {
      const context = {request, signal: controller.signal};
      return operation === 'search' ? network.search({siteId: 'webtoonscan', query: 'sample'}, context)
        : network[operation](operation === 'catalog' ? url : reader, context);
    };
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
  });
  it('parses paginated and explicit empty search results without fetching catalogs or guessing languages', async () => {
    const query = {siteId: 'webtoonscan', query: 'sample'};
    expect(parseSearch(searchHtml(21), query)).toMatchObject({nextCursor: 'page:2'});
    expect(parseSearch(searchHtml(21, 2), {...query, cursor: 'page:2'}).items).toHaveLength(1);
    expect(parseSearch(searchHtml(0), query)).toEqual({items: []});
    const request = vi.fn(async () => searchHtml());
    const found = await network.search(query, {request});
    expect(found.items[0]).toMatchObject({title: 'Sample & Book 0'});
    expect(found.items[0].contentLanguages).toBeUndefined();
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/?s=sample&post_type=wp-manga');
    expect(searchUrl({...query, query: 'a & b', cursor: 'page:2'})).toBe(origin + '/page/2/?s=a+%26+b&post_type=wp-manga');
  });
  it.each(['count', 'owner', 'cover', 'cursor', 'query', 'verification', 'next', 'next-origin', 'next-credentials', 'duplicate'])('rejects invalid %s search', kind => {
    const query = {siteId: 'webtoonscan', query: 'sample', cursor: undefined as string | undefined};
    let html = searchHtml(21);
    if (kind === 'count') html = html.replace('21 results', '1 results');
    if (kind === 'owner') html = html.replaceAll('/manhwa/sample-0/', '/manhwa/sample-0/chapter-1/');
    if (kind === 'cover') html = html.replace('href="' + origin + '/manhwa/sample-0/', 'href="https://evil.test/manhwa/sample-0/');
    if (kind === 'cursor') query.cursor = 'https://evil.test/';
    if (kind === 'query') query.query = 'other';
    if (kind === 'verification') html = '<title>Just a moment...</title>';
    if (kind === 'next') html = html.replace('/page/2/', '/page/3/');
    if (kind === 'next-origin') html = html.replace(origin + '/page/2/', 'https://evil.test/page/2/');
    if (kind === 'next-credentials') html = html.replace(origin + '/page/2/', 'https://user:pass@webtoonscan.com/page/2/');
    if (kind === 'duplicate') html = html.replaceAll('/manhwa/sample-1/', '/manhwa/sample-0/');
    expect(() => parseSearch(html, query)).toThrow();
  });
});
