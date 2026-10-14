import {describe, expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {image as imageAdapter} from '../image';
import {network, parseCatalog, parseImages, readerInfo} from '../network';
import {parseSearch, searchUrl} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';

const origin = 'https://rawkuro.net', mirror = 'https://raw1001.net';
const url = origin + '/manga/sample', reader = url + '/di2-5hua';
const cover = origin + '/uploads/covers/sample.jpg', image = 'https://cdn.example.test/pages/0.webp';
const canonical = (url: string) => `<link rel="canonical" href="${url}">`;
const chapter = (slug: string) => `<li class="chapter"><a href="${url}/${slug}">${slug}</a><time>Yesterday</time></li>`;
const catalogHtml = () => `${canonical(url)}<h1>Sample &amp; Book</h1><figure><a href="${cover}"><img src="${cover}"></a></figure>
  <ul id="myUL">${chapter('di2-5hua')}${chapter('di1hua')}</ul><aside><a href="/manga/other/di1hua">Recommendation</a></aside>`;
const readerHtml = () => `${canonical(reader)}<script>
  const CHAPTER_ID = 123;
  </script><h1><a href="${url}">Sample &amp; Book</a> - 2.5</h1><div id="top-control"><select name="nPL_list">
  <option value="${reader}"disabled selected>第2.5話</option><option value="${url}/di1hua">第1話</option></select></div>`;
const page = (index: number, src = image) => `<div class="separator" data-index="${index}"><a class="readImg" href="${src}">
  <img src="${src}" data-src="/loading.gif" referrerpolicy="no-referrer"></a></div>`;
const images = (html = page(1) + page(0) + '<div class="separator"><a class="readImg" href="https://ad.example.test/banner.jpg"><img src="https://ad.example.test/banner.jpg"></a></div>') => JSON.stringify({status: true, html});
const searchHtml = (page = 1, next = true) => `<div id="Blog1"><h1>検索結果：Sample</h1><div class="grid gtc-f141a">
  <div><div class="b-img"><a class="pt-140p" href="${url}"><img src="/loading.gif" data-src="/uploads/covers/sample.jpg"></a></div>
  <div class="text-center"><a href="${url}">Sample &amp; Book</a></div><a href="${reader}">第2.5話</a></div></div>
  <div id="blog-pager"><span class="pagecurrent">${page}</span>${next ? `<a href="/search/${page + 1}/?keyword=Sample">Next</a>` : ''}</div></div>
  <aside><a href="/manga/recommend">Not a result</a></aside>`;

describe('RawKuro / Raw1001', () => {
  it('shares mirror identities, preserves the selected domain and uses generic tab recognition', () => {
    for (const input of [url, reader]) {
      const primary = definition.identify(new URL(input)), secondary = definition.identify(new URL(input.replace(origin, mirror)));
      expect(primary?.pageKey).toBe(secondary?.pageKey);
      expect(primary?.catalog?.key).toBe(secondary?.catalog?.key);
      expect(secondary?.catalog?.url).toBe(url.replace(origin, mirror));
    }
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*', mirror + '/*']});
    expect(definition.sites?.map(site => [site.id, site.search, site.adaptedOn])).toEqual([
      ['rawkuro', true, '2026-10-14'], ['raw1001', true, '2026-10-14']]);
    expect(imageAdapter.readerReferrerPolicy).toBe('no-referrer');
    expect(network).not.toHaveProperty('pageTransport');
  });
  it.each(['http://rawkuro.net', 'https://rawkuro.net.evil.test', 'https://raw1001.net:444', 'https://u:p@rawkuro.net', 'ftp://raw1001.net'])('rejects forged origin %s', host => {
    expect(definition.identify(new URL(host + '/manga/sample'))).toBeNull();
  });
  it.each(['/manga/a%2fb', '/manga/a%252fb', '/manga/%ff', '/manga/a%5cb', '/manga/a?token=x', '/manga/a#x', '/manga/a/b/c', '/search'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('reads the complete oldest-first catalog, dedicated cover and fractional releases on both domains', () => {
    const result = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(result).toMatchObject({title: 'Sample & Book', cover: {url: cover}, complete: true});
    expect(result.entries.map(e => [e.remoteId, e.order])).toEqual([['di1hua', 0], ['di2-5hua', 1]]);
    expect(result.defaultEntryId).toBe(result.entries[0].id);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    const mirrored = validateCatalog(parseCatalog(catalogHtml().replaceAll(origin, mirror), url.replace(origin, mirror)), [definition]);
    expect(mirrored.id).toBe(result.id);
    expect(mirrored.entries.map(e => e.id)).toEqual(result.entries.map(e => e.id));
    expect(mirrored.entries.every(e => e.url.startsWith(mirror))).toBe(true);
  });
  it.each([
    (s: string) => s.replace(chapter('di1hua'), chapter('di2-5hua')),
    (s: string) => s.replace('/sample/di1hua', '/other/di1hua'),
    (s: string) => s.replace('<ul id="myUL">', '<ul id="myUL" data-page="1">').replace('</ul>', '<a href="?page=2">Next</a></ul>'),
    (s: string) => s.replace('</ul>', ''),
    (s: string) => s.replace('href="' + url + '"', 'href="' + origin + '/manga/other"'),
    (s: string) => s.replace('<figure>', '<aside>').replace('</figure>', '</aside>'),
  ])('rejects incomplete or foreign catalog markup', mutate => {
    expect(() => parseCatalog(mutate(catalogHtml()), url)).toThrow();
  });
  it('validates reader ownership and parses only a literal API chapter ID', () => {
    expect(readerInfo(readerHtml(), reader)).toMatchObject({chapterId: '123', title: '第2.5話'});
    for (const html of [readerHtml().replace('const CHAPTER_ID = 123;', 'const CHAPTER_ID = call();'),
      readerHtml().replace('const CHAPTER_ID = 123;', '// const CHAPTER_ID = 123;'),
      readerHtml().replace('const CHAPTER_ID = 123;', 'const CHAPTER_ID = 123;\nconst CHAPTER_ID = 124;'),
      readerHtml().replace('<a href="' + url + '">', '<a href="' + origin + '/manga/other">'),
      readerHtml().replace('value="' + reader + '"', 'value="' + url + '/other"')]) {
      expect(() => readerInfo(html, reader)).toThrow();
    }
  });
  it('sorts shuffled indices, retains duplicate image URLs as separate pages and excludes unindexed promotions', () => {
    const result = validatePages(parseImages(images(), reader, '第2.5話'), definition.identify(new URL(reader))!);
    expect(result).toMatchObject({discoveryComplete: true, knownTotal: 2, direction: 'rtl'});
    expect(result.items.map(item => [item.id, item.order, item.resource])).toEqual([
      ['page-0', 0, {kind: 'http', url: image}], ['page-1', 1, {kind: 'http', url: image}]]);
    const lazy = page(0).replace('src="' + image + '" data-src="/loading.gif"', 'src="/loading.gif" data-src="' + image + '"');
    expect(parseImages(images(lazy), reader, 'One').knownTotal).toBe(1);
  });
  it.each([page(1), page(0) + page(0), page(0) + page(2), page(0).replace('data-index="0"', 'data-index="-1"'),
    page(0).replace('class="separator"', 'class="unknown"'), page(0).replace('no-referrer', 'unsafe-url'),
    page(0, 'javascript:alert(1)'), page(0).replace('src="' + image + '"', 'src="https://wrong.test/0.jpg"'), ''])('rejects incomplete/invalid page lists', html => {
    expect(() => parseImages(images(html), reader, 'Test')).toThrow();
  });
  it.each(['null', '{}', '{"status":false,"html":""}', '<html>Challenge</html>'])('rejects failure responses %s', body => {
    expect(() => parseImages(body, reader, 'Test')).toThrow();
  });
  it('uses one catalog GET and one chapter GET plus one same-domain read-only POST', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(images());
    await network.catalog(url, {request}); await network.pages(reader, {request});
    expect(request.mock.calls).toEqual([[url, undefined], [reader, undefined], [origin + '/ajax/image/list/chap/123', {referer: reader, form: {}}]]);
  });
  it('preserves a trailing-slash input snapshot while requesting the canonical chapter URL', async () => {
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(images());
    const snapshot = await network.pages(reader + '/', {request});
    expect(validatePages(snapshot, definition.identify(new URL(reader + '/'))!).url).toBe(reader + '/');
    expect(request.mock.calls[0][0]).toBe(reader);
  });
  it('checks cancellation before requests and between GET and POST; failures leave previous catalog untouched', async () => {
    const controller = new AbortController(), previous = parseCatalog(catalogHtml(), url), before = JSON.stringify(previous);
    const request = vi.fn(async () => {controller.abort(); return readerHtml();});
    await expect(network.pages(reader, {request, signal: controller.signal})).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
    request.mockClear(); await expect(network.catalog(url, {request, signal: controller.signal})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    await expect(network.catalog(url, {previous, request: vi.fn().mockRejectedValue(Error('offline'))})).rejects.toThrow('offline');
    expect(JSON.stringify(previous)).toBe(before);
  });
  it('searches either mirror with bounded paging, dedicated covers and the same catalog identity', () => {
    const request = {siteId: 'rawkuro', query: 'Sample'}, result = parseSearch(searchHtml(), request);
    expect(searchUrl(request)).toBe(origin + '/search/?keyword=Sample');
    expect(result).toMatchObject({nextCursor: 'page:2', items: [{catalogUrl: url, title: 'Sample & Book', cover: {url: cover}}]});
    const mirrored = parseSearch(searchHtml().replaceAll(origin, mirror), {...request, siteId: 'raw1001'});
    expect(mirrored.items[0].catalogId).toBe(result.items[0].catalogId);
    expect(mirrored.items[0].catalogUrl).toBe(url.replace(origin, mirror));
    expect(parseSearch(searchHtml(2, false), {...request, cursor: 'page:2'}).nextCursor).toBeUndefined();
    expect(parseSearch('<div id="Blog1"><h1>検索結果：Sample</h1><p>漫画は見つかりません！</p></div>', request)).toEqual({items: []});
  });
  it('rejects query/site/cursor tampering, foreign result ownership and malformed pagination', () => {
    for (const request of [{siteId: 'evil', query: 'Sample'}, {siteId: 'rawkuro', query: ''},
      {siteId: 'rawkuro', query: 'Sample', cursor: 'https://evil.test'}, {siteId: 'rawkuro', query: 'Sample', cursor: 'page:0'}])
      expect(() => searchUrl(request)).toThrow();
    for (const html of [searchHtml().replace('keyword=Sample', 'keyword=Other'), searchHtml().replace('/search/2/', '/search/3/'),
      searchHtml().replace('検索結果：Sample', '検索結果：Other'), searchHtml().replace('class="pt-140p" href="' + url, 'class="pt-140p" href="https://evil.test/manga/sample'),
      searchHtml().replace('class="pagecurrent">1', 'class="pagecurrent">2')])
      expect(() => parseSearch(html, {siteId: 'rawkuro', query: 'Sample'})).toThrow();
  });
});
