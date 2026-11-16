import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {hasClass, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {checkedHtml, coverUrl, location, one, region, regions, text} from './html';
import {decodeImageList, imageUrl, readerData} from './protocol';
import {imageProcessing} from './tiles';
import {search, searchUrl} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw Error('请使用 Mangago 作品地址读取目录。');
  const safe = checkedHtml(html, loc), title = text(textContent(region(safe, 'h1')));
  const cover = coverUrl(text(one(tags(safe, 'meta').filter(a => a.property === 'og:image')).content));
  const table = region(safe, 'table', a => a.id === 'chapter_table'), rows = regions(table, 'tr');
  if (!rows.length || rows.length > 10000 || rows.length !== tags(table, 'tr').length ||
      tags(table, 'a').filter(a => hasClass(a, 'chico')).length !== rows.length) throw Error('Mangago 目录不完整。');
  const id = catalogKey(loc.work), seen = new Map<string, string>();
  const entries: SourceEntry[] = rows.reverse().flatMap(row => {
    const link = one(regions(row.body, 'a', a => !!hasClass(a, 'chico'))), target = location(text(link.attrs.href));
    if (target.work !== loc.work || !target.chapter || target.page !== 1) throw Error('Mangago 章节归属错误。');
    const label = text(textContent(link.body)), previous = seen.get(target.chapter);
    // The live directory repeats identical releases (e.g. One Piece 1046).
    if (previous !== undefined) {
      if (previous !== label) throw Error('Mangago 重复章节标题不一致。');
      return [];
    }
    seen.set(target.chapter, label);
    return [{id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target),
      title: label, groupIds: ['chapters'], rawTypes: [], order: seen.size - 1, related: false, sequenceId: id}];
  });
  const start = one(regions(safe, 'a').filter(a => textContent(a.body) === 'Start Reading'));
  if (chapterKey(location(text(start.attrs.href))) !== entries[0].id) throw Error('Mangago 目录起点不一致。');
  return {id, sourceId: 'mangago', url: catalogUrl(loc.work), title, cover, observedAt: Date.now(), complete: true, note: '',
    entries, groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}], defaultEntryId: entries[0].id};
}
export async function parsePages(html: string, url: string, signal?: AbortSignal): Promise<SourceSnapshot> {
  signal?.throwIfAborted();
  const loc = location(url), data = readerData(html, loc), urls = await decodeImageList(data.encoded);
  signal?.throwIfAborted();
  // Older readers append a mode flag; unknown trailers must not become image slots.
  if (urls.length === data.total + 1 && /^[012]$/.test(urls.at(-1)!)) urls.pop();
  if (urls.length !== data.total) throw Error('Mangago 图片清单与正文页数不一致。');
  const items = urls.map((value, order) => {
    const target = imageUrl(value, loc.work), processing = imageProcessing(target);
    return {id: 'page-' + order, order, width: 0, height: 0,
      resource: {kind: 'http' as const, url: target, ...(processing ? {processing} : {})}};
  });
  return {url, adapter: 'mangago', title: data.title, direction: 'ltr', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
export const network = {
  pageTransport: ['catalog', 'pages'], search, searchPage: request => searchUrl(request).url,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 Mangago 作品地址读取目录。');
    context.signal?.throwIfAborted();
    const html = await context.request(catalogUrl(loc.work));
    context.signal?.throwIfAborted();
    return parseCatalog(html, url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('Mangago 章节地址无效。');
    context.signal?.throwIfAborted();
    const html = await context.request(chapterUrl(loc));
    return parsePages(html, url, context.signal);
  },
} satisfies SourceNetwork;
