import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {catalogKey, catalogUrl, galleryLocation, readerKey, readerUrl} from './definition';
import {parseReader} from './protocol';

function location(url: string, reader: boolean) {
  const loc = galleryLocation(new URL(url));
  if (!loc || Boolean(loc.page) !== reader) throw Error('nHentai.to 不支持此页面地址。');
  return loc;
}
export function parseCatalog(body: string, url: string): SourceCatalogSnapshot {
  const loc = location(url, false), work = parseReader(body, readerUrl(loc.id));
  const id = catalogKey(loc.id), entryId = readerKey(loc.id);
  return {id, sourceId: 'nhentaito', url: catalogUrl(loc.id), title: work.title, cover: {url: work.cover},
    observedAt: Date.now(), complete: true, note: '',
    groups: [{id: 'book', title: work.title, entryIds: [entryId], complete: true}],
    entries: [{id: entryId, catalogId: id, remoteId: loc.id, url: readerUrl(loc.id), title: work.title,
      groupIds: ['book'], rawTypes: work.categories, contentLanguage: work.contentLanguage, order: 0, related: false}],
    defaultEntryId: entryId};
}
export function parsePages(body: string, url: string): SourceSnapshot {
  const work = parseReader(body, url);
  return {url, adapter: 'nhentaito', title: work.title, direction: 'rtl', discoveryComplete: true,
    knownTotal: work.pages.length, note: '', items: work.pages.map((page, index) => ({id: `page-${index + 1}`,
      order: index, width: page.width, height: page.height, resource: {kind: 'http', url: page.url}}))};
}
async function request(url: string, reader: boolean, context: SourceNetworkContext) {
  const loc = location(url, reader);
  context.signal?.throwIfAborted();
  // The reader JSON has the public gallery ID and a contiguous page array; the detail page uses internal IDs.
  const body = await context.request(readerUrl(loc.id, loc.page), {referer: catalogUrl(loc.id)});
  context.signal?.throwIfAborted();
  return body;
}
export const network = {
  async catalog(url, context) {return parseCatalog(await request(url, false, context), url);},
  async pages(url, context) {return parsePages(await request(url, true, context), url);},
} satisfies SourceNetwork;
