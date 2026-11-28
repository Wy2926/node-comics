import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl, chapterKey, catalogKey} from '../definition';
import {network, parseCatalog, parsePart} from '../network';
import {validateSourceCatalog, sourceFor} from '../../../index';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {withPageNetworkContext} from '../../../runtime/page-network';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';
import {catalogHtml, loc, url, reader, readerHtml, image} from './fixtures';

vi.mock('../../../runtime/page-network', () => ({withPageNetworkContext: vi.fn()}));
afterEach(() => {vi.unstubAllGlobals(); vi.mocked(withPageNetworkContext).mockReset();});
describe('Baozi complete HTTP adapter', () => {
  it('reads a verified source-page catalog when extension HTTP would return 403', async () => {
    const direct = vi.fn().mockResolvedValue(new Response('Verification required', {status: 403}));
    vi.stubGlobal('fetch', direct);
    const request = vi.fn().mockResolvedValue(catalogHtml());
    vi.mocked(withPageNetworkContext).mockImplementation(async (_url, signal, read) => read({signal, request}));
    expect((await readSourceCatalog(url)).entries).toHaveLength(27);
    expect(request).toHaveBeenCalledWith(url);
    expect(direct).not.toHaveBeenCalled();
  });
  it.each(['cn.', '', 'www.', 'tw.'])('shares book and chapter IDs across the %j catalog and reader aliases', prefix => {
    const site = `https://${prefix}baozimh.com`, chapters = `https://${prefix}twbzmg.com`;
    const catalog = {key: catalogKey(loc.comic), url: url.replace('cn.', prefix || 'www.')};
    expect(sourceFor(`${site}/comic/${loc.comic}`).location).toMatchObject({kind: 'catalog', pageKey: catalog.key, catalog});
    for (const address of [`${site}/user/page_direct?chapter_slot=0&section_slot=0&comic_id=${loc.comic}`,
      `${site}/comic/chapter/${loc.comic}/0_0.html`, `${chapters}/comic/chapter/${loc.comic}/0_0_2.html`])
      expect(sourceFor(address).location).toMatchObject({kind: 'reader', pageKey: chapterKey(loc), catalog});
    expect(definition.installation.optionalContentMatches).toEqual(expect.arrayContaining([site + '/*', chapters + '/comic/chapter/*']));
  });
  it('rejects foreign origins and does not import malformed routes', () => {
    const direct = `https://cn.baozimh.com/user/page_direct?chapter_slot=0&section_slot=0&comic_id=${loc.comic}`;
    for (const address of [url.replace('https:', 'http:'), url.replace('.com', '.com.evil.test'), url.replace('cn.', 'user:pass@www.'),
      url.replace('.com', '.com:444'), url.replace('cn.', 'static-tw.'), url.replace('cn.', 'not'), reader.replace('.com', '.com.evil.test')])
      expect(definition.identify(new URL(address))).toBeNull();
    for (const address of [direct + '&chapter_slot=1', reader.replace('0_0.html', '0_0_1.html'), reader.replace('0_0.html', '00_0.html'),
      url.replace('/comic/', '/other/'), url.replace('baozimh', 'twbzmg')])
      expect(definition.identify(new URL(address))?.kind).toBe('other');
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('includes hidden chapters and retains source order, volume labels and cover', () => {
    const value = validateSourceCatalog(parseCatalog(catalogHtml(), url));
    expect(value.entries).toHaveLength(27); expect(value.entries[1].title).toBe('第01卷');
    expect(value.entries.at(-1)?.remoteId).toBe('0_26'); expect(value.cover?.url).toContain('/cover/example-author.jpg');
    expect(value.groups[0].entryIds).toEqual(value.entries.map(e => e.id));
    for (const entry of value.entries) expect(sourceFor(entry.url).location.pageKey).toBe(entry.id);
    expect(parseCatalog(catalogHtml(1), url).entries).toHaveLength(1);
    expect(parseCatalog(catalogHtml(3), url).entries.map(e => e.remoteId)).toEqual(['0_0', '0_1', '0_2']);
    expect(parseCatalog(catalogHtml(24), url).entries).toHaveLength(24);
    expect(() => parseCatalog(catalogHtml(0), url)).toThrow();
  });
  it('imports the catalog when its dedicated cover is unavailable', () => {
    const value = validateSourceCatalog(parseCatalog(catalogHtml().replace('/cover/example-author.jpg', '/cover/unknown'), url));
    expect(value.cover).toBeUndefined(); expect(value.entries).toHaveLength(27);
  });
  it('uses the dedicated catalog cover even when its filename differs from the comic ID', () => {
    const value = validateSourceCatalog(parseCatalog(catalogHtml().replace('/cover/example-author.jpg', '/cover/previous-slug.jpg'), url));
    expect(value.id).toBe('baozimh:example-author'); expect(value.entries).toHaveLength(27);
    expect(value.cover?.url).toBe('https://static-tw.baozimh.com/cover/previous-slug.jpg');
  });
  it.each(['count', 'hidden', 'duplicate', 'owner', 'canonical', 'host', 'cover', 'unclosed', 'blocked'])('rejects %s catalog', mode => {
    let html = catalogHtml();
    if (mode === 'count') html = html.replace('查看全部27', '查看全部28');
    if (mode === 'hidden') html = html.replace('id="chapters_other_list"', 'id="missing"');
    if (mode === 'duplicate') html = html.replaceAll('chapter_slot=25', 'chapter_slot=24');
    if (mode === 'owner') html = html.replaceAll('comic_id=example-author&amp;section_slot=0&amp;chapter_slot=24', 'comic_id=another&amp;section_slot=0&amp;chapter_slot=24');
    if (mode === 'canonical') html = html.replace('href="' + url, 'href="' + url + '-wrong');
    if (mode === 'host') html = html.replaceAll('href="/user/page_direct', 'href="https://evil.test/user/page_direct');
    if (mode === 'cover') html = html.replace('static-tw.baozimh.com', 'static-tw.baozimh.com.evil.test');
    if (mode === 'unclosed') html = html.replaceAll('</a>', '');
    if (mode === 'blocked') html = '<html>该漫画数据缺少，屏蔽处理</html>';
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('collects every continuation from part one, preserving repeated URLs in distinct stable slots', async () => {
    const requests: string[] = [];
    const result = await network.pages(chapterUrl(loc, 2), {request: async target => {
      requests.push(target); return readerHtml(target.endsWith('_2.html') ? 2 : 1);
    }});
    expect(requests).toEqual([reader, chapterUrl(loc, 2)]); expect(result.knownTotal).toBe(6);
    expect(result.discoveryComplete).toBe(true); expect(result.items.every(p => p.resource.kind === 'http' && p.resource.url === image)).toBe(true);
    expect(new Set(result.items.map(p => p.id)).size).toBe(6);
    expect(result.items.map(p => p.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('reads a traditional catalog and follows a verified next part on another alias', async () => {
    const book = url.replace('cn.', 'tw.'), first = reader.replace('cn.', 'tw.');
    const second = chapterUrl(loc, 2).replace('cn.twbzmg.com', 'www.baozimh.com');
    const content = (part: number) => readerHtml(part).replaceAll('cn.', 'www.')
      .replace('<span class="title">第1话', '<h1 class="title">作品 - 第1話').replace('</span>', '</h1>');
    const request = vi.fn().mockResolvedValueOnce(catalogHtml().replace(url, url.replace('cn.', 'www.')).replace('27章节', '27章節'))
      .mockResolvedValueOnce(content(1).replace(chapterUrl(loc, 2).replace('cn.', 'www.'), second))
      .mockResolvedValueOnce(content(2));
    const value = validateSourceCatalog(await network.catalog(book, {request}));
    expect(value).toMatchObject({id: catalogKey(loc.comic), url: book});
    expect(value.entries).toHaveLength(27);
    expect(value.entries[0]).toMatchObject({id: chapterKey(loc), url: first});
    const snapshot = await network.pages(value.entries[0].url, {request});
    expect(snapshot).toMatchObject({discoveryComplete: true, knownTotal: 6, title: '作品 - 第1話'});
    expect(request.mock.calls).toEqual([[book], [first], [second]]);
  });
  it.each(['missing-next', 'foreign-next', 'foreign-host', 'next-query', 'loop', 'part-count', 'parent', 'canonical', 'foreign-image', 'duplicate-slot', 'no-body', 'early-end'])('rejects %s reader without a partial success', async mode => {
    let html = readerHtml();
    if (mode === 'missing-next') html = html.replace('id="next-chapter"', 'id="missing"');
    if (mode === 'foreign-next') html = html.replace('0_0_2.html', '0_1_2.html');
    if (mode === 'foreign-host') html = html.replace(chapterUrl(loc, 2), chapterUrl(loc, 2).replace('.com', '.com.evil.test'));
    if (mode === 'next-query') html = html.replace('0_0_2.html', '0_0_2.html?other=1');
    if (mode === 'loop') html = html.replace('0_0_2.html', '0_0.html');
    if (mode === 'part-count') html = html.replace('(1/2)', '(2/2)');
    if (mode === 'parent') html = html.replace('href="' + url, 'href="' + url + '-wrong');
    if (mode === 'canonical') html = html.replace('href="' + reader, 'href="' + reader.replace('0_0', '0_1'));
    if (mode === 'foreign-image') html = html.replaceAll('s1.bzcdn.net', 'evil.test');
    if (mode === 'duplicate-slot') html = html.replaceAll('chapter-img-0-1', 'chapter-img-0-0');
    if (mode === 'no-body') html = html.replace('class="comic-contain"', 'class="advertisement"');
    if (mode === 'early-end') html = html.replace('(1/2)', '');
    expect(() => parsePart(html, reader)).toThrow();
  });
  it('rejects failed or changed later parts and respects cancellation', async () => {
    let calls = 0;
    await expect(network.pages(reader, {request: async () => ++calls === 1 ? readerHtml() : readerHtml(2, 3)})).rejects.toThrow();
    const abort = new AbortController(); abort.abort(); const request = vi.fn();
    await expect(network.pages(reader, {signal: abort.signal, request})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    const active = new AbortController();
    await expect(network.pages(reader, {signal: active.signal, request: async () => {active.abort(); return readerHtml();}})).rejects.toThrow();
  });
  it('does not replace an imported catalog on failure and applies new chapters idempotently', async () => {
    const original = parseCatalog(catalogHtml(), url), imported = await importCatalog(original);
    const before = await catalog.list('entries', {index: 'comicId', range: imported.id});
    vi.mocked(withPageNetworkContext).mockImplementation(async (_url, signal, read) => read({signal,
      request: async () => catalogHtml().replace('查看全部27', '查看全部28')}));
    await expect(readSourceCatalog(url)).rejects.toThrow('包子漫画页面不完整或结构已变化');
    expect(await catalog.list('entries', {index: 'comicId', range: imported.id})).toEqual(before);
    const comic = await catalog.get('comics', imported.id), updated = parseCatalog(catalogHtml(28), url);
    await applyCatalogRefresh(imported.id, comic!.source.generation, updated);
    await applyCatalogRefresh(imported.id, comic!.source.generation, updated);
    expect((await catalog.list('entries', {index: 'comicId', range: imported.id}))).toHaveLength(28);
  });
});
