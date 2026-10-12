import {describe, expect, it, vi} from 'vitest';
import {definition, chapterUrl} from '../definition';
import {network, parseCatalog, parsePages, parseSearch, viewerRequest} from '../network';
import {bytes, decode, encode, number} from '../protobuf';
import {image} from '../image';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {inlineImageSize} from '../../../index';
import {pageFactories} from '../../../registry/pages';
import type {SourceNetworkContext} from '../../../contracts/network';
import {catalog, html, imagePage, readerUrl, recipe, viewer, workUrl} from './fixtures';

describe('COMIC FUZ identity and public catalog', () => {
  it('declares generic inline on both embedded catalog readers and chapter readers', () => {
    expect(definition).toMatchObject({inlineRecognition: 'generic', embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}});
    expect(definition.identify(new URL(workUrl + '?position=thumbnail'))).toMatchObject({kind: 'catalog', pageKey: 'comicfuz:manga:2062'});
    expect(definition.identify(new URL(readerUrl))).toMatchObject({kind: 'reader', pageKey: 'comicfuz:chapter:47170', catalog: {key: 'comicfuz:manga:2062', url: workUrl}});
    expect(inlineImageSize(1354, 1920, workUrl)).toBe(true);
    expect(inlineImageSize(80, 80, workUrl)).toBe(false);
    expect(inlineImageSize(1354, 1920, 'https://comic-fuz.com/search')).toBe(true);
  });
  it('uses the generic catalog image session without claiming complete DOM discovery or mutating its identity', async () => {
    const querySelectorAll = vi.fn(() => []), document = {querySelectorAll, defaultView: null} as unknown as Document;
    const location = Object.freeze(definition.identify(new URL(workUrl))!), controller = new AbortController();
    const session = pageFactories.comicfuz({document, location, signal: controller.signal});
    expect(session.inlineTargets()).toEqual([]);
    expect(querySelectorAll).toHaveBeenCalledWith('img:not([data-nc-canvas-translation])');
    expect(location.kind).toBe('catalog');
    expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
    session.dispose(); expect(() => session.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
    querySelectorAll.mockClear();
    const other = pageFactories.comicfuz({document, location: definition.identify(new URL('https://comic-fuz.com/search'))!, signal: controller.signal});
    expect(other.inlineTargets()).toEqual([]); expect(querySelectorAll).toHaveBeenCalledWith('img:not([data-nc-canvas-translation])');
    controller.abort(Error('navigation')); expect(() => other.inlineTargets()).toThrow('navigation'); other.dispose();
  });
  it.each(['http://comic-fuz.com/manga/2062', 'https://comic-fuz.com.evil.test/manga/2062', 'https://user@comic-fuz.com/manga/2062', 'https://comic-fuz.com:8080/manga/2062'])('rejects foreign origin %s', url => {
    expect(definition.identify(new URL(url))).toBeNull();
  });
  it.each(['/manga/0', '/manga/4294967296', '/manga/2062/evil', '/manga/2062?chapterId=0', '/manga/2062?chapterId=1&chapterId=2', '/book/100', '/magazine/100'])('does not claim unsupported content %s', path => {
    expect(definition.identify(new URL('https://comic-fuz.com' + path))?.kind).toBe('other');
  });
  it('retains volume groups, ascending source order, names and locked entries', () => {
    const data = validateCatalog(parseCatalog(html(), workUrl), [definition]);
    expect(data.entries.map(entry => entry.remoteId)).toEqual(['47170', '47173', '47176']);
    expect(data.entries.map(entry => entry.readable)).toEqual([true, false, false]);
    expect(data.entries[0]).toMatchObject({title: '第0話 導入', url: readerUrl});
    expect(data.entries[0].sequenceId).not.toBe(data.entries[1].sequenceId);
    expect(data.groups.map(group => group.title)).toEqual(['第1巻', '第2巻']);
    expect(data.defaultEntryId).toBe('comicfuz:chapter:47170');
    expect(data.cover?.url).toContain('/c/version/art.webp');
  });
  it.each(['manga', 'query', 'duplicate', 'missing', 'cover', 'header', 'point'])('fails closed on %s corruption', kind => {
    const data = catalog(), props = data.props.pageProps;
    if (kind === 'manga') props.manga.mangaId++;
    if (kind === 'query') data.query.mangaId = '123';
    if (kind === 'duplicate') props.chapters[0].chapters.push(props.chapters[0].chapters[0]);
    if (kind === 'missing') props.chapters.pop();
    if (kind === 'cover') props.manga.mainThumbnailUrl = 'https://evil.test/c/version/art.webp';
    if (kind === 'header') props.chapters[0].bookIssueHeader.bookIssueId = '100';
    if (kind === 'point') props.chapters[0].chapters[0].pointConsumption.amount = -1;
    expect(() => parseCatalog(html(data), workUrl)).toThrow();
  });
  it('rejects empty, malformed and multiple Next payloads', () => {
    for (const raw of ['', '<script id="__NEXT_DATA__">{</script>', html() + html()]) expect(() => parseCatalog(raw, workUrl)).toThrow();
  });
  it('preserves a latest-episodes header with no book ID separately from volume groups', () => {
    const data = catalog();
    Object.assign(data.props.pageProps.chapters[0].bookIssueHeader, {bookIssueId: undefined, text: '最新エピソードはこちら！'});
    const result = parseCatalog(html(data), workUrl);
    expect(result.groups[1]).toMatchObject({id: 'chapters', title: '最新エピソードはこちら！'});
    expect(result.entries[1].sequenceId).not.toBe(result.entries[0].sequenceId);
  });
  it('refreshes once without mutating the prior snapshot and propagates failure', async () => {
    const previous = parseCatalog(html(), workUrl), frozen = JSON.stringify(previous), request = vi.fn(async () => html());
    const next = await network.catalog(workUrl, {previous, request});
    expect(next.entries).toEqual(previous.entries); expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(Error('offline'));
    await expect(network.catalog(workUrl, {previous, request})).rejects.toThrow('offline');
    expect(JSON.stringify(previous)).toBe(frozen);
  });
});
describe('COMIC FUZ binary API and page manifest', () => {
  it('explicitly disables ticket and both point balances', () => {
    const request = decode(viewerRequest('47170'));
    expect(number(request, 2)).toBe(0); expect(number(request, 4)).toBe(47170);
    expect([...decode(bytes(request, 3)!).values()]).toEqual([[0], [0]]);
    expect([...decode(bytes(request, 1)!).values()]).toEqual([[2]]);
  });
  it('keeps repeated URLs as independent page slots, omits explicit ads and preserves gaps', () => {
    const raw = viewer([imagePage(), encode([4, new Uint8Array()]), imagePage(), imagePage(3, [[7, 1]]), encode([3, new Uint8Array()])]);
    const value = validatePages(parsePages(raw, readerUrl), definition.identify(new URL(readerUrl))!);
    expect(value.knownTotal).toBe(2); expect(value.items.map(item => item.order)).toEqual([0, 2]);
    expect(value.items[0].resource).toEqual(value.items[1].resource);
    expect(value.items[0].contentKey).toBe('comicfuz:/f/version/bx2/0.jpeg.enc');
    expect(value.items[0].resource).toMatchObject({processing: recipe});
  });
  it('keeps content identity on signed URL renewal', () => {
    const before = parsePages(viewer(), readerUrl), after = parsePages(viewer([imagePage(0, [[1, '/f/version/bx2/0.jpeg.enc?h=renewed&e=6000000000']]), imagePage(1)]), readerUrl);
    expect(before.items[0].contentKey).toBe(after.items[0].contentKey);
    expect(before.items[0].resource).not.toEqual(after.items[0].resource);
  });
  it('accepts base-64 page filenames beyond the first ten pages', () => {
    expect(parsePages(viewer([imagePage(10, [[1, '/f/version/bx2/a.jpeg.enc?h=fixture&e=5000000000']])]), readerUrl).items).toHaveLength(1);
  });
  it.each([
    [1, 'https://evil.test/f/version/bx2/0.jpeg.enc'], [1, '/f/version/wrong/0.jpeg.enc'], [1, '/m/ad/0.jpeg.enc'],
    [3, 'bad'], [4, ''], [5, 0], [6, 100001], [7, 2],
  ] as Array<[number, number | string]>)('rejects bad image field %s', (field, value) => {
    expect(() => parsePages(viewer([imagePage(0, [[field, value]])]), readerUrl)).toThrow();
  });
  it('rejects mismatched identities and missing or unavailable viewer data', () => {
    expect(() => parsePages(viewer(), chapterUrl('1', '47170'))).toThrow();
    expect(() => parsePages(viewer(), chapterUrl('2062', '47173'))).toThrow();
    expect(() => parsePages(viewer([], [[12, 47173]]), readerUrl)).toThrow();
    expect(() => parsePages(viewer([], [[5, encode([2, encode([1, 999])])]]), readerUrl)).toThrow();
    expect(() => parsePages(encode([11, encode([1, 2062])], [12, 47170], [5, encode([2, encode([1, 47170])])]), readerUrl)).toThrow('不可读');
  });
  it('does not re-fetch the work directory to read a bound chapter', async () => {
    const request = vi.fn(), requestBytes = vi.fn(async () => viewer());
    await network.pages(readerUrl, {request, requestBytes});
    expect(request).not.toHaveBeenCalled(); expect(requestBytes).toHaveBeenCalledExactlyOnceWith('https://api.comic-fuz.com/v1/web_manga_viewer_2', {referer: 'https://comic-fuz.com/', body: viewerRequest('47170')});
  });
  it('checks cancellation before and after requests', async () => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(Error('stop')); return html();});
    await expect(network.catalog(workUrl, {request, signal: controller.signal})).rejects.toThrow('stop');
    const requestBytes = vi.fn(async () => viewer());
    await expect(network.pages(readerUrl, {request, requestBytes, signal: controller.signal})).rejects.toThrow('stop');
    expect(requestBytes).not.toHaveBeenCalled();
  });
  it('search uses one-based paging and no catalog fan-out', async () => {
    const row = encode([1, 2062], [2, 'Fixture Manga'], [4, '/c/version/art.webp']);
    const response = encode([2, row], [6, 2]), request = vi.fn(), requestBytes = vi.fn<NonNullable<SourceNetworkContext['requestBytes']>>(async () => response);
    const result = await network.search({siteId: 'comicfuz', query: ' Manga '}, {request, requestBytes});
    expect(result.nextCursor).toBe('2'); expect(result.items[0].catalogUrl).toBe(workUrl);
    expect(number(decode(requestBytes.mock.calls[0][1].body), 4)).toBe(1); expect(request).not.toHaveBeenCalled();
    expect(parseSearch(encode([6, 0]), 1)).toEqual({items: []});
    expect(() => parseSearch(encode([2, row], [2, row], [6, 1]), 1)).toThrow();
    expect(() => parseSearch(encode([6, 2]), 1)).toThrow();
    await expect(network.search({siteId: 'comicfuz', query: 'Manga', cursor: '0'}, {request, requestBytes})).rejects.toThrow();
  });
  it.each([[0], [10, 5, 1], [8, 128], [11], [15], [8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]])('rejects malformed wire data %s', (...values) => {
    expect(() => decode(new Uint8Array(values))).toThrow();
  });
});
describe('COMIC FUZ image decoding', () => {
  it('decodes using the page-provided AES key and IV without an inline hook', async () => {
    const raw = new Uint8Array([255, 216, 255, 224, ...new Array(60).fill(3)]);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), 'AES-CBC', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(16).fill(34)}, key, raw);
    const decoded = await image.decode!(new Blob([encrypted]), new Headers(), recipe);
    expect(decoded.type).toBe('image/jpeg'); expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(raw);
    expect(image.decodeInline).toBeUndefined();
    const controller = new AbortController(); controller.abort(Error('stop'));
    await expect(image.decode!(new Blob([encrypted]), new Headers(), recipe, controller.signal)).rejects.toThrow('stop');
    await expect(image.decode!(new Blob([encrypted]), new Headers(), 'wrong')).rejects.toThrow();
    const plain = new Blob(['cover']); expect(await image.decode!(plain, new Headers(), undefined)).toBe(plain);
  });
});
