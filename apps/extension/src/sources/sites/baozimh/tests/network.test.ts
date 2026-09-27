import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl, chapterKey, catalogKey} from '../definition';
import {network, parseCatalog, parsePart} from '../network';
import {validateSourceCatalog, sourceFor} from '../../../index';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';
import {catalogHtml, loc, url, reader, readerHtml, image} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('Baozi complete HTTP adapter', () => {
  it('unifies catalog entry, redirected chapter and continuation identities without claiming other hosts', () => {
    const direct = `https://cn.baozimh.com/user/page_direct?chapter_slot=0&section_slot=0&comic_id=${loc.comic}`;
    for (const address of [reader, chapterUrl(loc, 2), direct]) {
      expect(sourceFor(address).location).toMatchObject({kind: 'reader', pageKey: chapterKey(loc), catalog: {key: catalogKey(loc.comic), url}});
    }
    expect(sourceFor(url).location.kind).toBe('catalog');
    for (const address of [url.replace('https:', 'http:'), url.replace('.com', '.com.evil.test'), url.replace('cn.', 'user:pass@cn.'), url.replace('.com', '.com:444'), url.replace('cn.', 'www.')])
      expect(definition.identify(new URL(address))).toBeNull();
    for (const address of [direct + '&chapter_slot=1', reader.replace('0_0.html', '0_0_1.html'), reader.replace('0_0.html', '00_0.html'), url.replace('/comic/', '/other/')])
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
  it.each(['missing-next', 'foreign-next', 'loop', 'part-count', 'parent', 'canonical', 'foreign-image', 'duplicate-slot', 'no-body', 'early-end'])('rejects %s reader without a partial success', async mode => {
    let html = readerHtml();
    if (mode === 'missing-next') html = html.replace('id="next-chapter"', 'id="missing"');
    if (mode === 'foreign-next') html = html.replace('0_0_2.html', '0_1_2.html');
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(catalogHtml().replace('查看全部27', '查看全部28'))));
    await expect(readSourceCatalog(url)).rejects.toThrow();
    expect(await catalog.list('entries', {index: 'comicId', range: imported.id})).toEqual(before);
    const comic = await catalog.get('comics', imported.id), updated = parseCatalog(catalogHtml(28), url);
    await applyCatalogRefresh(imported.id, comic!.source.generation, updated);
    await applyCatalogRefresh(imported.id, comic!.source.generation, updated);
    expect((await catalog.list('entries', {index: 'comicId', range: imported.id}))).toHaveLength(28);
  });
});
