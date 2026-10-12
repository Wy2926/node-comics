import {describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl} from '../definition';
import {network, parseCatalog, parseChapters, parsePages, parseSearch} from '../network';
import {image} from '../image';
import {encode} from '../../../shared/protobuf';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchPage} from '../../../core/search';
import {pageFactories} from '../../../registry/pages';
import type {SourceNetworkContext} from '../../../contracts/network';
import {artwork, chapter, chapters, detail, imagePage, imageUrl, readerUrl, recipe, search, searchRow, viewer, workUrl} from './fixtures';

describe('Zebrack identity and capabilities', () => {
  it('recognizes title, complete chapter list and reader identities with a bound work', () => {
    expect(definition.identify(new URL(workUrl + '/chapter/list#chapter2231'))).toMatchObject({kind: 'catalog', pageKey: 'zebrack:title:9', catalog: {url: workUrl}});
    expect(definition.identify(new URL(readerUrl + '?from=detail'))).toMatchObject({kind: 'reader', pageKey: 'zebrack:title:9:chapter:2231', catalog: {url: workUrl}});
    expect(definition.sites![0]).toMatchObject({search: true, primaryLanguages: ['ja'], accessTags: ['paid-content']});
    expect(definition.installation.optionalContentMatches).toEqual(['https://zebrack-comic.shueisha.co.jp/*']);
  });
  it.each(['http://zebrack-comic.shueisha.co.jp/title/9', 'https://zebrack-comic.shueisha.co.jp.evil.test/title/9',
    'https://user@zebrack-comic.shueisha.co.jp/title/9', 'https://zebrack-comic.shueisha.co.jp:8080/title/9'])('rejects foreign origin %s', url => {
    expect(definition.identify(new URL(url))).toBeNull();
  });
  it.each(['/title/0', '/title/09', '/title/4294967296', '/title/9/chapter/0/viewer', '/title/9/volume/1/viewer', '/search'])('does not import unsupported URL %s', path => {
    expect(definition.identify(new URL(path, workUrl))).toMatchObject({kind: 'other'});
  });
  it('reuses generic loaded-image lifecycle without claiming complete DOM discovery', async () => {
    const controller = new AbortController(), querySelectorAll = vi.fn(() => []);
    const session = pageFactories.zebrack({document: {querySelectorAll, defaultView: null} as unknown as Document,
      location: definition.identify(new URL(readerUrl))!, signal: controller.signal});
    expect(session.inlineTargets()).toEqual([]);
    expect(querySelectorAll).toHaveBeenCalledWith('img:not([data-nc-canvas-translation])');
    expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
    controller.abort(Error('navigation')); expect(() => session.inlineTargets()).toThrow('navigation');
    session.dispose();
  });
});
describe('Zebrack full chapter catalog', () => {
  it('preserves source ordering, exact group titles, locked entries and dedicated artwork', () => {
    const result = validateCatalog(parseCatalog(detail(), chapters(), workUrl), [definition]);
    expect(result.complete).toBe(true); expect(result.cover?.url).toBe(artwork);
    expect(result.groups).toEqual([{id: 'volume-7', title: 'Fixture Manga 1', entryIds: result.entries.map(entry => entry.id), complete: true}]);
    expect(result.entries.map(entry => [entry.remoteId, entry.order, entry.readable])).toEqual([['2231', 0, true], ['2232', 1, false]]);
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it.each([1, 2, 3, 4, 5, 6])('never implicitly rents or spends on source status %s', status => {
    expect(parseChapters(chapters([chapter(2231, status)]), '9').entries[0].readable).toBe(false);
  });
  it('rejects mismatched works, duplicate chapters/groups, invalid statuses and dangling indexes', () => {
    for (const response of [chapters([chapter(), chapter()]), chapters([chapter(2231, 7)]), chapters([chapter(2231, 0, [[2, 8]])]),
      chapters([chapter(2232)]), chapters(undefined, [[1, 8]]), chapters(undefined, [[2, 9999]]),
      chapters(undefined, [[4, encode([2, 7], [3, chapter()])], [4, encode([2, 7], [3, chapter(2232)])]])])
      expect(() => parseChapters(response, '9')).toThrow();
    expect(() => parseCatalog(detail([[1, 8]]), chapters(), workUrl)).toThrow();
    expect(() => parseCatalog(detail([[2, 'Wrong title']]), chapters(), workUrl)).toThrow();
    expect(() => parseCatalog(detail([[11, encode([1, artwork.replace('/9/', '/8/')])]]), chapters(), workUrl)).toThrow();
  });
  it('fails explicitly for volume-only works and preserves previous snapshots on failure', async () => {
    expect(() => parseChapters(encode([1, 9], [7, 'Fixture']), '9')).toThrow('話読み');
    const previous = parseCatalog(detail(), chapters(), workUrl), before = structuredClone(previous);
    const requestBytes = vi.fn(async () => {throw Error('source unavailable');});
    await expect(network.catalog(workUrl, {request: vi.fn(), requestBytes, previous})).rejects.toThrow('source unavailable');
    expect(previous).toEqual(before);
  });
  it('reads exactly two APIs and reflects later complete snapshots without private caching', async () => {
    const requestBytes = vi.fn<NonNullable<SourceNetworkContext['requestBytes']>>(async url => url.includes('title_detail') ? detail() : chapters([chapter(), chapter(2232), chapter(2233)]));
    const previous = parseCatalog(detail(), chapters(), workUrl);
    const current = await network.catalog(workUrl, {request: vi.fn(), requestBytes, previous});
    expect(current.entries).toHaveLength(3); expect(previous.entries).toHaveLength(2); expect(requestBytes).toHaveBeenCalledTimes(2);
    expect(requestBytes.mock.calls.every(([, options]) => !options.body && !options.form)).toBe(true);
  });
});
describe('Zebrack page manifests and safety', () => {
  it('keeps independent repeated image slots, omits ads and retains gaps without claiming DOM completeness', () => {
    const raw = viewer([imagePage(), encode([4, new Uint8Array()]), imagePage()]);
    const result = validatePages(parsePages(raw, readerUrl), definition.identify(new URL(readerUrl))!);
    expect(result.items.map(item => item.order)).toEqual([0, 2]); expect(result.knownTotal).toBe(2);
    expect(result.items[0].resource).toEqual(result.items[1].resource); expect(result.items[0].id).not.toBe(result.items[1].id);
    expect(result.items[0].resource).toMatchObject({processing: recipe});
    const refreshed = parsePages(viewer([imagePage([[1, imageUrl + '?drm_key=renewed&expires=2']])]), readerUrl);
    expect(result.items[0].contentKey).toBe(refreshed.items[0].contentKey);
  });
  it.each([[1, 'https://evil.test/100.jpg'], [1, imageUrl.replace('/2231/', '/2232/')], [1, artwork],
    [2, 'bad'], [4, encode([1, 0], [2, 100])]] as Array<[number, string | Uint8Array]>)('rejects unsafe image field %s', (field, value) => {
    expect(() => parsePages(viewer([imagePage([[field, value]])]), readerUrl)).toThrow();
  });
  it('checks ownership, error responses, empty and ambiguous page variants', () => {
    expect(() => parsePages(viewer(), chapterUrl('10', '2231'))).toThrow();
    expect(() => parsePages(viewer(), chapterUrl('9', '2232'))).toThrow();
    expect(() => parsePages(viewer([], [[10, encode([1, 8])]]), readerUrl)).toThrow();
    expect(() => parsePages(viewer([]), readerUrl)).toThrow();
    expect(() => parsePages(encode([101, encode([3, 3])]), readerUrl)).toThrow('不会消耗');
    expect(() => parsePages(viewer([encode([1, encode([1, imageUrl])], [4, new Uint8Array()])]), readerUrl)).toThrow();
  });
  it('preflights public FREE status, sends zero spending parameters and never requests locked viewers', async () => {
    const request = vi.fn(), requestBytes = vi.fn<NonNullable<SourceNetworkContext['requestBytes']>>(async url => url.includes('title_chapter_list') ? chapters() : viewer());
    await network.pages(readerUrl, {request, requestBytes});
    expect(requestBytes.mock.calls[1]).toEqual(['https://api2.zebrack-comic.com/api/v3/chapter_viewer',
      {referer: 'https://zebrack-comic.shueisha.co.jp/', form: {os: 'browser', title_id: '9', chapter_id: '2231', type: 'normal', event_point: '0', paid_point: '0'}}]);
    requestBytes.mockClear();
    await expect(network.pages(chapterUrl('9', '2232'), {request, requestBytes})).rejects.toThrow('不会消耗');
    expect(requestBytes).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });
  it('honors cancellation before and after requests and does not proceed to viewer POST', async () => {
    const controller = new AbortController(), requestBytes = vi.fn(async () => {controller.abort(Error('stop')); return chapters();});
    await expect(network.pages(readerUrl, {request: vi.fn(), requestBytes, signal: controller.signal})).rejects.toThrow('stop');
    expect(requestBytes).toHaveBeenCalledTimes(1);
    requestBytes.mockClear();
    await expect(network.catalog(workUrl, {request: vi.fn(), requestBytes, signal: controller.signal})).rejects.toThrow('stop');
    expect(requestBytes).not.toHaveBeenCalled();
  });
});
describe('Zebrack name search', () => {
  it('normalizes only explicit source work links, deduplicates and slices to the public 50-item budget', () => {
    const raw = search([searchRow(), ...Array.from({length: 56}, (_, index) => searchRow(index + 1))]);
    const first = parseSearch(raw, 0), second = parseSearch(raw, 50);
    expect(first.items).toHaveLength(50); expect(first.nextCursor).toBe('50'); expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeUndefined();
    expect(validateSearchPage(first, definition, definition.sites![0], [definition]).items).toHaveLength(50);
    expect(parseSearch(search([]), 0)).toEqual({items: []});
  });
  it.each(['https://evil.test/title/9', 'garaku://title_detail?titleId=9&titleId=8', 'garaku://title_detail?titleId=0',
    'garaku://volume_detail?titleId=9', 'garaku://user@title_detail?titleId=9'])('rejects unsupported transition %s', target => {
    expect(() => parseSearch(search([searchRow(9, [[2, target]])]), 0)).toThrow();
  });
  it('makes one read-only request without fetching work catalogs and rejects invalid cursors', async () => {
    const requestBytes = vi.fn<NonNullable<SourceNetworkContext['requestBytes']>>(async () => search()), request = vi.fn();
    expect((await network.search({siteId: 'zebrack', query: '漫画 & test'}, {request, requestBytes})).items).toHaveLength(1);
    expect(requestBytes).toHaveBeenCalledTimes(1); expect(new URL(requestBytes.mock.calls[0][0] as string).searchParams.get('keyword')).toBe('漫画 & test');
    for (const cursor of ['-1', '01', '1', '10000']) await expect(network.search({siteId: 'zebrack', query: 'x', cursor}, {request, requestBytes})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
describe('Zebrack XOR decoding', () => {
  it('roundtrips bytes and rejects invalid recipes, invalid images and cancelled reads', async () => {
    const plain = new Uint8Array([255, 216, 255, 224, ...new Array(100).fill(3)]), encrypted = plain.map(value => value ^ 1);
    const result = await image.decode!(new Blob([encrypted]), new Headers(), recipe);
    expect(result.type).toBe('image/jpeg'); expect(new Uint8Array(await result.arrayBuffer())).toEqual(plain);
    for (const processing of ['bad', recipe.slice(0, -2)]) await expect(image.decode!(new Blob([encrypted]), new Headers(), processing)).rejects.toThrow();
    await expect(image.decode!(new Blob(['invalid']), new Headers(), recipe)).rejects.toThrow();
    const signal = AbortSignal.abort(Error('stop'));
    await expect(image.decode!(new Blob([encrypted]), new Headers(), recipe, signal)).rejects.toThrow('stop');
    const cover = new Blob(['plain']); expect(await image.decode!(cover, new Headers(), undefined)).toBe(cover);
    expect(image.decodeInline).toBeUndefined();
  });
});
