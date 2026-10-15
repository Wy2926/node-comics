import {describe, expect, it, vi} from 'vitest';
import {catalogKey, chapterKey, chapterUrl, definition, origin, welomaLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {decodeBase64} from '../html';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, chapter, chapterRow, cover, encoded, identity, image, reader, readerHtml, searchCard, searchHtml, url, work} from './fixtures';

describe('WeLoMa', () => {
  it('uses stable case-sensitive identities, floating import and generic tab recognition', () => {
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', pageKey: chapterKey(chapter)});
    expect(definition.identify(new URL(reader))?.catalog).toBeUndefined();
    expect(definition.identify(new URL(chapterUrl(chapter, work)))).toMatchObject({pageKey: chapterKey(chapter), catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(reader.toLowerCase()))?.pageKey).not.toBe(chapterKey(chapter));
    expect(definition.inlineRecognition).toBe('generic'); expect(definition.embeddedEntry).toBe('floating');
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.sites![0]).toMatchObject({adaptedOn: '2026-10-15', primaryLanguages: ['ja'], search: true, isRaw: true});
    expect(network).not.toHaveProperty('pageTransport');
  });
  it.each(['http://weloma.net', 'https://www.weloma.net', 'https://weloma.net.evil.test', 'https://weloma.net:444',
    'https://user:pass@weloma.net', 'ftp://weloma.net'])('rejects forged or unsupported origin %s', host => {
    expect(definition.identify(new URL(host + '/m/0AbCd'))).toBeNull();
  });
  it.each(['/m/0AbCd?x=1', '/m/0AbCd#x', '/m/0AbCd/extra', '/m/a%2fb', '/m/a%41', '/c/eFg12?x=1', '/c/eFg12#x',
    '/c/eFg12#nodelane-weloma=', '/c/eFg12#nodelane-weloma=foo&bar', '/l/0OYCn', '/m/' + 'x'.repeat(65)])('does not import unsupported URL %s', path => {
    expect(welomaLocation(new URL(origin + path))).toBeNull();
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('decodes UTF-8 titles, binds every chapter and reverses only the native complete list', () => {
    const c = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(c).toMatchObject({title: 'サンプル & Book', complete: true, cover: {url: cover}});
    expect(c.entries.map(e => [e.id, e.title, e.order, e.url])).toEqual([
      [chapterKey(chapter), 'Chapter 1', 0, chapterUrl(chapter, work)],
      [chapterKey('eNext'), 'Chapter 2.5', 1, chapterUrl('eNext', work)]]);
    expect(c.defaultEntryId).toBe(c.entries[0].id); expect(c.groups[0].entryIds).toEqual(c.entries.map(e => e.id));
    expect(c.entries.every(e => !e.contentLanguage)).toBe(true);
  });
  it.each(['response', 'duplicate', 'foreign', 'binding', 'empty', 'truncated', 'pagination', 'cover', 'title'])('rejects invalid %s catalog', kind => {
    let html = catalogHtml();
    if (kind === 'response') html = html.replace(identity(url), identity(origin + '/m/other'));
    if (kind === 'duplicate') html = html.replace(chapterRow('eNext', 'Chapter 2.5'), chapterRow(chapter, 'Chapter 1'));
    if (kind === 'foreign') html = html.replace('href="/c/eNext"', 'href="https://evil.test/c/eNext"');
    if (kind === 'binding') html = html.replace('href="/c/eNext"', 'href="/c/eNext#nodelane-weloma=Other"');
    if (kind === 'empty') html = html.replace(/<a\b[\s\S]*?<\/a>/g, '');
    if (kind === 'truncated') html = html.slice(0, -5);
    if (kind === 'pagination') html = html.replace('</ul>', '</ul><ul class="list-chapters at-series"><button>More</button></ul>');
    if (kind === 'cover') html = html.replace(cover, 'javascript:alert(1)');
    if (kind === 'title') html = html.replace(encoded('サンプル & Book'), 'invalid!');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('reads encoded original addresses in source order, preserving duplicate slots and excluding ads', () => {
    const bound = chapterUrl(chapter, work), p = validatePages(parsePages(readerHtml(), bound), definition.identify(new URL(bound))!);
    expect(p).toMatchObject({title: 'サンプル Chapter 1', knownTotal: 2, discoveryComplete: true, direction: 'rtl'});
    expect(p.items.map(i => i.id)).toEqual(['page-0', 'page-1']);
    expect(p.items.map(i => i.resource)).toEqual([{kind: 'http', url: image}, {kind: 'http', url: image}]);
  });
  it.each(['owner', 'current', 'response', 'duplicate-owner', 'missing', 'unsafe', 'empty', 'truncated', 'extra-image', 'canvas'])('rejects invalid %s reader', kind => {
    let html = readerHtml();
    if (kind === 'owner') html = html.replace('/m/' + work, '/m/Other');
    if (kind === 'current') html = html.replace('href="/c/' + chapter, 'href="/c/Other');
    if (kind === 'response') html = html.replace(identity(reader), identity(origin + '/c/Other'));
    if (kind === 'duplicate-owner') html = html.replace('</ol>', '<a href="/m/Other">Other</a></ol>');
    if (kind === 'missing') html = html.replace('data-img=', 'data-missing=');
    if (kind === 'unsafe') html = html.replaceAll(encoded(image), encoded('javascript:alert(1)'));
    if (kind === 'empty') html = readerHtml([]);
    if (kind === 'truncated') html = html.slice(0, html.indexOf('<div id="ad-slik"'));
    if (kind === 'extra-image') html = html.replace('<div id="ad-slik">', '<img src="https://ads.invalid/x.png"><div id="ad-slik">');
    if (kind === 'canvas') html = html.replace('<div id="ad-slik">', '<canvas></canvas><div id="ad-slik">');
    expect(() => parsePages(html, chapterUrl(chapter, work))).toThrow();
  });
  it.each(['', '%%%%', 'a', '/w==', encoded('javascript:alert(1)').slice(0, -1), 'A'.repeat(12004)])('rejects malformed encoding %s', value => {
    expect(() => decodeBase64(value)).toThrow();
  });
  it('resolves bare chapter ownership and performs exactly one HTTP request per operation', async () => {
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml());
    expect(await network.resolveCatalog(reader, {request})).toBe(url);
    await network.catalog(url + '/', {request}); await network.pages(chapterUrl(chapter, work), {request});
    expect(request.mock.calls).toEqual([[reader], [url], [reader]]);
    await expect(network.resolveCatalog(url, {request})).rejects.toThrow();
    await expect(network.pages(url, {request})).rejects.toThrow();
    await expect(network.catalog(reader, {request})).rejects.toThrow();
  });
  it('retains the previous snapshot on failure and rejects cancellation before and after HTTP', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = structuredClone(previous), request = vi.fn().mockRejectedValue(Error('unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable'); expect(previous).toEqual(saved);
    for (const operation of [network.catalog.bind(null, url), network.pages.bind(null, reader), network.resolveCatalog.bind(null, reader),
      network.search.bind(null, {siteId: 'weloma', query: 'sample'})]) {
      const before = new AbortController(); before.abort(Error('cancelled')); request.mockClear();
      await expect(operation({request, signal: before.signal})).rejects.toThrow('cancelled'); expect(request).not.toHaveBeenCalled();
      const after = new AbortController(); request.mockImplementation(async () => {after.abort(Error('cancelled')); return catalogHtml();});
      await expect(operation({request, signal: after.signal})).rejects.toThrow('cancelled');
    }
  });
  it('searches lightweight cards and carries the name query across opaque pagination routes', async () => {
    const query = {siteId: 'weloma', query: 'a & 日本語'}, first = parseSearch(searchHtml(2, 1, true), query);
    expect(first.nextCursor).toBe('page:2:0Next');
    expect(first.items[0]).toMatchObject({title: 'Sample & Book', cover: {url: cover}, latestLabel: 'Last chapter: 1'});
    expect(first.items[0].contentLanguages).toBeUndefined();
    const next = {...query, cursor: first.nextCursor};
    expect(searchUrl(next)).toBe(origin + '/l/0Next?name=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
    expect(parseSearch(searchHtml(1, 2), next).nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml(0), query)).toEqual({items: []});
    const request = vi.fn(async () => searchHtml()); await network.search(query, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/l/0OYCn?name=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
  });
  it.each(['host', 'binding', 'duplicate', 'artwork', 'current', 'pagination', 'verification', 'empty-page'])('rejects invalid %s search', kind => {
    const input = {siteId: 'weloma', query: 'sample'}; let html = searchHtml(1, 1, true);
    if (kind === 'host') html = html.replaceAll('/m/' + work + '0', 'https://evil.test/m/' + work + '0');
    if (kind === 'binding') html = html.replace('href="/m/' + work + '0"', 'href="/m/Other"');
    if (kind === 'duplicate') html = html.replace(searchCard(work + '0'), searchCard(work + '0').repeat(2));
    if (kind === 'artwork') html = html.replace(cover, 'data:image/png;base64,AA==');
    if (kind === 'current') html = html.replace('class="active">1', 'class="active">3');
    if (kind === 'pagination') html = html.replace('/l/0Next', 'https://evil.test/l/0Next');
    if (kind === 'verification') html = '<title>Just a moment...</title>';
    if (kind === 'empty-page') html = searchHtml(0).replace('</ul>', '<a href="/l/0Next">2</a></ul>');
    expect(() => parseSearch(html, input)).toThrow();
  });
  it.each([{siteId: 'other', query: 'x'}, {siteId: 'weloma', query: ''}, {siteId: 'weloma', query: 'x\n'},
    {siteId: 'weloma', query: 'x', cursor: 'https://evil.test'}, {siteId: 'weloma', query: 'x', cursor: 'page:1:0AbCd'}])('rejects invalid search input', input => {
    expect(() => searchUrl(input)).toThrow();
  });
});
