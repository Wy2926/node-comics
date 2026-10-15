import {describe, expect, it, vi} from 'vitest';
import {catalogKey, chapterKey, definition, mangaLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {artwork, catalogHtml, chaptersHtml, image, origin, reader, readerHtml, slug, url} from './fixtures';

describe('LHTranslation Madara integration', () => {
  it('declares only verified direct-HTTP import capabilities and generic inline recognition', () => {
    expect(definition).toMatchObject({id: 'lhtranslation', inlineRecognition: 'generic', embeddedEntry: 'floating',
      capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
      catalogSync: {intervalMinutes: 720}});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.sites![0]).toMatchObject({pricing: 'free', primaryLanguages: ['en'], contentTags: ['manga'], isRaw: false, adaptedOn: '2026-10-15'});
    expect(definition.sites![0].search).toBe(true);
    expect(network.search).toBeTypeOf('function');
    expect('pageTransport' in network).toBe(false);
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey(slug)});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', catalog: {key: catalogKey(slug), url}});
    expect(definition.identify(new URL(origin + '/?s=a'))?.kind).toBe('other');
  });
  it.each(['http:', 'ftp:'])('rejects a source using %s', protocol => {
    expect(definition.identify(new URL(protocol + '//' + new URL(origin).host + '/manga/fixture-book/'))).toBeNull();
  });
  it.each(['suffix', 'www', 'port', 'credentials'])('rejects unverified %s origin', kind => {
    const target = new URL(url);
    if (kind === 'suffix') target.hostname += '.evil.test';
    if (kind === 'www') target.hostname = 'www.' + target.hostname;
    if (kind === 'port') target.port = '444';
    if (kind === 'credentials') target.username = 'secret';
    expect(definition.identify(target)).toBeNull();
  });
  it.each(['0', 'chapter-199-2', 'chapter-25.02', 'chapter-2.5'])('preserves opaque chapter identity %s across supported styles', chapter => {
    const key = chapterKey({slug, chapter});
    expect(mangaLocation(new URL(url + chapter + '/'))).toEqual({slug, chapter});
    for (const suffix of ['', '?style=list', '?style=paged'])
      expect(definition.identify(new URL(url + chapter + '/' + suffix))?.pageKey).toBe(key);
  });
  it.each(['/manga/a%2fb/', '/manga/a%252fb/', '/manga/a/chapter-1/extra/', '/manga/a/?style=list',
    '/manga/a/chapter-1/?style=unknown', '/manga/a/chapter-1/?style=list&style=paged',
    '/manga/a/chapter-1/?host=other', '/manga/a/chapter-1/#fragment', '/manga/'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('uses one detail GET plus one bounded empty-form chapter request, without fetching chapters', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(chaptersHtml());
    const result = await network.catalog(url, {request});
    expect(request.mock.calls.map(call => call[0])).toEqual([url, url + 'ajax/chapters/']);
    expect(request.mock.calls[1][1]).toEqual({referer: url, form: {}});
    expect(result).toMatchObject({id: catalogKey(slug), sourceId: 'lhtranslation', complete: true, cover: {url: artwork}});
    expect(result.entries.map(entry => [entry.remoteId, entry.order])).toEqual([['0', 0], ['chapter-1', 1], ['chapter-2.5', 2]]);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(entry => entry.id));
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it('uses one list-style request and keeps duplicate images as distinct durable slots', async () => {
    const request = vi.fn(async () => readerHtml()), result = await network.pages(reader + '?style=paged', {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(reader + '?style=list');
    expect(result).toMatchObject({adapter: 'lhtranslation', direction: 'rtl', discoveryComplete: true, knownTotal: 2});
    expect(result.items.map(item => [item.id, item.order, item.resource])).toEqual([
      ['image-0', 0, {kind: 'http', url: image}], ['image-1', 1, {kind: 'http', url: image}]]);
  });
  it.each(['canonical', 'post-id', 'holder-id', 'foreign-cover'])('rejects %s detail before requesting the AJAX directory', async kind => {
    let detail = catalogHtml();
    if (kind === 'canonical') detail = detail.replace(`rel="canonical" href="${url}"`, `rel="canonical" href="${origin}/manga/other/"`);
    if (kind === 'post-id') detail = detail.replace('postid-123', 'postid-124');
    if (kind === 'holder-id') detail = detail.replace('data-id="123"', 'data-id="124"');
    if (kind === 'foreign-cover') detail = detail.replace(`<a href="${url}">`, `<a href="${origin}/manga/other/">`);
    const request = vi.fn(async () => detail);
    await expect(network.catalog(url, {request})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'foreign-chapter', 'group', 'empty', 'conflict'])('rejects %s chapter response', kind => {
    let chapters = chaptersHtml();
    if (kind === 'foreign-chapter') chapters = chapters.replace(reader, origin + '/manga/other/chapter-1/');
    if (kind === 'group') chapters = chapters.replace('no-volumn', 'has-volumn');
    if (kind === 'empty') chapters = chaptersHtml([]);
    if (kind === 'conflict') chapters = chaptersHtml(['chapter-1', 'chapter-1']).replace('>chapter-1</a>', '>conflicting title</a>');
    expect(() => parseCatalog(catalogHtml(), url, kind === 'missing' ? undefined : chapters)).toThrow();
  });
  it.each(['canonical', 'holder', 'nav', 'current', 'post-id', 'missing-page', 'image-url'])('rejects %s reader identity or page data', kind => {
    let html = readerHtml();
    if (kind === 'canonical') html = html.replace(`rel="canonical" href="${reader}"`, `rel="canonical" href="${url}chapter-2/"`);
    if (kind === 'holder') html = html.replace('data-manga="123"', 'data-manga="124"');
    if (kind === 'nav') html = html.replace('data-id="123" data-chapter="chapter-1"', 'data-id="123" data-chapter="chapter-2"');
    if (kind === 'current') html = html.replace('data-id="1001" value="chapter-1"', 'data-id="1001" value="chapter-2"');
    if (kind === 'post-id') html = html.replace('postid-123', 'postid-124');
    if (kind === 'missing-page') html = html.replace('id="image-1"', 'id="image-2"');
    if (kind === 'image-url') html = html.replace(image, 'https://secret@images.test/a.jpg');
    expect(() => parsePages(html, reader)).toThrow();
  });
  it.each(['catalog', 'pages'] as const)('honors cancellation before and after %s requests', async operation => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(Error('cancelled')); return catalogHtml();});
    const invoke = () => network[operation](operation === 'catalog' ? url : reader, {request, signal: controller.signal});
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledOnce();
    request.mockClear();
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not mutate the old catalog when the AJAX response fails', async () => {
    const previous = parseCatalog(catalogHtml(), url, chaptersHtml()), saved = structuredClone(previous);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockRejectedValueOnce(Error('source unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('source unavailable');
    expect(previous).toEqual(saved);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
