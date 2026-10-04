import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition, catalogKey, catalogUrl, chapterKey, chapterUrl} from '../definition';
import {network, parseCatalog, parseImageBatch} from '../network';
import {readerInfo, imageUrl, coverUrl} from '../html';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {batch, catalogHtml, chapterSlug, chaptersHtml, cover, image, reader, readerHtml, slug, url} from './fixtures';

afterEach(() => vi.useRealTimers());
describe('RawLazy source contract', () => {
  it('keeps Unicode and encoded URLs under stable source identities and explicitly reuses generic recognition', () => {
    const loc = definition.identify(new URL(reader))!;
    expect(loc).toMatchObject({kind: 'reader', pageKey: chapterKey(chapterSlug), catalog: {key: catalogKey(slug), url}});
    expect(definition.identify(new URL(decodeURI(reader)))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(url))?.kind).toBe('catalog');
    expect(definition.identify(new URL(chapterUrl(chapterSlug)))?.catalog).toBeUndefined();
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.sites![0].primaryLanguages).toEqual(['ja']);
    expect(definition.installation.optionalContentMatches).toContain('https://rawlazy.io/*');
  });
  it.each(['http://rawlazy.io', 'https://rawlazy.io.evil.test', 'https://rawlazy.io:444', 'https://user:pass@rawlazy.io', 'ftp://rawlazy.io'])
    ('rejects forged origin %s', host => expect(definition.identify(new URL(host + '/manga-lazy/work/'))).toBeNull());
  it.each(['/manga-lazy/work%2fother/', '/manga-lazy/work%5cother/', '/manga-lazy/work%252fother/', '/manga-lazy/%FF/', '/genres/one/', '/wp-admin/admin-ajax.php'])
    ('does not import unsupported route %s', path => expect(['catalog', 'reader']).not.toContain(definition.identify(new URL('https://rawlazy.io' + path))?.kind));
  it('uses the complete static list, source labels and forward source order, keeping fractional chapters', () => {
    const c = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(c).toMatchObject({title: 'Work & Name', complete: true, cover: {url: cover}});
    expect(c.entries.map(entry => entry.title)).toEqual(['第1話', '第7.5話']);
    expect(c.entries.map(entry => entry.order)).toEqual([0, 1]);
    expect(c.entries.every(entry => definition.identify(new URL(entry.url))?.catalog?.key === c.id)).toBe(true);
    expect(c.groups.every(group => group.complete)).toBe(true);
    expect(c.defaultEntryId).toBe(c.entries[0].id);
  });
  it('accepts source reuse of the directory badge class for a Tags section', () => {
    expect(parseCatalog(catalogHtml() + '<div class="chapter-list-lb">Tags:</div>', url).entries).toHaveLength(2);
  });
  it('validates catalog-bound ASCII legacy posts without recognizing arbitrary bare paths', () => {
    const bare = chapterUrl('ascii-legacy'), bound = chapterUrl('ascii-legacy', slug);
    const catalog = parseCatalog(catalogHtml().replace(chapterUrl(chapterSlug), bare), url);
    expect(validateCatalog(catalog, [definition]).entries[0].url).toBe(bound);
    expect(readerInfo(readerHtml().replaceAll(chapterUrl(chapterSlug), bare), bound).catalogSlug).toBe(slug);
    expect(definition.identify(new URL(bare))?.kind).toBe('other');
    expect(() => readerInfo(readerHtml().replaceAll(chapterUrl(chapterSlug), bare), chapterUrl('ascii-legacy', 'other'))).toThrow();
  });
  it.each(['canonical', 'duplicate', 'closure', 'empty', 'host'])('rejects invalid %s catalog evidence', kind => {
    let html = catalogHtml();
    if (kind === 'canonical') html = html.replace(`href="${url}"`, `href="${catalogUrl('other')}"`);
    if (kind === 'duplicate') html = html.replace(chapterUrl('契約-fixture-raw-【第7-5話】'), chapterUrl(chapterSlug));
    if (kind === 'closure') html = html.slice(0, html.lastIndexOf('</div>'));
    if (kind === 'empty') html = html.replace(chaptersHtml(), '<div class="chapters-list"></div>');
    if (kind === 'host') html = html.replace(chapterUrl(chapterSlug), 'https://evil.test/chapter/');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('resolves chapter ownership from source data and requires exact directory membership', async () => {
    const request = vi.fn(async () => readerHtml());
    expect(await network.resolveCatalog!(chapterUrl(chapterSlug), {request})).toBe(url);
    expect(readerInfo(readerHtml(), reader)).toMatchObject({catalogSlug: slug, chapterTitle: '第1話', postId: '3355950'});
    const wrongBinding = chapterUrl(chapterSlug, 'other');
    expect(() => readerInfo(readerHtml(), wrongBinding)).toThrow();
    expect(() => readerInfo(readerHtml().replace(chaptersHtml(), '<div class="chapters-list"></div>'), reader)).toThrow();
    expect(() => readerInfo(readerHtml().replace(`content="${chapterUrl(chapterSlug)}"`, 'content="https://evil.test/chapter/"'), reader)).toThrow();
  });
  it('preserves distinct slots for repeated image addresses and a single merged long image', () => {
    expect(parseImageBatch(batch([image, image]), 0)).toMatchObject({urls: [image, image], index: 2, going: false});
    expect(parseImageBatch(batch([image]), 0)).toMatchObject({urls: [image], index: 1, going: false});
    expect(imageUrl(image)).toBe(image);
    expect(coverUrl(cover)).toEqual({url: cover});
  });
  it.each(['html', 'index', 'stuck', 'shape', 'url', 'missing', 'truncated'])('rejects %s batch without claiming completeness', kind => {
    let body = batch([image]);
    if (kind === 'html') body = JSON.stringify({mes: '<div>ad</div>', img_index: 1, going: 0, next_timeout: 0});
    if (kind === 'index') body = batch([image], 2);
    if (kind === 'stuck') body = batch([], 0, 1);
    if (kind === 'shape') body = '{"mes":"ajax-processed"}';
    if (kind === 'url') body = batch(['https://evil.test/ads/a.html']);
    if (kind === 'missing') body = batch([], 0, 0);
    if (kind === 'truncated') body = body.slice(0, -1);
    expect(() => parseImageBatch(body, 0)).toThrow();
  });
  it('collects bounded sequential POST batches and preserves the source page order', async () => {
    vi.useFakeTimers();
    const second = image.replace('page%201', 'page%202');
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(batch([image], 1, 1, 5))
      .mockResolvedValueOnce(batch([second], 2));
    const pending = network.pages!(reader, {request});
    await vi.runAllTimersAsync();
    const pages = validatePages(await pending, definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({discoveryComplete: true, knownTotal: 2, direction: 'rtl'});
    expect(pages.items.map(page => [page.order, page.resource])).toEqual([
      [0, {kind: 'http', url: image}], [1, {kind: 'http', url: second}],
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]).toEqual(['https://rawlazy.io/wp-admin/admin-ajax.php', expect.objectContaining({
      referer: chapterUrl(chapterSlug), form: expect.objectContaining({action: 'z_do_ajax', _action: 'decode_images', p: '3355950', img_index: '0'}),
    })]);
    expect(request.mock.calls[2][1].form.img_index).toBe('1');
  });
  it('honors cancellation before requests and during the server batch delay', async () => {
    const controller = new AbortController(), request = vi.fn(async () => readerHtml()); controller.abort();
    await expect(network.catalog!(url, {request, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(request).not.toHaveBeenCalled();
    const active = new AbortController();
    request.mockImplementationOnce(async () => readerHtml()).mockImplementationOnce(async () => {
      active.abort(); return batch([image], 1, 1, 4000);
    });
    await expect(network.pages!(reader, {request, signal: active.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('never mutates previous directory observations on a refresh failure', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = JSON.stringify(previous);
    await expect(network.catalog!(url, {previous, request: async () => 'Unavailable'})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(saved);
  });
});
