import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {apiOrigin, catalogUrl, chapterUrl, mangaDexLocation} from './definition';
import {chapterData, chapterTitle, compareLabel, count, entity, id, list, object, relationships, response, text, type Chapter, type JsonObject} from './protocol';
import {search} from './search';

const pageSize = 100;
const ratings = ['safe', 'suggestive', 'erotica', 'pornographic'];
function location(url: string) {
  const value = mangaDexLocation(new URL(url));
  if (!value) throw Error('MangaDex 来源地址无效，请使用作品或章节链接。');
  return value;
}
async function request(url: string, context: SourceNetworkContext): Promise<unknown> {
  context.signal?.throwIfAborted();
  const body = await context.request(url);
  context.signal?.throwIfAborted();
  try {return JSON.parse(body);} catch {throw Error('MangaDex 返回了无效 JSON，请稍后重试。');}
}
export function feedUrl(mangaId: string, offset: number): string {
  const url = new URL(`${apiOrigin}/manga/${mangaId}/feed`);
  for (const [key, value] of Object.entries({limit: String(pageSize), offset: String(offset), 'order[volume]': 'asc', 'order[chapter]': 'asc',
    'order[createdAt]': 'asc', 'includes[]': 'scanlation_group', includeUnavailable: '1'})) url.searchParams.set(key, value);
  for (const rating of ratings) url.searchParams.append('contentRating[]', rating);
  // Omit language filters and tri-state external/empty/future filters: 1 selects ONLY those rows.
  return url.href;
}
function collection(value: unknown, offset: number, expectedTotal?: number) {
  const result = response(value), data = list(result.data), total = count(result.total), limit = count(result.limit, pageSize);
  if (result.response !== 'collection' || count(result.offset) !== offset || limit !== pageSize || expectedTotal !== undefined && total !== expectedTotal ||
    data.length !== Math.min(limit, total - offset)) throw Error('MangaDex 分页目录不完整或已变化，请重试。');
  return {data, total};
}
function record(value: unknown) {
  // The API represents an empty PHP map as [] on some empty catalogs.
  return Array.isArray(value) && !value.length ? {} : object(value);
}
export function readingSlots(value: unknown, chapters: Chapter[], mangaId: string): Map<string, string> {
  const volumes = record(response(value).volumes), byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const seen = new Set<string>(), slots = new Map<string, string>();
  for (const [volumeKey, rawVolume] of Object.entries(volumes)) {
    const volume = object(rawVolume);
    if (volume.volume !== volumeKey) throw Error('MangaDex 聚合目录卷号不一致。');
    let actualCount = 0;
    for (const [chapterKey, rawChapter] of Object.entries(record(volume.chapters))) {
      const chapter = object(rawChapter), ids = [id(chapter.id), ...list(chapter.others).map(id)];
      if (chapter.chapter !== chapterKey || count(chapter.count) !== ids.length) throw Error('MangaDex 聚合目录话号或数量不一致。');
      actualCount += ids.length;
      for (const chapterId of ids) {
        const entry = byId.get(chapterId);
        if (seen.has(chapterId) || !entry || (entry.volume ?? 'none') !== volumeKey || (entry.chapter ?? 'none') !== chapterKey)
          throw Error('MangaDex 聚合目录与完整章节列表不一致，请重试。');
        seen.add(chapterId);
        // A missing chapter number is not evidence that all unnamed releases are the same reading position.
        if (entry.chapter) slots.set(chapterId, `mangadex:${mangaId}:slot:${encodeURIComponent(volumeKey)}:${encodeURIComponent(chapterKey)}`);
      }
    }
    if (count(volume.count) !== actualCount) throw Error('MangaDex 聚合目录未完整获取。');
  }
  return slots;
}
function cover(manga: JsonObject, mangaId: string) {
  const covers = relationships(manga, 'cover_art');
  if (!covers.length) return;
  if (covers.length !== 1) throw Error('MangaDex 专门封面归属不明确。');
  id(covers[0].id);
  const filename = text(object(covers[0].attributes).fileName, 255);
  if (!/^[a-z\d_-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(filename)) throw Error('MangaDex 专门封面地址无效。');
  return {url: `https://uploads.mangadex.org/covers/${mangaId}/${filename}.512.jpg`};
}
export function parseCatalog(mangaValue: unknown, rawChapters: unknown[], aggregateValue: unknown, mangaId: string): SourceCatalogSnapshot {
  const manga = entity(mangaValue, 'manga', mangaId), attributes = object(manga.attributes), titles = object(attributes.title);
  const title = text(titles.en ?? titles[String(attributes.originalLanguage)] ?? Object.values(titles)[0]);
  const chapters = rawChapters.map(value => chapterData(value, mangaId)), seen = new Set(chapters.map(chapter => chapter.id));
  if (seen.size !== chapters.length) throw Error('MangaDex 分页目录包含重复章节，请重试。');
  const slots = readingSlots(aggregateValue, chapters, mangaId), catalogId = 'mangadex:' + mangaId;
  // Preserve the feed's order among releases at one position for deterministic fallback selection.
  chapters.sort((a, b) => compareLabel(a.volume, b.volume) || compareLabel(a.chapter, b.chapter));
  const orders = new Map<string, number>();
  const entries: SourceEntry[] = chapters.map(chapter => {
    const readingSlotId = slots.get(chapter.id), slot = readingSlotId ?? chapter.id;
    if (!orders.has(slot)) orders.set(slot, orders.size);
    return {id: 'mangadex:chapter:' + chapter.id, catalogId, remoteId: chapter.id, url: chapterUrl(chapter.id, mangaId),
      title: chapterTitle(chapter), groupIds: ['volume:' + (chapter.volume ?? 'none')], rawTypes: chapter.groups,
      order: orders.get(slot)!, related: false, contentLanguage: chapter.language, readingSlotId,
      readable: !chapter.external && !chapter.unavailable && chapter.pages > 0,
      // Without a source-proven numbered position, keep the release individually readable.
      sequenceId: readingSlotId ? `${catalogId}:chapters` : `${catalogId}:entry:${chapter.id}`};
  });
  const volumes = [...new Set(chapters.map(chapter => chapter.volume))];
  const first = entries.find(entry => entry.readable);
  return {id: catalogId, sourceId: 'mangadex', url: catalogUrl(mangaId), title, cover: cover(manga, mangaId), observedAt: Date.now(), complete: true,
    note: chapters.some(chapter => chapter.external || chapter.unavailable || !chapter.pages) ? '目录保留外链及暂不可用章节；打开时会说明源站状态。' : '',
    groups: volumes.map(volume => ({id: 'volume:' + (volume ?? 'none'), title: volume ? `Vol. ${volume}` : '未标注卷', complete: true,
      entryIds: entries.filter(entry => entry.groupIds.includes('volume:' + (volume ?? 'none'))).map(entry => entry.id)})),
    entries, defaultEntryId: first?.id};
}
export function imageBaseUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.hostname === 'uploads.mangadex.org' || /^[a-z\d](?:[a-z\d-]*[a-z\d])?\.mangadex\.network$/i.test(url.hostname)))
    throw Error('MangaDex 图片服务器地址不受支持。');
  return url.origin;
}
export function parsePages(value: unknown, chapter: Chapter, url: string): SourceSnapshot {
  if (chapter.external) throw Error('MangaDex 此章节由外部网站提供，请在源站打开外链；不会自动替换为其他发布条目。');
  if (chapter.unavailable || !chapter.pages) throw Error('MangaDex 此发布条目暂不可用，请在源站确认；不会自动替换为其他发布条目。');
  const result = response(value), baseUrl = imageBaseUrl(result.baseUrl), images = object(result.chapter), hash = text(images.hash, 64), data = list(images.data);
  if (!/^[a-f\d]{32}$/i.test(hash) || data.length !== chapter.pages) throw Error('MangaDex 正文图片清单不完整或已变化，请重试。');
  const items = data.map((value, order) => {
    const filename = text(value, 255);
    if (!/^[a-z\d][a-z\d._-]*\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(filename)) throw Error('MangaDex 正文图片文件名无效。');
    return {id: 'page-' + order, order, width: 0, height: 0, contentKey: `mangadex:${chapter.id}:${hash}:${filename}`,
      resource: {kind: 'http' as const, url: `${baseUrl}/data/${hash}/${encodeURIComponent(filename)}`}};
  });
  return {url, adapter: 'mangadex', title: chapterTitle(chapter), direction: 'rtl', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function readChapter(url: string, context: SourceNetworkContext) {
  const loc = location(url);
  if (!loc.chapterId) throw Error('请使用 MangaDex 章节链接。');
  const data = entity(await request(`${apiOrigin}/chapter/${loc.chapterId}?includes%5B%5D=scanlation_group`, context), 'chapter', loc.chapterId);
  return chapterData(data, loc.mangaId);
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.mangaId || loc.chapterId) throw Error('请使用 MangaDex 作品详情页链接。');
    const manga = await request(`${apiOrigin}/manga/${loc.mangaId}?includes%5B%5D=cover_art`, context);
    entity(manga, 'manga', loc.mangaId);
    const rows: unknown[] = [];
    let total: number | undefined;
    do {
      const batch = collection(await request(feedUrl(loc.mangaId, rows.length), context), rows.length, total);
      total = batch.total;
      rows.push(...batch.data);
    } while (rows.length < total);
    const aggregate = await request(`${apiOrigin}/manga/${loc.mangaId}/aggregate?includeUnavailable=1`, context);
    return parseCatalog(manga, rows, aggregate, loc.mangaId);
  },
  async resolveCatalog(url, context) {return catalogUrl((await readChapter(url, context)).mangaId);},
  async pages(url, context) {
    const chapter = await readChapter(url, context);
    // Report unavailable releases before requesting a server lease.
    if (chapter.external || chapter.unavailable || !chapter.pages) return parsePages({}, chapter, url);
    return parsePages(await request(`${apiOrigin}/at-home/server/${chapter.id}`, context), chapter, url);
  },
} satisfies SourceNetwork;
