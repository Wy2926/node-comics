import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {api, catalogUrl, chapterUrl, mangaBallLocation} from './definition';
import {createCatalogRequest} from './catalog-request';
import {chapterNumber, count, cover, entity, id, imageUrl, language, list, object, pagination, response, text, type JsonObject} from './protocol';
import {search} from './search';

const limit = 100;
// Match the public catalog budget before retaining batches or requesting another page.
const maxEntries = 10000;
const oversized = () => Error('MangaBall 目录超过 10000 个条目上限。');
function location(url: string) {
  const loc = mangaBallLocation(new URL(url));
  if (!loc) throw Error('MangaBall 来源地址无效，请使用作品或章节链接。');
  return loc;
}
async function request(url: string, context: SourceNetworkContext): Promise<unknown> {
  context.signal?.throwIfAborted();
  const body = await context.request(url);
  context.signal?.throwIfAborted();
  try {return JSON.parse(body);} catch {throw Error('MangaBall 返回了无效 JSON。');}
}
export function listingUrl(titleId: string, page: number): string {
  const url = new URL(api + '/title/chapter-listing');
  url.search = new URLSearchParams({title_id: titleId, page: String(page), limit: String(limit), group_by: 'chapter', sort_order: 'asc', language: 'all'}).toString();
  return url.href;
}
export function chapterTitle(row: JsonObject): string {
  const number = chapterNumber(row.chapter_number ?? row.number), name = row.name == null || row.name === '' ? '' : text(row.name);
  return [number === undefined ? undefined : 'Ch. ' + number, name].filter(Boolean).join(' - ') || '未命名章节';
}
function readable(row: JsonObject): boolean {
  return !['deleted', 'removed', 'unavailable', 'hidden', 'draft', 'pending'].includes(String(row.status)) && row.is_hidden !== true && row.hidden !== true;
}
export function parseCatalog(titleValue: unknown, groups: unknown[], titleId: string, complete = true): SourceCatalogSnapshot {
  if (groups.length > maxEntries) throw oversized();
  const title = entity(response(titleValue).data);
  if (title.id !== titleId) throw Error('MangaBall 作品归属已变化。');
  const total = count(title.chapters_count);
  if (total > maxEntries) throw oversized();
  const catalogId = 'mangaball:' + titleId, entries: SourceEntry[] = [], seen = new Set<string>(), slots = new Set<string>();
  for (const [order, value] of groups.entries()) {
    const group = object(value), label = chapterNumber(group.chapter_number), rows = list(group.releases);
    if (rows.length > maxEntries - entries.length) throw oversized();
    if (!rows.length || label !== undefined && slots.has(label)) throw Error('MangaBall 目录包含重复或空话组。');
    if (label !== undefined) slots.add(label);
    for (const value of rows) {
      const row = entity(value), chapterId = String(row.id);
      if (seen.has(chapterId) || id(row.title_id) !== titleId || chapterNumber(row.chapter_number ?? row.number) !== label) throw Error('MangaBall 章节重复或归属不一致。');
      seen.add(chapterId);
      const readingSlotId = label === undefined ? undefined : `${catalogId}:slot:${label}`;
      const groupName = row.group == null ? row.group_name : object(row.group).name;
      const rawTypes = groupName ? [text(groupName)] : [];
      entries.push({id: 'mangaball:chapter:' + chapterId, catalogId, remoteId: chapterId, url: chapterUrl(chapterId, titleId),
        title: chapterTitle(row), groupIds: ['chapters'], rawTypes, order, related: false, contentLanguage: language(row.lang), readingSlotId,
        sequenceId: readingSlotId ? catalogId + ':chapters' : catalogId + ':entry:' + chapterId, ...(readable(row) ? {} : {readable: false})});
    }
  }
  // The title's chapters_count counts logical chapter groups, not language/group releases.
  if (complete ? total !== groups.length : groups.length > total) throw Error('MangaBall 完整目录与作品话组总数不一致，请重试。');
  return {id: catalogId, sourceId: 'mangaball', url: catalogUrl(titleId), title: text(title.name), cover: cover(title.image),
    observedAt: Date.now(), complete, note: '', entries,
    groups: [{id: 'chapters', title: '全部章节', complete, entryIds: entries.map(row => row.id)}],
    defaultEntryId: entries.find(row => row.readable !== false)?.id};
}
export function readerData(value: unknown, url: string) {
  const loc = location(url);
  if (!loc.chapterId) throw Error('请使用 MangaBall 章节链接。');
  const data = object(response(value).data), chapter = entity(data.chapter), title = entity(data.title), titleId = id(chapter.title_id);
  if (chapter.id !== loc.chapterId || title.id !== titleId || loc.titleId && loc.titleId !== titleId) throw Error('MangaBall 章节不属于已导入作品。');
  return {chapter, titleId, chapterId: loc.chapterId};
}
export function parsePages(value: unknown, url: string): SourceSnapshot {
  const {chapter} = readerData(value, url), rows = list(chapter.pages);
  if (!rows.length || rows.length > 1500) throw Error('MangaBall 未提供完整正文，请在源站确认。');
  const items = rows.map((value, order) => ({id: 'page-' + order, order, width: 0, height: 0,
    // The API provides the complete ordered array. Repeated URLs retain separate page slots.
    resource: {kind: 'http' as const, url: imageUrl(value)}}));
  return {url, adapter: 'mangaball', title: chapterTitle(chapter), direction: 'rtl', discoveryComplete: true, knownTotal: items.length, note: '', items};
}
async function readChapter(url: string, context: SourceNetworkContext) {
  const loc = location(url);
  if (!loc.chapterId) throw Error('请使用 MangaBall 章节链接。');
  // Chapter ID is authoritative; the website's optional chapter number is only a display hint.
  return request(api + '/chapter-detail?' + new URLSearchParams({chapter_id: loc.chapterId}), context);
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.titleId || loc.chapterId) throw Error('请使用 MangaBall 作品详情页链接。');
    const catalogContext = {...context, request: createCatalogRequest(context)};
    const title = await request(api + '/title/detail/' + loc.titleId, catalogContext), groups: unknown[] = [];
    const titleRow = entity(response(title).data);
    if (titleRow.id !== loc.titleId) throw Error('MangaBall 作品归属已变化。');
    const expectedTotal = count(titleRow.chapters_count);
    if (expectedTotal > maxEntries) throw oversized();
    let total: number | undefined, pages = 1, releaseCount = 0, reported = false;
    for (let page = 1; page <= pages; page++) {
      const result = response(await request(listingUrl(loc.titleId, page), catalogContext)), meta = pagination(result.pagination, page, limit);
      if (meta.total > maxEntries) throw oversized();
      if (meta.total !== expectedTotal) throw Error('MangaBall 完整目录与作品话组总数不一致，请重试。');
      const batch = list(result.grouped_data);
      if (total !== undefined && total !== meta.total || batch.length !== meta.length) throw Error('MangaBall 分页目录不完整或已变化，请重试。');
      total = meta.total; pages = meta.pages;
      for (const value of batch) {
        releaseCount += list(object(value).releases).length;
        if (releaseCount > maxEntries) throw oversized();
      }
      if (list(result.data).length > maxEntries) throw oversized();
      const flatIds = list(result.data).map(value => String(entity(value).id));
      const groupedIds = batch.flatMap(value => list(object(value).releases).map(value => String(entity(value).id)));
      const groupedSet = new Set(groupedIds);
      if (flatIds.length !== groupedIds.length || groupedSet.size !== groupedIds.length || new Set(flatIds).size !== flatIds.length || flatIds.some(id => !groupedSet.has(id))) throw Error('MangaBall 话组与章节列表不一致。');
      groups.push(...batch);
      // Scan each new batch once; build at most one cumulative partial snapshot.
      if (!reported && context.onCatalogProgress && batch.some(value => list(object(value).releases).some(value => readable(object(value))))) {
        const partial = parseCatalog(title, groups, loc.titleId, false);
        await context.onCatalogProgress(partial);
        context.signal?.throwIfAborted();
        reported = true;
      }
    }
    return parseCatalog(title, groups, loc.titleId);
  },
  async resolveCatalog(url, context) {return catalogUrl(readerData(await readChapter(url, context), url).titleId);},
  async pages(url, context) {return parsePages(await readChapter(url, context), url);},
} satisfies SourceNetwork;
