import {describe, expect, it, vi} from 'vitest';
import {definition, catalogKey, catalogUrl, chapterKey, rawLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {coverUrl, imageUrl, readerInfo} from '../html';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, cover, image, pagesHtml, pagesJson, reader, readerHtml, slug, url} from './fixtures';

describe('RawOtaku source contract', () => {
  it('binds encoded/unencoded manga and fractional chapters to one stable source namespace', () => {
    const loc = definition.identify(new URL(reader + '#page=2'))!;
    expect(loc).toMatchObject({kind: 'reader', pageKey: 'rawotaku:契約-fixture:ja:chapter:1', catalog: {url, key: catalogKey(slug)}});
    expect(definition.identify(new URL(decodeURI(reader)))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(url + '?read=1'))?.kind).toBe('catalog');
    expect(rawLocation(new URL(reader.replace('chapter-1-', 'chapter-1.5-')))?.chapter).toBe('1.5');
    expect(definition.sites![0].primaryLanguages).toEqual(['ja']);
    expect(definition.installation.optionalContentMatches).toEqual(['https://rawotaku.com/*']);
    expect(definition.sites![0].search!.requestOrigins.every(o => definition.installation.optionalOrigins!.includes(o))).toBe(true);
  });
  it.each(['http://rawotaku.com', 'https://rawotaku.com.evil.test', 'https://rawotaku.com:444', 'https://user:pass@rawotaku.com', 'ftp://rawotaku.com'])
    ('rejects forged or unsupported origin %s', host => expect(definition.identify(new URL(host + '/read/work-raw/'))).toBeNull());
  it.each(['/read/work/ja/chapter-1-raw/extra', '/read/work%2Fother-raw/', '/read/work%5Cother-raw/', '/read/work%252fother-raw/', '/read/%FF-raw/', '/home/'])
    ('keeps unsupported route %s out of imports and inline discovery', path => expect(definition.identify(new URL('https://rawotaku.com' + path))?.kind).toBe('other'));
  it('validates complete per-language directories, native forward order and dedicated covers', () => {
    const catalog = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(catalog.entries.map(e => [e.remoteId, e.contentLanguage, e.order])).toEqual([['11', 'ja', 0], ['15', 'ja', 1], ['21', 'ja', 2], ['31', 'en', 3]]);
    expect(catalog.cover).toEqual({url: cover}); expect(catalog.complete).toBe(true);
    expect(catalog.groups.map(g => g.entryIds.length)).toEqual([3, 1]);
    expect(catalog.entries[0].title).toBe('第1話: Title & 1');
    expect(catalog.entries[0].sequenceId).not.toBe(catalog.entries[3].sequenceId);
    expect(catalog.entries.every(e => e.readingSlotId === undefined)).toBe(true);
    expect(catalog.defaultEntryId).toBe(chapterKey(rawLocation(new URL(reader))!));
    for (const entry of catalog.entries) expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
  });
  it.each(['count', 'row', 'duplicate', 'remote', 'owner', 'language', 'canonical', 'closure'])('rejects %s directory evidence', kind => {
    let html = catalogHtml();
    if (kind === 'count') html = html.replace('3 章', '4 章');
    if (kind === 'row') html = html.replace('data-number="1.5"', 'data-number="9"');
    if (kind === 'duplicate') html = html.replace('chapter-1.5-raw', 'chapter-1-raw').replace('data-number="1.5"', 'data-number="1"');
    if (kind === 'remote') html = html.replace('data-id="15"', 'data-id="11"');
    if (kind === 'owner') html = html.replaceAll('/en/chapter', '/ja/chapter');
    if (kind === 'language') html = html.replace('English (1 章)', 'English (2 章)');
    if (kind === 'canonical') html = html.replace(`href="${url}"`, `href="${catalogUrl('Other')}"`);
    if (kind === 'closure') html = html.replace('</section>', '');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('checks the reader parent and source remote ID without executing its scripts', () => {
    expect(readerInfo(readerHtml(), rawLocation(new URL(reader))!)).toEqual({title: 'Work & Name', chapterTitle: '第1話: Title & 1', remoteId: '11'});
    expect(() => readerInfo(readerHtml().replace(`class="hr-manga" href="${url}"`, `class="hr-manga" href="${catalogUrl('Other')}"`), rawLocation(new URL(reader))!)).toThrow();
    expect(() => readerInfo(readerHtml().replace('data-id="11"', 'data-id="0"'), rawLocation(new URL(reader))!)).toThrow();
  });
  it('preserves distinct slots for repeated image URLs, filters ads and proves the complete API list', () => {
    const snapshot = validatePages(parsePages(pagesJson(), reader, 'Chapter 1'), definition.identify(new URL(reader))!);
    expect(snapshot).toMatchObject({direction: 'rtl', discoveryComplete: true, knownTotal: 2});
    expect(snapshot.items.map(i => [i.id, i.order, i.resource])).toEqual([
      ['page-0', 0, {kind: 'http', url: image}], ['page-1', 1, {kind: 'http', url: image}],
    ]);
  });
  it.each(['hole', 'duplicate', 'foreign', 'directory', 'missing', 'auth', 'truncated', 'status'])('rejects %s page evidence without renumbering', kind => {
    let html = pagesHtml();
    if (kind === 'hole') html = html.replace('alt="1"', 'alt="2"');
    if (kind === 'duplicate') html = html.replace('alt="1"', 'alt="0"');
    if (kind === 'foreign') html = html.replace('sv1.freeimgmg.online', 'sv1.freeimgmg.online.evil.test');
    if (kind === 'directory') html = html.replace(/(alt="1"[\s\S]*)\/files\/7\/11\//, '$1/files/7/12/');
    if (kind === 'missing') html = '<div id="vertical-content"></div>';
    if (kind === 'auth') html = html.replace('class="iv-card', 'data-auth="unsupported" class="iv-card');
    if (kind === 'truncated') html = html.slice(0, -6);
    expect(() => parsePages(kind === 'status' ? '{"status":0}' : pagesJson(html), reader, 'Title')).toThrow();
  });
  it('validates CDN paths and rejects credentials, placeholder and sibling-host images', () => {
    expect(imageUrl(image.replace('sv1', 'sv5'))).toContain('sv5');
    for (const target of [image.replace('https:', 'http:'), image + '?token=private', image.replace('sv1', 'other'), image.replace('/files/', '/ads/'), 'data:image/png;base64,a'])
      expect(() => imageUrl(target)).toThrow();
    expect(coverUrl('https://f002.backblazeb2.com/file/WCMS-Images/MangaOnline/p7?v=1')).toBeDefined();
    expect(coverUrl('https://evil.test/thumb/300/upload/2026/10/a.jpeg')).toBeUndefined();
  });
  it('makes two bounded page requests with the chapter Referer and honors cancellation between them', async () => {
    const request = vi.fn(async (target: string) => target.includes('/json/') ? pagesJson() : readerHtml());
    await network.pages(reader, {request});
    expect(request.mock.calls.map(c => c[0])).toEqual([reader, 'https://rawotaku.com/json/chapter?mode=vertical&id=11']);
    expect(request).toHaveBeenLastCalledWith('https://rawotaku.com/json/chapter?mode=vertical&id=11', {referer: reader});
    const controller = new AbortController(), cancelled = vi.fn(async () => {controller.abort(); return readerHtml();});
    await expect(network.pages(reader, {request: cancelled, signal: controller.signal})).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expect(network.catalog(url, {request: cancelled, signal: controller.signal})).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('never mutates a previous complete catalog when a refresh fails', async () => {
    const previous = parseCatalog(catalogHtml(), url), frozen = structuredClone(previous);
    await expect(network.catalog(url, {previous, request: async () => catalogHtml().replace('3 章', '4 章')})).rejects.toThrow();
    expect(previous).toEqual(frozen);
  });
});
