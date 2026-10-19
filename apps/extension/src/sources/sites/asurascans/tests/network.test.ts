import {describe, expect, it, vi} from 'vitest';
import {definition, asuraLocation, catalogKey, chapterKey} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch, searchUrl} from '../search';
import {parseProps, prop} from '../html';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, chapter, cover, detail, directory, hit, identity, image, island, origin, reader, readerHtml,
  readerUrl, results, searchHtml, url, work} from './fixtures';

describe('Asura Scans', () => {
  it('recognizes work/decimal chapter routes, with identities independent of rotating URL suffixes', () => {
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey(work), catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(readerUrl))).toMatchObject({kind: 'reader', pageKey: chapterKey(work, '1'), catalog: {url}});
    expect(definition.identify(new URL(url + '/chapter/1.5'))?.pageKey).toBe(chapterKey(work, '1.5'));
    expect(definition.identify(new URL(url.replace('1234abcd', 'aabbccdd')))?.pageKey).toBe(catalogKey(work));
    expect(definition.identify(new URL(url.replace('1234abcd', 'xyz123ab')))?.pageKey).toBe(catalogKey(work));
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
      capabilities: {importable: true, pages: true, catalog: true, inline: true, completePageList: true},
      installation: {autoContentMatches: [], optionalContentMatches: [origin + '/*']}});
    expect(definition.sites![0]).toMatchObject({adaptedOn: '2026-10-19', pricing: 'freemium', isRaw: false,
      primaryLanguages: ['en'], search: true, accessTags: ['login-required']});
    expect(network).not.toHaveProperty('pageTransport');
  });
  it.each(['http://asurascans.com', 'https://www.asurascans.com', 'https://asurascans.com.evil.test',
    'https://user:pass@asurascans.com', 'https://asurascans.com:444', 'ftp://asurascans.com'])('rejects unsupported origin %s', host => {
    expect(definition.identify(new URL(host + '/comics/fixture-work-1234abcd'))).toBeNull();
  });
  it.each(['/novels/fixture-1234abcd', '/s/99', '/series/fixture-1234abcd', '/comics/fixture', '/comics/a%2Fb-1234abcd',
    '/comics/fixture-1234abcd/chapter/01', '/comics/fixture-1234abcd/chapter/1.0', '/comics/fixture-1234abcd?x=1',
    '/comics/fixture-1234abcd#other', '/comics/fixture-1234abcd/chapter/-1'])('does not import unsupported path %s', path => {
    expect(asuraLocation(new URL(origin + path))).toBeNull();
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('uses the complete source order and title, fractional releases, dedicated cover and source identity', () => {
    const snapshot = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(snapshot).toMatchObject({id: catalogKey(work), title: 'Fixture & Book', complete: true, cover: {url: cover}});
    expect(snapshot.entries.map(row => [row.title, row.order, row.url])).toEqual([
      ['Chapter 1', 0, readerUrl], ['Chapter 1.5 - Extra', 1, url + '/chapter/1.5'], ['Chapter 3', 2, url + '/chapter/3']]);
    expect(snapshot.defaultEntryId).toBe(chapterKey(work, '1'));
    expect(snapshot.groups[0].entryIds).toEqual(snapshot.entries.map(row => row.id));
    expect(snapshot.entries.every(row => !row.contentLanguage && row.sequenceId === snapshot.id)).toBe(true);
    expect(parseCatalog(catalogHtml({...directory(), chapters: [], totalChapters: 0}, {...detail(), chapterCount: 0}), url).entries).toEqual([]);
    const rotated = catalogHtml().replaceAll('1234abcd', 'aabbccdd');
    expect(parseCatalog(rotated, url).id).toBe(snapshot.id);
    expect(parseCatalog(rotated, url).entries.map(row => row.id)).toEqual(snapshot.entries.map(row => row.id));
  });
  it.each(['count', 'detail-count', 'missing', 'duplicate-id', 'duplicate-number', 'owner', 'slug', 'public-url', 'novel',
    'cover', 'foreign-response', 'negative', 'invalid-data', 'duplicate-component', 'script-only', 'truncated'])('rejects %s catalog', kind => {
    const list: Record<string, unknown> = directory(), meta: Record<string, unknown> = detail();
    if (kind === 'count') list.totalChapters = 4;
    if (kind === 'detail-count') meta.chapterCount = 4;
    if (kind === 'missing') list.chapters = [chapter(1)];
    if (kind === 'duplicate-id') list.chapters = [chapter(3, 10), chapter(1.5), chapter(1)];
    if (kind === 'duplicate-number') list.chapters = [chapter(1, 30), chapter(1.5), chapter(1)];
    if (kind === 'owner') list.chapters = [chapter(3), chapter(1.5), {...chapter(1), series_id: 100}];
    if (kind === 'slug') list.seriesSlug = 'foreign';
    if (kind === 'public-url') list.publicUrl = 'https://evil.test/comics/fixture-work-1234abcd';
    if (kind === 'novel') meta.type = 'novel';
    if (kind === 'cover') list.coverUrl = image;
    if (kind === 'negative') list.totalChapters = -1;
    let html = catalogHtml(list, meta, kind === 'foreign-response' ? url.replace(work, 'foreign') : url);
    if (kind === 'invalid-data') html = html.replace('&quot;chapters&quot;:[1,', '&quot;chapters&quot;:[2,');
    if (kind === 'duplicate-component') html += island('ChapterListReact', directory());
    if (kind === 'script-only') html = `<script>${html}</script>`;
    if (kind === 'truncated') html = html.slice(0, html.indexOf('&quot;chapters&quot;') + 20);
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('keeps duplicate images as separate page slots, natural tall dimensions and source order; excludes ads', () => {
    const pages = validatePages(parsePages(readerHtml(), readerUrl), definition.identify(new URL(readerUrl))!);
    expect(pages).toMatchObject({discoveryComplete: true, knownTotal: 2, direction: 'ltr', title: 'Fixture & Book - Chapter 1'});
    expect(pages.items.map(row => [row.id, row.order, row.width, row.height, row.resource])).toEqual([
      ['page-0', 0, 900, 16000, {kind: 'http', url: image}], ['page-1', 1, 900, 16000, {kind: 'http', url: image}]]);
  });
  it.each(['locked', 'unknown-access', 'missing', 'owner', 'chapter', 'identity', 'unsafe', 'foreign-image', 'cover-image',
    'dimensions', 'tiles', 'too-many', 'empty', 'duplicate-component'])('rejects %s reader without falling back to DOM images', kind => {
    const props: Record<string, unknown> = reader();
    if (kind === 'locked') props.isLocked = true;
    if (kind === 'unknown-access') props.isLocked = undefined;
    if (kind === 'missing') props.pages = undefined;
    if (kind === 'owner') props.seriesSlug = 'foreign-1234abcd';
    if (kind === 'chapter') props.chapterNumber = 2;
    if (kind === 'unsafe') props.pages = [{url: 'javascript:alert(1)', width: 900, height: 1600}];
    if (kind === 'foreign-image') props.pages = [{url: image.replace('cdn.asurascans.com', 'cdn.asurascans.com.evil.test'), width: 900, height: 1600}];
    if (kind === 'cover-image') props.pages = [{url: cover, width: 900, height: 1600}];
    if (kind === 'dimensions') props.pages = [{url: image, width: 0, height: 1600}];
    if (kind === 'tiles') props.pages = [{url: image, width: 900, height: 1600, tiles: [1, 0], tile_cols: 2, tile_rows: 1}];
    if (kind === 'too-many') props.pages = Array.from({length: 1501}, () => reader().pages[0]);
    if (kind === 'empty') props.pages = [];
    let html = readerHtml(props, kind === 'identity' ? url + '/chapter/2' : readerUrl);
    if (kind === 'duplicate-component') html += island('ChapterReader', reader());
    expect(() => parsePages(html, readerUrl)).toThrow(kind === 'locked' ? /会员/ : undefined);
  });
  it('searches only the requested name page, with query encoding, continuation and explicit empty results', async () => {
    const input = {siteId: 'asurascans', query: 'sample'}, first = parseSearch(searchHtml(), input);
    expect(first.nextCursor).toBe('2'); expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({title: 'Fixture 0', cover: {url: cover}, authors: ['Example']});
    expect(first.items[0].contentLanguages).toBeUndefined();
    expect(parseSearch(searchHtml(results(2)), {...input, cursor: '2'})).toMatchObject({items: [{title: 'Fixture 20'}]});
    expect(parseSearch(searchHtml(results(1, 0)), input)).toEqual({items: []});
    expect(searchUrl({...input, query: '日本語 & sword'})).toContain('search=%E6%97%A5%E6%9C%AC%E8%AA%9E+%26+sword&page=1');
    const request = vi.fn(async () => searchHtml()); await network.search(input, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/browse/comics?search=sample&page=1');
  });
  it.each(['page', 'count', 'total-pages', 'partial', 'query', 'novel', 'duplicate', 'owner', 'host', 'verification'])('rejects %s search', kind => {
    const props: Record<string, unknown> = results(1, 1);
    if (kind === 'page') props.initialCurrentPage = 2;
    if (kind === 'count') props.totalCount = 21;
    if (kind === 'total-pages') props.initialTotalPages = 2;
    if (kind === 'partial') props.initialSeries = [];
    if (kind === 'query') props.initialQuery = 'other';
    if (kind === 'novel') props.fixedContentMode = 'novels';
    if (kind === 'duplicate') {props.initialSeries = [hit(1), hit(1)]; props.totalCount = 2;}
    if (kind === 'owner') props.initialSeries = [{...hit(1), slug: 'other'}];
    if (kind === 'host') props.initialSeries = [{...hit(1), public_url: 'https://evil.test/comics/fixture-1234abcd'}];
    const html = kind === 'verification' ? '<title>Just a moment...</title>' : searchHtml(props);
    expect(() => parseSearch(html, {siteId: 'asurascans', query: 'sample'})).toThrow();
  });
  it.each([{siteId: 'other', query: 'x'}, {siteId: 'asurascans', query: ''}, {siteId: 'asurascans', query: 'x\n'},
    ...['https://evil.test', '1', '0', '02', '501', 'Infinity'].map(cursor => ({siteId: 'asurascans', query: 'x', cursor}))])('rejects invalid search parameters', input => {
    expect(() => searchUrl(input)).toThrow();
  });
  it('makes one request for each full directory/page list; rejects wrong operation kinds before HTTP', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml());
    await network.catalog(url + '/', {request}); await network.pages(readerUrl, {request});
    expect(request.mock.calls).toEqual([[url], [readerUrl]]);
    request.mockClear();
    await expect(network.catalog(readerUrl, {request})).rejects.toThrow();
    await expect(network.pages(url, {request})).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('keeps caller-owned previous data intact on refresh and failure, including cancellation at either request boundary', async () => {
    const previous = parseCatalog(catalogHtml(), url), saved = structuredClone(previous), request = vi.fn(async () => catalogHtml());
    await network.catalog(url, {request, previous}); expect(previous).toEqual(saved);
    request.mockRejectedValue(Error('offline'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('offline'); expect(previous).toEqual(saved);
    for (const operation of [network.catalog.bind(null, url), network.pages.bind(null, readerUrl),
      network.search.bind(null, {siteId: 'asurascans', query: 'sample'})]) {
      const before = new AbortController(); before.abort(Error('cancelled')); request.mockClear();
      await expect(operation({request, signal: before.signal})).rejects.toThrow('cancelled'); expect(request).not.toHaveBeenCalled();
      const after = new AbortController(); request.mockImplementation(async () => {after.abort(Error('cancelled')); return catalogHtml();});
      await expect(operation({request, signal: after.signal})).rejects.toThrow('cancelled');
    }
  });
  it('does not execute scripts, non-data tuple types or injected prototype fields', () => {
    expect(() => prop(parseProps('{"value":[2,"remote code"]}'), 'value')).toThrow();
    expect(() => prop(parseProps('{"value":[0,{"__proto__":[0,1]}]}'), 'value')).toThrow();
    expect(() => parseProps('alert(1)')).toThrow();
    expect(() => parseCatalog(identity(url) + '<template>' + catalogHtml() + '</template>', url)).toThrow();
  });
});
