import {describe, expect, it, vi} from 'vitest';
import {definition, catalogUrl, episodeUrl, catalogKey, location} from '../definition';
import {network, parsePages} from '../network';
import {readerInfo} from '../protocol';
import {createPage} from '../page';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogData, cellId, graphql, html, pagesData, readerData, secondId, seriesId} from './fixtures';

const url = catalogUrl(seriesId), reader = episodeUrl(seriesId), bound = episodeUrl(seriesId, seriesId);
const metadata = () => readerInfo(JSON.stringify(readerData()), bound);
function context() {
  return {request: vi.fn(async (target: string) => target === url ? html('__NEXT_DATA__', catalogData())
    : target === 'https://api.ridibooks.com/graphql' ? JSON.stringify(graphql())
    : target === reader ? html('app_init', readerData()) : JSON.stringify(pagesData()))};
}
describe('RIDI protocol', () => {
  it('recognizes native and catalog-bound readers without guessing a series from an episode ID', () => {
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', pageKey: 'ridi:episode:' + seriesId});
    expect(definition.identify(new URL(reader))).not.toHaveProperty('catalog');
    expect(definition.identify(new URL(bound))).toMatchObject({catalog: {key: catalogKey(seriesId), url}});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', catalog: {url}});
    expect(definition.identify(new URL(reader + '?utm_source=fixture#page-1'))?.pageKey).toBe('ridi:episode:' + seriesId);
    for (const target of ['http://ridibooks.com/books/1/view', 'https://ridibooks.com.evil.test/books/1/view',
      'https://user:secret@ridibooks.com/books/1/view', 'https://ridibooks.com:444/books/1/view'])
      expect(definition.identify(new URL(target))).toBeNull();
    for (const target of [reader + '#nodelane-ridi=bad', reader + '#nodelane-ridi=1&nodelane-ridi=2', 'https://ridibooks.com/books/01/view'])
      expect(location(new URL(target))).toBeNull();
  });
  it('resolves the parent from verified reader metadata and consumes every catalog page in source order', async () => {
    const ctx = context();
    expect(await network.resolveCatalog(reader, ctx)).toBe(url);
    const result = validateCatalog(await network.catalog(url, ctx), [definition]);
    expect(result).toMatchObject({complete: true, title: '테스트', cover: {url: `https://img.ridicdn.net/cover/${seriesId}/large`}});
    expect(result.entries.map(entry => entry.order)).toEqual([0, 1, 2]);
    expect(result.entries[1]).toMatchObject({url: episodeUrl(secondId, seriesId), rawTypes: ['FREE'], contentLanguage: 'ko'});
    expect(ctx.request).toHaveBeenCalledWith('https://api.ridibooks.com/graphql', expect.objectContaining({referer: url, json: {
      query: expect.stringContaining('episodeBookListCell'), variables: {id: cellId, context: {
        bookId: seriesId, deviceType: 'DESKTOP', order: 'SEQUENTIAL', tabType: 'RENT', pagination: {offset: 1, limit: 100},
      }},
    }}));
    expect(ctx.request.mock.calls.filter(([target]) => target === url)).toHaveLength(2);
  });
  it.each(['truncated', 'duplicate', 'foreign', 'order', 'offset', 'graphql-error', 'changed-head'])('rejects %s catalogs instead of publishing a partial directory', async failure => {
    const ctx = context(); let reads = 0;
    ctx.request.mockImplementation(async target => {
      if (target === url) {
        const data = catalogData();
        if (failure === 'changed-head' && reads++) data.props.pageProps.sectionProps.gridQuery.riGrid.grid.cells[0].cell__BookDetailHomeHeader!.information.series.openedBookCount++;
        return html('__NEXT_DATA__', data);
      }
      const data = graphql(), page = data.data.riGrid.cells.bookDetailHome.episodeBookListCell.cell;
      if (failure === 'truncated') page.books.pop();
      if (failure === 'duplicate') page.books[0].bookId = seriesId;
      if (failure === 'foreign') page.seriesId = secondId;
      if (failure === 'order') page.currentOrder = 'LATEST';
      if (failure === 'offset') page.pagination.nextPage = {order: 'SEQUENTIAL', offset: 1, limit: 100};
      return JSON.stringify(failure === 'graphql-error' ? {...data, errors: [{message: 'fixture'}]} : data);
    });
    await expect(network.catalog(url, ctx)).rejects.toThrow('RIDI');
  });
  it('propagates failed pagination and cancellation before further requests', async () => {
    const ctx = context();
    ctx.request.mockImplementationOnce(async () => html('__NEXT_DATA__', catalogData())).mockRejectedValueOnce(Error('offline'));
    await expect(network.catalog(url, ctx)).rejects.toThrow('offline');
    const controller = new AbortController();
    ctx.request.mockClear().mockImplementation(async () => {controller.abort(); return html('__NEXT_DATA__', catalogData());});
    await expect(network.catalog(url, {...ctx, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(ctx.request).toHaveBeenCalledOnce();
  });
  it('reads all image slices through the JSON viewer endpoint and keeps short final slices', async () => {
    const ctx = context(), snapshot = validatePages(await network.pages(bound, ctx), definition.identify(new URL(bound))!);
    expect(snapshot).toMatchObject({adapter: 'ridi', direction: 'ltr', discoveryComplete: true, knownTotal: 2});
    expect(snapshot.items[1]).toMatchObject({order: 1, width: 720, height: 120, resource: {kind: 'http'}});
    expect(snapshot.items[0]).not.toHaveProperty('contentKey');
    expect(ctx.request.mock.calls).toHaveLength(2);
    expect(ctx.request).toHaveBeenLastCalledWith('https://ridibooks.com/api/web-viewer/generate', {referer: reader, json: {book_id: seriesId}});
  });
  it.each(['denied', 'empty', 'duplicate', 'foreign-host', 'foreign-book', 'filename', 'size', 'epub'])('rejects %s page lists', failure => {
    const data = pagesData(), first = data.data.pages[0];
    if (failure === 'denied') data.success = false;
    if (failure === 'empty') data.data.pages = [];
    if (failure === 'duplicate') data.data.pages.push(first);
    if (failure === 'foreign-host') first.src = first.src.replace('ridibooks.com', 'ridibooks.com.evil.test');
    if (failure === 'foreign-book') first.src = first.src.replace(seriesId, secondId);
    if (failure === 'filename') first.filename = 'other.webp';
    if (failure === 'size') first.width = 0;
    if (failure === 'epub') data.data.type = 'epub';
    expect(() => parsePages(JSON.stringify(data), metadata(), bound)).toThrow('RIDI');
  });
  it('accepts the viewer’s second image cache and mixed JPEG/WebP slices', () => {
    const data = pagesData(), image = data.data.pages[1];
    image.filename = '__ridi__1.jpg';
    image.src = `https://webview-cache2.ridibooks.com/${seriesId}/webtoon/${image.filename}?Signature=fixture`;
    expect(parsePages(JSON.stringify(data), metadata(), bound).items[1].resource).toEqual({kind: 'http', url: image.src});
  });
  it('rejects a wrong series or non-comic reader before requesting any images', async () => {
    const ctx = context();
    await expect(network.pages(episodeUrl(seriesId, secondId), ctx)).rejects.toThrow('RIDI');
    expect(ctx.request).toHaveBeenCalledOnce();
    const data = readerData(); data.detail.book.content_type.is_comic = false;
    expect(() => readerInfo(JSON.stringify(data), reader)).toThrow('不是网页漫画');
  });
});

describe('RIDI displayed originals', () => {
  function fixture() {
    const image = (index: string, src = 'blob:https://ridibooks.com/fixture-' + index) => ({
      dataset: {index}, alt: 'image-' + index, src, currentSrc: '', complete: true, naturalWidth: 720, naturalHeight: 120,
    });
    const images = [image('1'), image('0'), image('2', 'data:image/svg+xml,placeholder'), image('3', 'blob:https://foreign.test/image')];
    const doc = {title: 'Fixture', querySelectorAll: vi.fn((selector: string) => {
      expect(selector).toBe('#app_placeholder img[data-index][alt^="image-"]'); return images;
    }), querySelector: (selector: string) => ({textContent: JSON.stringify(selector === '#app_init' ? readerData() : catalogData())})} as unknown as Document;
    const controller = new AbortController();
    const session = createPage({document: doc, location: definition.identify(new URL(reader))!, signal: controller.signal});
    return {images, doc, session, controller};
  }
  it('selects only loaded reader slots in numeric order, excluding placeholders and foreign blobs', async () => {
    const {images, session, controller} = fixture();
    const targets = session.inlineTargets();
    expect(targets.map(target => target.element)).toEqual([images[1], images[0]]);
    expect(targets.every(target => typeof target.read === 'function')).toBe(true);
    images[1].complete = false; expect(session.inlineTargets()).toHaveLength(1);
    images[0].src = 'blob:https://ridibooks.com/replaced';
    expect(session.inlineTargets()[0].key).not.toBe(targets[1].key);
    expect(await session.discoverPages()).toMatchObject({status: 'unsupported'});
    controller.abort(); expect(() => session.inlineTargets()).toThrow(); session.dispose();
  });
  it('describes the series from reader metadata and never scans catalog artwork', () => {
    const {session, doc, controller} = fixture();
    expect(session.describeWork?.()).toMatchObject({status: 'ready', value: {title: '테스트', catalogId: catalogKey(seriesId), catalogUrl: url}});
    const catalog = createPage({document: doc, location: definition.identify(new URL(url))!, signal: controller.signal});
    expect(catalog.inlineTargets()).toEqual([]); expect(doc.querySelectorAll).not.toHaveBeenCalled();
    expect(catalog.describeWork?.()).toMatchObject({status: 'ready', value: {catalogUrl: url}});
    session.dispose(); catalog.dispose();
  });
});
