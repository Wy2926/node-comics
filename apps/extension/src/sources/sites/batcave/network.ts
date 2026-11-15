import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {hasClass, tags, textContent} from '../../shared/html';
import {sourceCover} from '../../shared/cover';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {imageUrl, integer, invalid, location, object, pageData, readerWork, regions, text} from './html';
import {search, searchUrl} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw invalid();
  const {data, safe, actual} = pageData(html, loc);
  const title = text(data.title || textContent(regions(safe, 'h1', () => true)[0]?.body ?? '') || `BatCave ${loc.work}`);
  if (!Array.isArray(data.chapters) || data.chapters.length > 10000) throw invalid();
  const poster = regions(safe, 'div', a => !!hasClass(a, 'page__poster'))[0];
  const image = tags(poster?.body ?? '', 'img')[0];
  const cover = sourceCover(image?.['data-src'] || image?.src, url);
  const id = catalogKey(loc.work), seen = new Set<string>();
  // Source Next follows the reversed list; posi can repeat for annuals and specials.
  const chapters = data.chapters.map(object).reverse();
  const entries: SourceEntry[] = chapters.flatMap(row => {
    const remoteId = String(integer(row.id)), target = {...actual, chapter: remoteId};
    if (seen.has(remoteId)) return [];
    const order = seen.size;
    seen.add(remoteId);
    return [{id: chapterKey(target), catalogId: id, remoteId, url: chapterUrl(target), title: text(row.title || '#' + remoteId),
      groupIds: ['chapters'], rawTypes: [], order, related: false, sequenceId: id,
      ...(row.broken === true || row.pages === 0 || row.pages === '0' ? {readable: false} : {})}];
  });
  return {id, sourceId: 'batcave', url: catalogUrl(actual), title, cover, observedAt: Date.now(), complete: true, note: '',
    entries, groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}],
    defaultEntryId: entries.find(e => e.readable !== false)?.id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url), {data, safe} = pageData(html, loc);
  if (!loc.chapter) throw invalid();
  const count = integer(data.pages, 10000);
  if (!Array.isArray(data.images) || data.images.length < count) throw invalid();
  const title = text(textContent(regions(safe, 'h1', () => true)[0]?.body ?? '') || data.post_title || '#' + loc.chapter);
  // The source explicitly truncates images to pages; its trailing image is not a reading page.
  const items = data.images.slice(0, count).map((value, order) => {
    const image = imageUrl(value, loc);
    return {id: 'page-' + order, contentKey: 'batcave:' + image.pathname, order, width: 0, height: 0,
      resource: {kind: 'http' as const, url: image.href}};
  });
  return {url, adapter: 'batcave', title, direction: 'ltr', note: '', discoveryComplete: true, knownTotal: count, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const target = new URL(url); target.hash = ''; target.search = '';
  const html = await context.request(target.href);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  pageTransport: ['catalog', 'pages'], search,
  searchPage: input => searchUrl(input).url,
  async resolveCatalog(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw invalid();
    const {data} = pageData(await request(chapterUrl({...loc, slug: undefined}), context), loc);
    return catalogUrl(readerWork(data, loc));
  },
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw invalid();
    return parseCatalog(await request(catalogUrl(loc), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw invalid();
    return parsePages(await request(chapterUrl({...loc, slug: undefined}), context), url);
  },
} satisfies SourceNetwork;
