import type {SourceNetwork} from '../../contracts/network';
import type {SourceEntry} from '../../contracts/source';
import {catalogUrl, episodeUrl, origin, seriesKey} from './definition';
import {changed, count, coverUrl, id, json, location, object, parseReader, request, text} from './protocol';
import {search} from './search';
import {parsePages} from './pages';

export function parseInfo(raw: string) {
  const data = object(json(raw)), total = count(data.readable_products_count, 10000);
  const size = count(data.per_page, 1000);
  if (data.type !== 'number' || !total || !size) throw changed();
  return {total, size};
}
export function parseEntries(raw: string, series: string, offset: number): SourceEntry[] {
  const rows = json(raw);
  if (!Array.isArray(rows)) throw changed();
  return rows.map((value, index) => {
    const row = object(value), episode = id(row.readable_product_id), target = location(text(row.viewer_uri));
    const purchase = object(row.purchase_info);
    if (target.episode !== episode || target.catalog || target.series && target.series !== series ||
        typeof purchase.can_read !== 'boolean') throw changed();
    const status = row.status == null ? undefined : object(row.status);
    return {id: 'sundaywebry:episode:' + episode, catalogId: seriesKey(series), remoteId: episode,
      url: episodeUrl(episode, series), title: text(row.title), groupIds: [], rawTypes: status?.text ? [text(status.text, 180)] : [],
      order: offset + index, related: false, sequenceId: seriesKey(series), readable: purchase.can_read};
  });
}
export const network = {
  search,
  async resolveCatalog(url, context) {
    const loc = location(url), reader = parseReader(await request(context, episodeUrl(loc.episode)), url);
    return catalogUrl(reader.series, reader.episode);
  },
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.catalog || !loc.series) throw changed();
    const reader = parseReader(await request(context, episodeUrl(loc.episode)), url);
    const params = new URLSearchParams({type: 'episode', aggregate_id: reader.series});
    const infoUrl = `${origin}/api/viewer/readable_product_pagination_information?${params}&readable_product_id=${reader.episode}`;
    const info = parseInfo(await request(context, infoUrl));
    const entries: SourceEntry[] = [], seen = new Set<string>();
    let firstRaw = '';
    const listUrl = (offset: number) => `${origin}/api/viewer/pagination_readable_products?${params}&offset=${offset}&limit=${info.size}&sort_order=asc`;
    for (let offset = 0; offset < info.total; offset += info.size) {
      const raw = await request(context, listUrl(offset));
      if (!offset) firstRaw = raw;
      const page = parseEntries(raw, reader.series, offset);
      if (page.length !== Math.min(info.size, info.total - offset)) throw changed();
      for (const entry of page) {if (seen.has(entry.id)) throw changed(); seen.add(entry.id); entries.push(entry);}
    }
    if (!seen.has('sundaywebry:episode:' + reader.episode)) throw changed();
    if (info.total > info.size && (JSON.stringify(parseInfo(await request(context, infoUrl))) !== JSON.stringify(info) ||
        JSON.stringify(parseEntries(await request(context, listUrl(0)), reader.series, 0)) !==
        JSON.stringify(parseEntries(firstRaw, reader.series, 0)))) throw changed();
    const thumbnail = object(reader.product.series).thumbnailUri;
    return {id: seriesKey(reader.series), sourceId: 'sundaywebry', url, title: reader.title,
      cover: thumbnail ? {url: coverUrl(thumbnail, reader.series).url} : undefined,
      observedAt: Date.now(), complete: true, groups: [], entries,
      defaultEntryId: entries.find(entry => entry.readable)?.id,
      note: '已读取网站完整公开目录；非公开、限时和仅限 App 的内容以源站可读状态为准。'};
  },
  async pages(url, context) {
    const loc = location(url);
    if (loc.catalog) throw changed();
    const raw = await request(context, episodeUrl(loc.episode));
    return parsePages({readableProduct: parseReader(raw, url).product}, url);
  },
} satisfies SourceNetwork;
