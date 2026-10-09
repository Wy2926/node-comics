import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition, catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from '../definition';
import {network, parseCatalog, parseImageBatch} from '../network';
import {coverUrl, imageUrl, readerInfo} from '../html';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {batch, catalogHtml, cover, image, reader, readerHtml, slug, url} from './fixtures';

afterEach(() => vi.useRealTimers());
describe('KLManga source contract', () => {
  it('keeps encoded and Unicode identities, direct chapter ownership and explicit generic recognition', () => {
    const loc = definition.identify(new URL(reader))!;
    expect(loc).toMatchObject({kind: 'reader', pageKey: chapterKey({slug, chapter: 'chapter-1'}), catalog: {key: catalogKey(slug), url}});
    expect(definition.identify(new URL(decodeURI(reader)))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(reader.toLowerCase()))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(url))?.kind).toBe('catalog');
    expect(definition.inlineRecognition).toBe('generic'); expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.sites![0].primaryLanguages).toEqual(['ja']);
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*', 'https://klmanga.zone/*']);
    expect(definition.sites![0].search).toBe(true);
  });
  it('lists only the new domain and preserves identities for legacy links', async () => {
    expect(origin).toBe('https://klmanga.toys');
    expect(definition.sites).toHaveLength(1);
    expect(definition.sites![0]).toMatchObject({id: 'klmanga', url: origin + '/'});
    const legacyUrl = url.replace(origin, 'https://klmanga.zone');
    const legacyReader = reader.replace(origin, 'https://klmanga.zone');
    expect(definition.identify(new URL(legacyUrl))?.catalog).toEqual({key: catalogKey(slug), url});
    expect(definition.identify(new URL(legacyReader))?.pageKey).toBe(definition.identify(new URL(reader))?.pageKey);
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(batch());
    const catalog = validateCatalog(await network.catalog(legacyUrl, {request}), [definition]);
    expect(catalog.id).toBe(catalogKey(slug));
    expect(catalog.url).toBe(url);
    expect(catalog.entries[0].url).toBe(reader);
    const pages = validatePages(await network.pages(legacyReader, {request}), definition.identify(new URL(legacyReader))!);
    expect(pages.knownTotal).toBe(1);
    expect(request.mock.calls.map(([target]) => target)).toEqual([url, reader, origin + '/wp-admin/admin-ajax.php']);
    expect(coverUrl(cover.replace(origin, 'https://klmanga.zone'))).toEqual({url: cover.replace(origin, 'https://klmanga.zone')});
  });
  it.each(['http://klmanga.toys', 'https://klmanga.toys.evil.test', 'https://klmanga.toys:444', 'https://user:pass@klmanga.toys', 'ftp://klmanga.toys'])
    ('rejects forged new origin %s', host => expect(definition.identify(new URL(host + '/manga-raw/work/'))).toBeNull());
  it.each(['http://klmanga.zone', 'https://klmanga.zone.evil.test', 'https://klmanga.zone:444', 'https://user:pass@klmanga.zone', 'ftp://klmanga.zone'])
    ('rejects forged origin %s', host => expect(definition.identify(new URL(host + '/manga-raw/work/'))).toBeNull());
  it.each(['/manga-raw/work%2fother/', '/manga-raw/work%5cother/', '/manga-raw/work%252fother/', '/manga-raw/%FF/',
    '/manga-genre/one/', '/wp-admin/admin-ajax.php', '/manga-raw/work/chapter-1/?style=list', '/manga-raw/work/#unknown'])
    ('does not import unsupported route %s', path => expect(['catalog', 'reader']).not.toContain(definition.identify(new URL(origin + path))?.kind));
  it('uses only the complete chapter box, native order and labels including fractional chapters', () => {
    const catalog = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(catalog).toMatchObject({title: 'Work & Name', complete: true, cover: {url: cover}});
    expect(catalog.entries.map(entry => entry.title)).toEqual(['Work & Name 【第1話】', 'Work & Name 【第7.5話】']);
    expect(catalog.entries.map(entry => entry.order)).toEqual([0, 1]);
    expect(catalog.groups).toEqual([{id: 'chapters', title: 'Chapters', complete: true, entryIds: catalog.entries.map(entry => entry.id)}]);
    expect(catalog.defaultEntryId).toBe(catalog.entries[0].id);
  });
  it('folds exact repeated source links without changing native chapter order', () => {
    const html = catalogHtml(), row = /<h4>[\s\S]*?<\/h4>/.exec(html)![0];
    const original = parseCatalog(html, url), repeated = parseCatalog(html.replace(row, row + row), url);
    expect(repeated.entries).toEqual(original.entries);
  });
  it('leaves the supplied previous snapshot unchanged on a failed directory request', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = structuredClone(previous);
    const request = vi.fn(async () => {throw Error('unavailable');});
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable');
    expect(previous).toEqual(saved);
  });
  it.each(['canonical', 'duplicate', 'closure', 'empty', 'host', 'owner', 'partial'])('rejects invalid %s catalog evidence', kind => {
    let html = catalogHtml();
    if (kind === 'canonical') html = html.replace(`href="${url}"`, `href="${catalogUrl('other')}"`);
    if (kind === 'duplicate') html = html.replace(chapterUrl({slug, chapter: 'chapter-7-5'}), reader);
    if (kind === 'closure') html = html.replace('</div><div class="grid-related">', '<div class="grid-related">');
    if (kind === 'empty') html = html.replace(/<h4>[\s\S]*?<\/h4>/g, '');
    if (kind === 'host') html = html.replace(reader, 'https://evil.test/chapter/');
    if (kind === 'owner') html = html.replace(reader, chapterUrl({slug: 'other', chapter: 'chapter-1'}));
    if (kind === 'partial') html = html.replace('</h4>', '</h4><a class="load-more" href="#">More</a>');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('requires chapter canonical, native selected chapter and owner to agree', () => {
    expect(readerInfo(readerHtml(), reader)).toMatchObject({slug, chapter: 'chapter-1', chapterId: '926398', chapterTitle: '【第1話】'});
    expect(() => readerInfo(readerHtml().replace(`href="${reader}"`, `href="${url}"`), reader)).toThrow();
    expect(() => readerInfo(readerHtml().replace(`href="${reader}"`, `href="${chapterUrl({slug, chapter: 'chapter-7-5'})}"`), reader)).toThrow();
    expect(() => readerInfo(readerHtml().replace(`data-redirect="${reader}"`, `data-redirect="${chapterUrl({slug, chapter: 'chapter-7-5'})}"`), reader)).toThrow();
    expect(() => readerInfo(readerHtml().replace(`<li><a href="${url}">`, `<li><a href="${catalogUrl('other')}">`), reader)).toThrow();
    expect(() => readerInfo(readerHtml().replace('<li class="active">【第1話】', '<li class="active">Other'), reader)).toThrow();
  });
  it.each(['script', 'id', 'ajax', 'selected'])('rejects changed %s reader protocol', kind => {
    let html = readerHtml();
    if (kind === 'script') html += '<script>$.ajax({_action:"decode_images", reading_chapter:111,})</script>';
    if (kind === 'id') html = html.replace('reading_chapter: 926398,', 'reading_chapter: "926398",');
    if (kind === 'ajax') html = html.replace(origin + '/wp-admin/admin-ajax.php', 'https://evil.test/ajax');
    if (kind === 'selected') html = html.replace('<option selected ', '<option ');
    expect(() => readerInfo(html, reader)).toThrow();
  });
  it.each(['yes', 'missing', 'mixed'])('preserves duplicate HTTP addresses and merged long images with %s preload metadata', async kind => {
    const data = JSON.parse(batch([image, image]));
    if (kind === 'missing') data.mes = data.mes.replaceAll(" data-preload='yes'", '');
    if (kind === 'mixed') data.mes = data.mes.replace(" data-preload='yes'", '');
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(JSON.stringify(data));
    const pages = validatePages(await network.pages(reader, {request}), definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({adapter: 'klmanga', discoveryComplete: true, knownTotal: 2, direction: 'rtl', title: '【第1話】'});
    expect(pages.items.map(item => item.id)).toEqual(['page-0', 'page-1']);
    expect(pages.items.map(item => item.resource)).toEqual([{kind: 'http', url: image}, {kind: 'http', url: image}]);
    request.mockReset().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(batch());
    expect((await network.pages(reader, {request})).items).toHaveLength(1);
  });
  it('continues only the source form protocol, accumulated markup and requested delay', async () => {
    vi.useFakeTimers();
    const first = batch([image], 1, 1, 1000), second = batch([image], 2);
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const pending = network.pages(reader, {request});
    await vi.advanceTimersByTimeAsync(999); expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).knownTotal).toBe(2);
    expect(request.mock.calls[1]).toEqual([origin + '/wp-admin/admin-ajax.php', {referer: reader,
      form: {action: 'z_do_ajax', _action: 'decode_images', reading_chapter: '926398', img_index: '0', content: ''}}]);
    expect(request.mock.calls[2][1].form.content).toBe(JSON.parse(first).mes);
    expect(request.mock.calls[2][1].form.img_index).toBe('1');
    expect(request.mock.calls[1][1].form).not.toHaveProperty('nonce');
  });
  it.each(['missing', 'no'])('reads a two-image first batch with %s preload metadata and continues at index two', async kind => {
    vi.useFakeTimers();
    const data = JSON.parse(batch([image, image], 2, 1, 1000));
    data.mes = data.mes.replaceAll(" data-preload='yes'", kind === 'missing' ? '' : " data-preload='no'");
    const first = JSON.stringify(data);
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(first).mockResolvedValueOnce(batch([image], 3));
    const pending = network.pages(reader, {request});
    await vi.runAllTimersAsync();
    const pages = validatePages(await pending, definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({knownTotal: 3, discoveryComplete: true});
    expect(pages.items.map(page => page.order)).toEqual([0, 1, 2]);
    expect(request.mock.calls[2][1].form).toMatchObject({img_index: '2', content: data.mes});
  });
  it('reads all 58 first-chapter pages through six native batches before marking the manifest complete', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(readerHtml());
    for (let start = 0; start < 58; start += 10) {
      const end = Math.min(start + 10, 58);
      request.mockResolvedValueOnce(batch(Array.from({length: end - start}, (_, offset) => `${image}-${start + offset}`),
        end, end < 58 ? 1 : 0, 4000));
    }
    const pending = network.pages(reader, {request});
    await vi.runAllTimersAsync();
    const pages = validatePages(await pending, definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({knownTotal: 58, discoveryComplete: true});
    expect(pages.items.map(page => page.order)).toEqual(Array.from({length: 58}, (_, index) => index));
    expect(request.mock.calls.slice(1).map(([, options]) => options.form.img_index)).toEqual(['0', '10', '20', '30', '40', '50']);
    expect(request).toHaveBeenCalledTimes(7);
  });
  it('stops requests on cancellation before requests, after responses and during delay', async () => {
    const cancelled = new AbortController(); cancelled.abort(Error('cancelled'));
    const request = vi.fn(async () => readerHtml());
    await expect(network.pages(reader, {request, signal: cancelled.signal})).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
    const responseAbort = new AbortController();
    request.mockImplementation(async () => {responseAbort.abort(Error('cancelled')); return readerHtml();});
    await expect(network.pages(reader, {request, signal: responseAbort.signal})).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledTimes(1);
    vi.useFakeTimers(); const delayed = new AbortController();
    request.mockReset().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(batch([image], 1, 1, 1000));
    const pending = network.pages(reader, {request, signal: delayed.signal});
    const failure = expect(pending).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1); delayed.abort(Error('cancelled')); await failure;
    await vi.advanceTimersByTimeAsync(1000); expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['advance', 'empty', 'going', 'timeout', 'markup', 'host', 'src'])('rejects invalid %s batches', kind => {
    const data = JSON.parse(batch());
    data.mes = data.mes.replace(" data-preload='yes'", '');
    if (kind === 'advance') data.img_index = 3;
    if (kind === 'empty') data.mes = '';
    if (kind === 'going') data.going = '0';
    if (kind === 'timeout') data.next_timeout = 15001;
    if (kind === 'markup') data.mes += '<script>doNotExecute()</script>';
    if (kind === 'host') data.mes = data.mes.replace('p1.pubg-img.si', 'p1.pubg-img.si.evil.test');
    if (kind === 'src') data.mes = data.mes.replace(/ src='[^']*'/, '');
    expect(() => parseImageBatch(JSON.stringify(data), 0)).toThrow();
  });
  it('identifies the failing batch checks without exposing source markup or image addresses', () => {
    const data = JSON.parse(batch());
    data.img_index = 3;
    data.mes += '<div>unexpected</div>';
    try {
      parseImageBatch(JSON.stringify(data), 0);
      throw Error('Expected invalid batch');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('起始索引 0，本批 1 图，返回索引 3');
      expect(message).toContain('返回索引与图片数不一致');
      expect(message).toContain('响应包含图片以外的标记');
      expect(message).not.toContain(image);
      expect(message).not.toContain('<img');
    }
  });
  it('reports native Fail Image placeholders as source failures instead of importing them as pages', async () => {
    const response = JSON.stringify({mes: [1, 2].map(index =>
      `<img class='d-none' src='https://placehold.co/800x250/png?text=Fail%20Image%20${index}'>`).join(''),
      img_index: 2, going: 1, next_timeout: 1000});
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(response);
    await expect(network.pages(reader, {request})).rejects.toThrow('源站返回“Fail Image”占位图');
    expect(request).toHaveBeenCalledTimes(2);
    expect(() => imageUrl('https://placehold.co/800x250/png?text=Other')).toThrow('正文图片地址无效');
  });
  it('validates only declared image hosts and dedicated local cover paths', () => {
    expect(imageUrl(image)).toBe(image); expect(coverUrl(cover)).toEqual({url: cover});
    expect(coverUrl('https://evil.test/cover.jpg')).toBeUndefined();
    for (const target of [image.replace(':183', ':444'), image.replace('https:', 'http:'), image + '?signed=1', image + '#fragment'])
      expect(() => imageUrl(target)).toThrow();
  });
});
