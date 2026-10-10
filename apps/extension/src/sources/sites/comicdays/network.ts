import type {SourceNetwork} from '../../contracts/network';
import type {SourceEntry} from '../../contracts/source';
import {catalogUrl, episodeUrl, origin, seriesKey} from './definition';
import {changed, count, coverUrl, id, json, location, object, parseReader, request, text} from './protocol';
import {search} from './search';
import {parsePages} from './pages';

export function parseInfo(raw: string) {
  const data = object(json(raw)), total = count(data.readable_products_count, 10000), size = count(data.per_page, 1000);
  if (data.type !== 'number' || !total || !size) throw changed();
  return {total, size};
}
export function parseEntries(raw: string, series: string, offset: number): SourceEntry[] {
  const rows = json(raw);
  if (!Array.isArray(rows)) throw changed();
  return rows.map((value, index) => {
    const row = object(value), episode = id(row.readable_product_id), target = location(text(row.viewer_uri));
    const purchase = object(row.purchase_info);
    if (target.catalog || target.episode !== episode || target.series && target.series !== series ||
        typeof purchase.can_read !== 'boolean') throw changed();
    return {id: 'comicdays:episode:' + episode, catalogId: seriesKey(series), remoteId: episode,
      url: episodeUrl(episode, series), title: text(row.title), groupIds: [], rawTypes: [],
      order: offset + index, related: false, sequenceId: seriesKey(series), readable: purchase.can_read};
  });
}
export const network = {
  search,
  async resolveCatalog(url, context) {
    const loc = location(url);
    if (loc.catalog) return catalogUrl(loc.series);
    const reader = parseReader(await request(context, episodeUrl(loc.episode)), url);
    return catalogUrl(reader.series);
  },
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.catalog) throw changed();
    // The aggregate pagination API provides a direct, source-owned first episode.
    const params = new URLSearchParams({type: 'episode', aggregate_id: loc.series});
    const infoUrl = `${origin}/api/viewer/readable_product_pagination_information?${params}`;
    const info = parseInfo(await request(context, infoUrl));
    const entries: SourceEntry[] = [], seen = new Set<string>();
    const listUrl = (offset: number) => `${origin}/api/viewer/pagination_readable_products?${params}&offset=${offset}&limit=${info.size}&sort_order=asc`;
    let firstPage: SourceEntry[] = [], lastPage: SourceEntry[] = [];
    for (let offset = 0; offset < info.total; offset += info.size) {
      const page = parseEntries(await request(context, listUrl(offset)), loc.series, offset);
      if (!offset) firstPage = page;
      lastPage = page;
      if (page.length !== Math.min(info.size, info.total - offset)) throw changed();
      for (const entry of page) {if (seen.has(entry.id)) throw changed(); seen.add(entry.id); entries.push(entry);}
    }
    const seed = firstPage[0].remoteId;
    const reader = parseReader(await request(context, episodeUrl(seed)), episodeUrl(seed, loc.series));
    if (info.total > info.size && (JSON.stringify(parseInfo(await request(context, infoUrl))) !== JSON.stringify(info) ||
        JSON.stringify(parseEntries(await request(context, listUrl(0)), loc.series, 0)) !== JSON.stringify(firstPage) ||
        JSON.stringify(parseEntries(await request(context, listUrl(Math.floor((info.total - 1) / info.size) * info.size)), loc.series,
          Math.floor((info.total - 1) / info.size) * info.size)) !== JSON.stringify(lastPage))) throw changed();
    const thumbnail = object(reader.product.series).thumbnailUri;
    return {id: seriesKey(reader.series), sourceId: 'comicdays', url: catalogUrl(reader.series), title: reader.title,
      cover: thumbnail ? {url: coverUrl(thumbnail, reader.series).url} : undefined,
      observedAt: Date.now(), complete: true, groups: [], entries,
      defaultEntryId: entries.find(entry => entry.readable)?.id,
      note: '已读取网站完整公开目录；章节是否可读以源站当前授权、购买与限时免费状态为准。'};
  },
  async pages(url, context) {
    const loc = location(url);
    if (loc.catalog) throw changed();
    const reader = parseReader(await request(context, episodeUrl(loc.episode)), url);
    if (reader.product.pageStructure == null) throw Error('该 Comic DAYS 章节当前不可读取，请到源站确认登录、购买或公开状态。');
    return parsePages({readableProduct: reader.product}, url);
  },
} satisfies SourceNetwork;
