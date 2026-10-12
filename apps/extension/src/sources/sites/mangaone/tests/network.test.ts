import {describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl, location} from '../definition';
import {network, parseChapterPage, parsePages, parseSearch, parseTitle} from '../network';
import {image} from '../image';
import {encode} from '../../../shared/protobuf';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchPage} from '../../../core/search';
import {pageFactories} from '../../../registry/pages';
import type {SourceNetworkContext} from '../../../contracts/network';
import {artwork, chapter, chapters, detail, imagePage, imageUrl, readerUrl, recipe, search, title, viewer, workUrl} from './fixtures';

const context = (read = async (url: string) => new URL(url).searchParams.get('rq') === 'title/list' ? detail() : chapters()) =>
  ({request: vi.fn(), requestBytes: vi.fn<NonNullable<SourceNetworkContext['requestBytes']>>(read)});
describe('Manga One identity and generic recognition', () => {
  it('binds numeric chapters and the real first-chapter work entry', () => {
    expect(definition.identify(new URL(workUrl + '?page=2#chapterList'))).toMatchObject({kind: 'catalog', pageKey: 'mangaone:9', catalog: {url: workUrl}});
    expect(definition.identify(new URL(readerUrl + '?paid_point=100'))).toMatchObject({kind: 'reader', pageKey: 'mangaone:9:11', catalog: {url: workUrl}});
    expect(location(new URL(readerUrl))).toEqual({work: '9', chapter: '11'});
    expect(definition).toMatchObject({inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720}, embeddedEntry: 'floating',
      capabilities: {importable: true, pages: true, completePageList: true}});
    expect(definition.sites![0]).toMatchObject({search: true, adaptedOn: '2026-10-03', primaryLanguages: ['ja'], accessTags: ['paid-content']});
    expect(definition.installation.optionalContentMatches).toEqual(['https://manga-one.com/*']);
  });
  it.each(['http://manga-one.com', 'https://manga-one.com.evil.test', 'https://app.manga-one.com',
    'https://manga-one.com:444', 'https://user:pass@manga-one.com'])('rejects spoofed origin %s', host => {
    expect(definition.identify(new URL(host + '/manga/9/chapter/11'))).toBeNull();
  });
  it.each(['/manga/9', '/manga/09/chapter/11', '/manga/9/chapter/0', '/manga/9/chapter/011', '/manga/9/chapter/4294967296',
    '/manga/9/chapter/11/extra', '/manga/9/chapter/%31', '/manga/9/choitashi/11', '/manga/9/volume/11', '/search'])('does not import %s', path => {
    expect(definition.identify(new URL(path, workUrl))?.kind).toBe('other');
  });
  it.each([workUrl, readerUrl, 'https://manga-one.com/search'])('uses generic lifecycle on %s without complete DOM discovery', async url => {
    const controller = new AbortController(), querySelectorAll = vi.fn(() => []);
    const session = pageFactories.mangaone({document: {querySelectorAll, defaultView: null} as unknown as Document,
      location: definition.identify(new URL(url))!, signal: controller.signal});
    expect(session.inlineTargets()).toEqual([]);
    expect(querySelectorAll).toHaveBeenCalledWith('img:not([data-nc-canvas-translation])');
    expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
    controller.abort(Error('navigation')); expect(() => session.inlineTargets()).toThrow('navigation'); session.dispose();
  });
});
describe('Manga One catalog completeness', () => {
  it('validates dedicated artwork, source order, subtitles and locked entries', async () => {
    const ctx = context(), result = validateCatalog(await network.catalog(workUrl, ctx), [definition]);
    expect(result).toMatchObject({complete: true, title: 'Fixture Manga', cover: {url: artwork}, defaultEntryId: 'mangaone:9:11'});
    expect(result.entries.map(entry => [entry.id, entry.order, entry.readable])).toEqual([['mangaone:9:11', 0, true], ['mangaone:9:12', 1, false]]);
    expect(result.entries[0].title).toBe('第11話 Subtitle');
    expect(result.groups[0].entryIds).toEqual(result.entries.map(entry => entry.id));
    expect(ctx.requestBytes).toHaveBeenCalledTimes(2); expect(ctx.request).not.toHaveBeenCalled();
    expect(ctx.requestBytes.mock.calls.every(([, options]) => options.body === undefined && options.form === undefined)).toBe(true);
  });
  it('reads each advertised page once and rejects duplicate, truncated or changing catalogs', async () => {
    const first = Array.from({length: 100}, (_, i) => chapter(i + 1));
    let last = chapters([chapter(101)], 2, 101);
    const ctx = context(async url => {const q = new URL(url).searchParams;
      return q.get('rq') === 'title/list' ? detail() : q.get('page') === '1' ? chapters(first, 1, 101) : last;});
    const result = await network.catalog(workUrl, ctx);
    expect(result.entries).toHaveLength(101); expect(ctx.requestBytes).toHaveBeenCalledTimes(3);
    expect(result.entries[100].order).toBe(100);
    for (const bad of [chapters([chapter(1)], 2, 101), chapters([chapter(101), chapter(102)], 2, 102), chapters([], 2, 101)]) {
      last = bad; await expect(network.catalog(workUrl, ctx)).rejects.toThrow();
    }
    await expect(network.catalog(workUrl, context(async url => url.includes('title%2Flist') ? detail() : chapters([chapter(), chapter()])))).rejects.toThrow();
  });
  it('rejects wrong work metadata, non-artwork, count and pagination mismatches', () => {
    expect(() => parseTitle(detail(8), '9')).toThrow();
    expect(() => parseTitle(detail(9, [[16, imageUrl]]), '9')).toThrow();
    expect(() => parseTitle(detail(9, [[16, artwork.replace('app.manga-one.com', 'evil.test')]]), '9')).toThrow();
    for (const payload of [chapters(undefined, 1, 2, [[2, encode([1, 2], [2, 1])]]), chapters(undefined, 1, 2, [[3, 0]]),
      chapters(undefined, 1, 2, [[4, 1]]), chapters(undefined, 1, 2, [[5, 10001]]), chapters([chapter(11, 6)])])
      expect(() => parseChapterPage(payload, '9', 1)).toThrow();
  });
  it('keeps updates stateless and preserves the previous snapshot on failure and cancellation', async () => {
    const previous = await network.catalog(workUrl, context()), saved = structuredClone(previous);
    const current = await network.catalog(workUrl, {...context(async url => url.includes('title%2Flist') ? detail() : chapters([chapter(), chapter(12), chapter(13)])), previous});
    expect(current.entries).toHaveLength(3); expect(previous).toEqual(saved);
    await expect(network.catalog(workUrl, {...context(async () => {throw Error('offline');}), previous})).rejects.toThrow('offline');
    expect(previous).toEqual(saved);
    const controller = new AbortController(), ctx = context(async () => {controller.abort(Error('stop')); return detail();});
    await expect(network.catalog(workUrl, {...ctx, signal: controller.signal})).rejects.toThrow('stop');
    ctx.requestBytes.mockClear();
    await expect(network.catalog(workUrl, {...ctx, signal: controller.signal})).rejects.toThrow('stop');
    expect(ctx.requestBytes).not.toHaveBeenCalled();
  });
});
describe('Manga One public pages and safe requests', () => {
  it('preserves duplicate slots, gaps and version identity while excluding promotions', () => {
    const raw = viewer([imagePage(), encode([2, new Uint8Array()]), encode([3, new Uint8Array()]), imagePage()]);
    const result = validatePages(parsePages(raw, readerUrl), definition.identify(new URL(readerUrl))!);
    expect(result.items.map(item => item.order)).toEqual([0, 3]); expect(result.knownTotal).toBe(2);
    expect(result.items[0].resource).toEqual(result.items[1].resource); expect(result.items[0].id).not.toBe(result.items[1].id);
    expect(result.items[0].resource).toMatchObject({processing: recipe});
    const refreshed = parsePages(viewer([imagePage([[1, imageUrl.replace('fixture', 'renewed')]])]), readerUrl);
    expect(refreshed.items[0].contentKey).toBe(result.items[0].contentKey);
    expect(parsePages(viewer([imagePage([[1, imageUrl.replace('/123/', '/124/')]])]), readerUrl).items[0].contentKey).not.toBe(result.items[0].contentKey);
  });
  it('rejects foreign work/chapter/image ownership, missing slots and malformed decoding metadata', () => {
    for (const raw of [viewer([], [[5, title(8)]]), viewer([], [[7, chapter(12)]]), viewer([]), viewer(undefined, [[3, 'bad']]),
      viewer(undefined, [[4, 'bad']]), viewer([encode([1, encode([1, imageUrl])], [2, new Uint8Array()])]), viewer([encode([99, 'unknown'])]),
      viewer([imagePage([[1, imageUrl.replace('/11/', '/12/')]])]), viewer([imagePage([[1, imageUrl.replace('app.manga-one.com', 'evil.test')]])]),
      viewer([imagePage([[1, artwork]])]), viewer([imagePage([[2, 0]])])]) expect(() => parsePages(raw, readerUrl)).toThrow();
    expect(() => parsePages(viewer(), chapterUrl('10', '11'))).toThrow();
    expect(() => parsePages(viewer(), workUrl)).toThrow();
  });
  it.each([0, 2, 3, 4, 5])('rejects non-public badge %s', badge => {
    expect(() => parsePages(viewer(undefined, [[7, chapter(11, badge)]]), readerUrl)).toThrow('不会消耗');
  });
  it.each([1, 2, 3, 4, 5, 6])('never accepts required item field %s, even with FREE badge', field => {
    const row = chapter(11, 1, [[16, encode([field, 1])]]);
    expect(parseChapterPage(chapters([row]), '9', 1).entries[0].readable).toBe(false);
    expect(() => parsePages(viewer(undefined, [[7, row]]), readerUrl)).toThrow('不会消耗');
  });
  it('discards URL spending parameters, never supplies a CSRF token and makes only one zero-spend viewer request', async () => {
    const ctx = context(async () => viewer());
    await network.pages(readerUrl + '?free_point=10&event_point=20&paid_point=30&use_free_by_everyday=true&csrf_token=unsafe', ctx);
    expect(ctx.requestBytes).toHaveBeenCalledTimes(1);
    const [url, options] = ctx.requestBytes.mock.calls[0], q = new URL(url).searchParams;
    expect(Object.fromEntries(q)).toEqual({rq: 'viewer_v2', title_id: '9', chapter_id: '11', list_type: 'chapter', sort_type: 'asc',
      page: '1', limit: '10', free_point: '0', event_point: '0', paid_point: '0'});
    expect(options.body).toEqual(new Uint8Array()); expect(options.form).toBeUndefined();
    await expect(network.pages(readerUrl, {...ctx, signal: AbortSignal.abort(Error('stop'))})).rejects.toThrow('stop');
    expect(ctx.requestBytes).toHaveBeenCalledTimes(1);
  });
});
describe('Manga One lightweight search and AES decoding', () => {
  it('deduplicates works, excludes recommendations, slices results and validates cursors', async () => {
    const raw = search([9, ...Array.from({length: 56}, (_, index) => index + 1)]);
    const first = parseSearch(raw, 0), second = parseSearch(raw, 50);
    expect(first.items).toHaveLength(50); expect(first.nextCursor).toBe('50'); expect(second.items).toHaveLength(6);
    expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(50);
    expect(parseSearch(encode([4, title()]), 0)).toEqual({items: []});
    expect(parseSearch(new Uint8Array(), 0)).toEqual({items: []});
    const ctx = context(async () => search());
    await network.search({siteId: 'mangaone', query: '漫画 & test'}, ctx);
    expect(ctx.requestBytes).toHaveBeenCalledTimes(1);
    expect(new URL(ctx.requestBytes.mock.calls[0][0]).searchParams.get('query')).toBe('漫画 & test');
    for (const cursor of ['-1', '01', '1', '10000', '50']) await expect(network.search({siteId: 'mangaone', query: 'x', cursor}, ctx)).rejects.toThrow();
  });
  it('restores original bytes and rejects bad recipes, non-images and aborted decoding', async () => {
    const plain = new Uint8Array([255, 216, 255, 224, ...new Array(100).fill(3)]);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), 'AES-CBC', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(16).fill(2)}, key, plain);
    const result = await image.decode!(new Blob([encrypted]), new Headers(), recipe);
    expect(result.type).toBe('image/jpeg'); expect(new Uint8Array(await result.arrayBuffer())).toEqual(plain);
    for (const processing of ['bad', recipe.slice(0, -2)]) await expect(image.decode!(new Blob([encrypted]), new Headers(), processing)).rejects.toThrow();
    const junk = await crypto.subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(16).fill(2)}, key, new TextEncoder().encode('not an image'));
    await expect(image.decode!(new Blob([junk]), new Headers(), recipe)).rejects.toThrow('还原失败');
    await expect(image.decode!(new Blob([encrypted]), new Headers(), recipe, AbortSignal.abort(Error('stop')))).rejects.toThrow('stop');
    const cover = new Blob(['plain']); expect(await image.decode!(cover, new Headers(), undefined)).toBe(cover);
    expect(image.decodeInline).toBeUndefined();
  });
});
