import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import type {SourceSearchPage, SourceSearchHit} from '../../contracts/search';
import {bytes, decode, messages, number, text, type Fields} from '../../shared/protobuf';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, location, origin, validId} from './definition';

const invalid = () => Error('Zebrack 数据不完整或读取协议已变化。');
const unavailable = () => Error('此 Zebrack 章节不是公开免费章节，请在源站确认阅读权限；插件不会消耗点数、硬币或阅读券。');
const label = (value: string) => {
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\u0000-\u001f\u007f]/.test(clean)) throw invalid();
  return clean;
};
const id = (value: number) => {if (!validId(String(value))) throw invalid(); return String(value);};
function source(url: string) {const loc = location(new URL(url)); if (!loc) throw invalid(); return loc;}
function child(data: Fields, field: number) {const value = bytes(data, field); if (!value) throw invalid(); return decode(value);}
function checkError(data: Fields, field: number) {if (bytes(data, field) !== undefined) throw unavailable();}
function asset(value: string, path: RegExp) {
  const url = new URL(value);
  if (url.origin !== 'https://asset.zebrack-comic.com' || url.username || url.password || url.hash || !path.test(url.pathname)) throw invalid();
  return url;
}
const cover = (value: string, title: string) => ({url: asset(value, new RegExp(`^/title/${title}/(?:volume_thumbnail|thumbnail)/[\\w.-]+$`)).href});

/** The v3 endpoint is the site's complete, ascending chapter list, not the five-row detail preview. */
export function parseChapters(response: Uint8Array, title: string) {
  const data = decode(response); checkError(data, 9);
  if (id(number(data, 1)) !== title) throw invalid();
  const key = catalogKey(title), entries: SourceCatalogSnapshot['entries'] = [], groups: SourceCatalogSnapshot['groups'] = [];
  const seen = new Set<string>(), groupIds = new Set<string>(), names = new Map<string, string>();
  for (const group of messages(data, 5, 1000)) for (const index of messages(group, 2, 10000)) {
    const chapter = id(number(index, 2)), name = label(text(index, 1));
    if (names.has(chapter) && names.get(chapter) !== name) throw invalid();
    names.set(chapter, name);
  }
  for (const group of messages(data, 4, 1000)) {
    const rows = messages(group, 3, 10000), volume = number(group, 2);
    if (!rows.length) throw invalid();
    const first = id(number(rows[0], 1)), groupId = volume ? `volume-${id(volume)}` : `chapters-${first}`, entryIds: string[] = [];
    if (groupIds.has(groupId)) throw invalid(); groupIds.add(groupId);
    for (const row of rows) {
      const chapter = id(number(row, 1)), status = number(row, 11), price = number(row, 12);
      if (id(number(row, 2)) !== title || seen.has(chapter) || status > 6 || entries.length >= 10000) throw invalid();
      seen.add(chapter);
      const entryId = chapterKey(title, chapter), campaign = text(row, 6);
      entries.push({id: entryId, catalogId: key, remoteId: chapter, url: chapterUrl(title, chapter),
        title: label(text(row, 3)), order: entries.length, groupIds: [groupId], related: false,
        rawTypes: campaign ? [label(campaign)] : [], sequenceId: `${key}:${groupId}`,
        // FREE only. Rental, daily tickets, points and coins are never acquired implicitly.
        readable: status === 0 && price === 0});
      entryIds.push(entryId);
    }
    groups.push({id: groupId, title: names.get(first) ?? '話一覧', entryIds, complete: true});
  }
  for (const chapter of names.keys()) if (!seen.has(chapter)) throw invalid();
  const last = number(data, 2); if (last && !seen.has(String(last))) throw invalid();
  if (!entries.length) throw Error('此 Zebrack 作品没有「話読み」目录；单行本、小说及杂志商店暂不支持导入。');
  return {title: label(text(data, 7)), entries, groups};
}
export function parseCatalog(detailResponse: Uint8Array, chapterResponse: Uint8Array, url: string): SourceCatalogSnapshot {
  const loc = source(url); if (loc.chapter) throw invalid();
  const response = decode(detailResponse); checkError(response, 1000);
  const detail = child(response, 21);
  if (id(number(detail, 1)) !== loc.title) throw invalid();
  const list = parseChapters(chapterResponse, loc.title);
  if (label(text(detail, 2)) !== list.title) throw invalid();
  const artwork = bytes(detail, 11) ? child(detail, 11) : child(detail, 4);
  if (text(artwork, 3)) throw invalid();
  return {id: catalogKey(loc.title), sourceId: 'zebrack', url: catalogUrl(loc.title), ...list,
    cover: cover(text(artwork, 1), loc.title), complete: true, observedAt: Date.now(),
    defaultEntryId: list.entries.find(entry => entry.readable)?.id,
    note: '完整「話読み」目录；仅读取公开免费章节，不自动购买、租借或消耗阅读券。单行本、小说和杂志商店不在此目录中。'};
}
export function parsePages(response: Uint8Array, url: string): SourceSnapshot {
  const loc = source(url); if (!loc.chapter) throw invalid();
  const data = decode(response); checkError(data, 101);
  if (id(number(data, 3)) !== loc.title || id(number(data, 4)) !== loc.chapter || id(number(child(data, 10), 1)) !== loc.title) throw invalid();
  const items: SourceSnapshot['items'] = [];
  for (const [order, page] of messages(data, 1).entries()) {
    const kinds = [1, 2, 3, 4, 5, 6, 7].filter(field => bytes(page, field) !== undefined);
    if (kinds.length !== 1) throw invalid();
    if (kinds[0] !== 1) continue; // Ads, promotion images and end panels are not comic pages.
    const image = child(page, 1), key = text(image, 2);
    const target = asset(text(image, 1), new RegExp(`^/title/${loc.title}/chapter/${loc.chapter}/page/(?:non_webp|webp)/[\\w-]+/[1-9]\\d*\\.(?:jpg|jpeg|png|webp)$`));
    if (key && !/^[a-f\d]{128}$/i.test(key)) throw invalid();
    const size = bytes(image, 4) ? child(image, 4) : undefined;
    const width = size && number(size, 1), height = size && number(size, 2);
    if (size && (!width || !height || width > 100000 || height > 100000)) throw invalid();
    items.push({id: `page-${order}`, order, width: width ?? 0, height: height ?? 0, contentKey: `zebrack:${target.pathname}`,
      resource: {kind: 'http', url: target.href, ...(key ? {processing: `zebrack-xor:${key.toLowerCase()}`} : {})}});
  }
  if (!items.length) throw unavailable();
  const ltr = number(data, 14), direction = number(data, 12);
  if (ltr > 1 || direction > 1) throw invalid();
  return {adapter: 'zebrack', url, title: label(text(data, 5)), direction: ltr ? 'ltr' : 'rtl',
    items, discoveryComplete: true, knownTotal: items.length, note: ''};
}
export function parseSearch(response: Uint8Array, offset: number): SourceSearchPage {
  const data = decode(response); checkError(data, 4); label(text(data, 3));
  const items: SourceSearchHit[] = [], seen = new Set<string>();
  for (const row of messages(data, 1, 10000)) {
    const target = new URL(text(row, 2)), values = target.searchParams.getAll('titleId');
    if (target.protocol !== 'garaku:' || target.hostname !== 'title_detail' || target.pathname || target.username || target.password ||
      target.port || target.hash || values.length !== 1 || !validId(values[0])) throw invalid();
    const title = values[0]; if (seen.has(title)) continue; seen.add(title);
    items.push({catalogId: catalogKey(title), catalogUrl: catalogUrl(title), title: label(text(row, 3)), cover: cover(text(row, 1), title)});
  }
  if (offset && offset >= items.length) throw invalid();
  // Source search returns one complete list. Slice without fetching every work's catalog.
  return {items: items.slice(offset, offset + 50), ...(offset + 50 < items.length ? {nextCursor: String(offset + 50)} : {})};
}
const api = 'https://api2.zebrack-comic.com/api/';
async function request(path: string, parameters: Record<string, string>, context: SourceNetworkContext, post = false) {
  context.signal?.throwIfAborted();
  if (!context.requestBytes) throw Error('Zebrack 需要二进制来源请求支持。');
  const fields = {os: 'browser', ...parameters};
  const result = await context.requestBytes(api + path + (post ? '' : '?' + new URLSearchParams(fields)),
    {referer: origin + '/', ...(post ? {form: fields} : {})});
  context.signal?.throwIfAborted(); return result;
}
export const network = {
  async catalog(url, context) {
    const loc = source(url); if (loc.chapter) throw invalid();
    const [detail, chapters] = await Promise.all([
      request('browser/title_detail', {title_id: loc.title, tab: 'chapter'}, context),
      request('v3/title_chapter_list', {title_id: loc.title}, context),
    ]);
    return parseCatalog(detail, chapters, url);
  },
  async pages(url, context) {
    const loc = source(url); if (!loc.chapter) throw invalid();
    const list = parseChapters(await request('v3/title_chapter_list', {title_id: loc.title}, context), loc.title);
    if (!list.entries.some(entry => entry.remoteId === loc.chapter && entry.readable)) throw unavailable();
    return parsePages(await request('v3/chapter_viewer', {title_id: loc.title, chapter_id: loc.chapter,
      type: 'normal', event_point: '0', paid_point: '0'}, context, true), url);
  },
  async search(input, context) {
    const query = input.query.trim(), cursor = input.cursor ?? '0';
    if (input.siteId !== 'zebrack' || !query || query.length > 256 || !/^(?:0|[1-9]\d{0,3})$/.test(cursor) || Number(cursor) % 50) throw invalid();
    return parseSearch(await request('v3/title_search', {search_order: 'popular', keyword: query}, context), Number(cursor));
  },
} satisfies SourceNetwork;
