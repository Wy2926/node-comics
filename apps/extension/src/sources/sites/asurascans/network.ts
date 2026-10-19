import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {catalogKey, chapterKey} from './definition';
import {chapterNumber, imageUrl, integer, island, location, object, prop, responsePage, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const {safe, loc} = responsePage(html, url);
  if (loc.chapter !== undefined) throw Error('请使用 Asura Scans 作品页读取目录。');
  const list = island(safe, 'ChapterListReact'), detail = island(safe, 'DescriptionModal');
  const bound = location(text(prop(list, 'publicUrl'))), work = text(prop(list, 'seriesSlug'));
  const seriesId = integer(prop(detail, 'seriesId'), Number.MAX_SAFE_INTEGER);
  const count = integer(prop(list, 'totalChapters')), rows = prop(list, 'chapters');
  const type = text(prop(detail, 'type'));
  if (!seriesId || bound.work !== loc.work || bound.chapter !== undefined || work !== loc.work ||
      !['manga', 'manhwa', 'manhua'].includes(type) || integer(prop(detail, 'chapterCount')) !== count ||
      !Array.isArray(rows) || rows.length !== count) throw Error('Asura Scans 目录不完整或作品归属不符。');
  const id = catalogKey(work), ids = new Set<number>(), numbers = new Set<string>();
  // SSR supplies the complete newest-first list, including fractional/special releases. Do not fill gaps.
  const entries = rows.toReversed().map((value, order) => {
    const row = object(value), remoteId = integer(row.id, Number.MAX_SAFE_INTEGER), number = chapterNumber(row.number);
    if (!remoteId || row.series_id !== seriesId || row.series_slug !== work || ids.has(remoteId) || numbers.has(number))
      throw Error('Asura Scans 目录章节重复或归属不符。');
    integer(row.page_count, 1500);
    ids.add(remoteId); numbers.add(number);
    return {id: chapterKey(work, number), catalogId: id, remoteId: String(remoteId),
      url: bound.catalogUrl + '/chapter/' + number, title: 'Chapter ' + number + (row.title ? ' - ' + text(row.title) : ''),
      order, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id};
  });
  return {id, sourceId: 'asurascans', url: bound.catalogUrl, title: text(prop(detail, 'title')),
    cover: {url: imageUrl(prop(list, 'coverUrl'), 'covers')}, observedAt: Date.now(), complete: true, note: '',
    groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(entry => entry.id), complete: true}], entries,
    defaultEntryId: entries[0]?.id};
}

export function parsePages(html: string, url: string): SourceSnapshot {
  const {safe, loc} = responsePage(html, url);
  if (loc.chapter === undefined) throw Error('请使用 Asura Scans 章节页读取正文。');
  const reader = island(safe, 'ChapterReader'), work = location('/comics/' + text(prop(reader, 'seriesSlug')));
  if (work.work !== loc.work || work.chapter !== undefined || chapterNumber(prop(reader, 'chapterNumber')) !== loc.chapter ||
      !integer(prop(reader, 'seriesId'), Number.MAX_SAFE_INTEGER) || !integer(prop(reader, 'chapterId'), Number.MAX_SAFE_INTEGER))
    throw Error('Asura Scans 章节归属不符。');
  const locked = prop(reader, 'isLocked');
  if (locked === true) throw Error('Asura Scans 本章尚未公开，可能需要源站会员或等待提前阅读期结束。');
  if (locked !== false) throw Error('Asura Scans 章节访问状态不明确。');
  const pages = prop(reader, 'pages');
  if (!Array.isArray(pages) || !pages.length || pages.length > 1500) throw Error('Asura Scans 完整正文清单缺失。');
  const items = pages.map((value, order) => {
    const row = object(value), width = integer(row.width, 100000), height = integer(row.height, 100000);
    if (row.tiles != null && (!Array.isArray(row.tiles) || row.tiles.length))
      throw Error('Asura Scans 此页使用尚未支持的图片分块格式。');
    if (!width || !height) throw Error('Asura Scans 图片尺寸无效。');
    return {id: 'page-' + order, order, width, height,
      resource: {kind: 'http' as const, url: imageUrl(row.url, 'chapters')}};
  });
  return {url, adapter: 'asurascans', title: text(prop(reader, 'seriesName')) + ' - Chapter ' + loc.chapter,
    direction: 'ltr', note: '', discoveryComplete: true, knownTotal: items.length, items};
}

export async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter !== undefined) throw Error('请使用 Asura Scans 作品页读取目录。');
    return parseCatalog(await request(loc.catalogUrl, context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (loc.chapter === undefined) throw Error('请使用 Asura Scans 章节页读取正文。');
    return parsePages(await request(loc.catalogUrl + '/chapter/' + loc.chapter, context), url);
  },
} satisfies SourceNetwork;
