import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import type {SourceSearchPage, SourceSearchRequest} from '../../contracts/search';
import {safeImageUrl} from '../../shared/urls';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, location, mangaOrigin, originFor, validId, validSlug, type ZaiLocation} from './definition';

const invalid = (): never => {throw Error('再漫画数据不完整、归属不符或协议已变化。');};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function text(value: unknown, max = 1024): string {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : invalid();
}
function count(value: unknown, max = 1e9): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid();
}
function id(value: unknown): string {const result = String(count(value, 9999999999)); return validId(result) ? result : invalid();}
function slug(value: unknown): string {const result = text(value, 200); return validSlug(result) ? result : invalid();}
function list(value: unknown, max: number): unknown[] {return Array.isArray(value) && value.length <= max ? value : invalid();}
function data(body: string) {
  let response: Record<string, unknown>;
  try {response = object(JSON.parse(body));} catch {return invalid();}
  if (response.errno !== 0) throw Error('再漫画暂不可读，请在源站确认作品状态、登录及阅读权限后重试。');
  return object(response.data);
}
function source(url: string) {const loc = location(new URL(url)); return loc ?? invalid();}
function asset(value: unknown) {
  const raw = text(value, 8192), url = safeImageUrl(raw, raw);
  return url && !new URL(url).hash ? url : invalid();
}
export function detailUrl(loc: ZaiLocation) {
  const url = new URL(`/api/v1/comic${loc.area === 'original' ? 1 : 2}/comic/detail`, originFor(loc));
  url.search = new URLSearchParams({channel: 'pc', app_name: 'zmh', version: '1.0.0', timestamp: String(Date.now()),
    ...(loc.area === 'original' ? {comic_py: loc.slug!} : {id: loc.comic!})}).toString();
  return url.href;
}
export function pagesUrl(loc: ZaiLocation) {
  if (!loc.chapter || !loc.comic) return invalid();
  const url = new URL(`/api/v1/comic${loc.area === 'original' ? 1 : 2}/chapter/detail`, originFor(loc));
  url.search = new URLSearchParams({channel: 'pc', app_name: 'zmh', version: '1.0.0', timestamp: String(Date.now()), comic_id: loc.comic, chapter_id: loc.chapter}).toString();
  return url.href;
}
export function parseCatalog(body: string, url: string): SourceCatalogSnapshot {
  const loc = source(url), info = object(data(body).comicInfo), comic = id(info.id), workSlug = slug(info.comicPy);
  if (loc.chapter || loc.comic && loc.comic !== comic || loc.slug && loc.slug !== workSlug) return invalid();
  if (info.canRead !== true) throw Error('此作品当前不开放网页阅读，请在再漫画确认作品状态。');
  const key = catalogKey(loc), entries: SourceCatalogSnapshot['entries'] = [], groups: SourceCatalogSnapshot['groups'] = [];
  const seen = new Set<string>(), groupNames = new Set<string>();
  // Both web frontends receive the whole chapterList. chapter_order is source order, not a parsed title/ID.
  for (const value of list(info.chapterList, 1000)) {
    const group = object(value), title = text(group.title, 180), groupId = 'group:' + encodeURIComponent(title);
    if (groupNames.has(title)) return invalid(); groupNames.add(title);
    const rows = list(group.data, 10000).map(object).reverse().sort((a, b) => count(a.chapter_order) - count(b.chapter_order));
    const entryIds: string[] = [];
    for (const row of rows) {
      const chapter = id(row.chapter_id), target = {...loc, slug: workSlug, comic, chapter};
      if (seen.has(chapter) || entries.length >= 10000 || typeof row.is_fee !== 'boolean') return invalid();
      count(row.chapter_order); seen.add(chapter);
      const entryId = chapterKey(target); entryIds.push(entryId);
      entries.push({id: entryId, catalogId: key, remoteId: chapter, url: chapterUrl(target), title: text(row.chapter_title),
        groupIds: [groupId], rawTypes: [title, ...(row.is_fee ? ['付费'] : [])], order: entries.length, related: false,
        sequenceId: key + ':' + groupId, readable: !row.is_fee});
    }
    groups.push({id: groupId, title, entryIds, complete: true});
  }
  if (!entries.length || info.lastUpdateChapterId && !seen.has(id(info.lastUpdateChapterId))) return invalid();
  return {id: key, sourceId: 'zaimanhua', url: catalogUrl(loc), title: text(info.title), cover: {url: asset(info.cover)},
    entries, groups, complete: true, observedAt: Date.now(), defaultEntryId: entries.find(entry => entry.readable)?.id,
    note: '网页完整目录；仅读取公开免费章节，不自动购买或解锁。'};
}
export function parsePages(body: string, url: string): SourceSnapshot {
  const loc = source(url), info = object(data(body).chapterInfo);
  if (!loc.chapter || id(info.comic_id) !== loc.comic || id(info.chapter_id) !== loc.chapter) return invalid();
  const images = list(info.page_url, 1500);
  if (!images.length) throw Error('再漫画未返回可读正文，请在源站确认阅读权限。');
  // picnum is zero even for complete public chapters; page_url itself is the web reader's full list.
  // The API's direction field has not been verified as left/right book binding.
  const items = images.map((value, order) => ({id: 'page-' + order, order, width: 0, height: 0,
    resource: {kind: 'http' as const, url: asset(value)}}));
  return {adapter: 'zaimanhua', url, title: text(info.title), direction: 'ltr', discoveryComplete: true,
    knownTotal: items.length, items, note: ''};
}
const pageSize = 24;
function searchPage(input: SourceSearchRequest) {
  if (!['zaimanhua', 'zaimanhua-manga'].includes(input.siteId)) return invalid();
  const query = text(input.query, 256);
  if (!input.cursor) return {query, page: 1};
  let cursor: Record<string, unknown>;
  try {cursor = object(JSON.parse(input.cursor));} catch {return invalid();}
  if (cursor.query !== query || cursor.site !== input.siteId) return invalid();
  const page = count(cursor.page, 100000); if (page < 2) return invalid();
  return {query, page};
}
export function searchUrl(input: SourceSearchRequest) {
  const {query, page} = searchPage(input), url = new URL('/app/v1/search/index', mangaOrigin);
  url.search = new URLSearchParams({keyword: query, source: '0', page: String(page), size: String(pageSize)}).toString();
  return url.href;
}
export function parseSearch(body: string, input: SourceSearchRequest): SourceSearchPage {
  const {query, page} = searchPage(input), result = data(body), rows = list(result.list, pageSize), total = count(result.total);
  if (result.page !== page || result.size !== pageSize || rows.length !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) return invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), comic = id(row.id), workSlug = slug(row.comic_py);
    if (row.copyright !== 0 && row.copyright !== 1 || seen.has(comic)) return invalid(); seen.add(comic);
    // Match the original site's own search links, including its cross-site Japanese results.
    const loc: ZaiLocation = row.copyright === 1 ? {area: 'original', slug: workSlug} : {area: 'manga', comic};
    return {catalogId: catalogKey(loc), catalogUrl: catalogUrl(loc), title: text(row.title), cover: {url: asset(row.cover)},
      ...(row.authors ? {authors: [text(row.authors)]} : {}), ...(row.last_name ? {latestLabel: text(row.last_name)} : {})};
  });
  return {items, ...(page * pageSize < total ? {nextCursor: JSON.stringify({query, site: input.siteId, page: page + 1})} : {})};
}
async function request(url: string, referer: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, {referer});
  context.signal?.throwIfAborted(); return body;
}
export const network = {
  async catalog(url, context) {
    const loc = source(url); if (loc.chapter) return invalid();
    return parseCatalog(await request(detailUrl(loc), catalogUrl(loc), context), url);
  },
  async pages(url, context) {
    const loc = source(url); if (!loc.chapter) return invalid();
    // Validate slug, numeric work ownership, membership and fee BEFORE asking for a chapter.
    const catalog = parseCatalog(await request(detailUrl(loc), catalogUrl(loc), context), catalogUrl(loc));
    const entry = catalog.entries.find(entry => entry.id === chapterKey(loc));
    if (!entry || entry.url !== chapterUrl(loc)) return invalid();
    if (!entry.readable) throw Error('此再漫画章节需要付费，请在源站阅读；插件不会自动购买或解锁。');
    return parsePages(await request(pagesUrl(loc), chapterUrl(loc), context), url);
  },
  async search(input, context) {return parseSearch(await request(searchUrl(input), mangaOrigin + '/', context), input);},
} satisfies SourceNetwork;
