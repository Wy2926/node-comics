import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import type {SourceSearchPage, SourceSearchHit} from '../../contracts/search';
import {bytes, decode, messages, number, text, type Fields} from '../../shared/protobuf';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, location, origin, validId} from './definition';

const invalid = () => Error('Manga One 数据不完整或读取协议已变化。');
const unavailable = () => Error('此 Manga One 章节不是公开免费正文，请在源站确认阅读权限；插件不会消耗体力、硬币或阅读券。');
const id = (value: number) => {if (!validId(String(value))) throw invalid(); return String(value);};
const label = (value: string) => {
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\u0000-\u001f\u007f]/.test(clean)) throw invalid();
  return clean;
};
function child(data: Fields, field: number) {
  const value = bytes(data, field); if (value === undefined) throw invalid();
  return value.length ? decode(value) : new Map() as Fields;
}
function source(url: string) {const loc = location(new URL(url)); if (!loc) throw invalid(); return loc;}
function asset(value: string, path: RegExp) {
  const url = new URL(value);
  if (url.origin !== 'https://app.manga-one.com' || url.username || url.password || url.hash || !path.test(url.pathname)) throw invalid();
  return url;
}
function work(data: Fields) {
  const title = child(data, 1), workId = id(number(title, 1));
  const artwork = text(title, 16) || text(title, 7) || text(title, 6);
  return {workId, title: label(text(title, 2)), cover: {url: asset(artwork,
    /^\/secure\/\d+\/(?:webp|avif|jpg|png)\/(?:title_vertical_thumb|title_list_single|volume_thumbnail)\/[\w.-]+$/).href}};
}
export function parseTitle(response: Uint8Array, expectedWork: string) {
  const titles = messages(decode(response), 1);
  if (titles.length !== 1) throw invalid();
  const title = work(titles[0]); if (title.workId !== expectedWork) throw invalid();
  return title;
}
function free(chapter: Fields) {
  const badge = number(chapter, 12); if (badge > 5) throw invalid();
  const required = bytes(chapter, 16) === undefined ? undefined : child(chapter, 16);
  const consumption = bytes(chapter, 13) === undefined ? undefined : child(chapter, 13);
  return badge === 1 && (!required || [1, 2, 3, 4, 5, 6].every(field => number(required, field) === 0)) &&
    (!consumption || number(consumption, 1) === 0);
}
export function parseChapterPage(response: Uint8Array, workId: string, page: number) {
  const list = child(decode(response), 1), paging = child(list, 2);
  const total = number(list, 5), pages = number(paging, 2), rows = messages(list, 1, 100);
  const start = number(list, 3), end = number(list, 4), offset = (page - 1) * 100;
  if (total < 1 || total > 10000 || number(paging, 1) !== page || pages !== Math.ceil(total / 100) || page > pages ||
      start !== offset + 1 || end !== Math.min(total, offset + 100) || rows.length !== end - offset) throw invalid();
  const key = catalogKey(workId);
  const entries = rows.map((row, index) => {
    const chapter = id(number(row, 1)), name = label(text(row, 2)), description = text(row, 3).trim();
    return {id: chapterKey(workId, chapter), catalogId: key, remoteId: chapter, url: chapterUrl(workId, chapter),
      title: label(description ? `${name} ${description}` : name), groupIds: ['chapters'], rawTypes: [],
      order: offset + index, related: false, sequenceId: key, readable: free(row)};
  });
  return {total, pages, entries};
}
export function parsePages(response: Uint8Array, url: string): SourceSnapshot {
  const loc = source(url); if (!loc.chapter) throw invalid();
  const data = decode(response), title = child(child(data, 5), 1), chapter = child(data, 7);
  if (id(number(title, 1)) !== loc.work || id(number(chapter, 1)) !== loc.chapter) throw invalid();
  if (!free(chapter)) throw unavailable();
  const key = text(data, 3), iv = text(data, 4), direction = number(chapter, 14);
  if (!/^[a-f\d]{64}$/i.test(key) || !/^[a-f\d]{32}$/i.test(iv) || direction > 2) throw invalid();
  const items: SourceSnapshot['items'] = [];
  for (const [order, page] of messages(data, 1).entries()) {
    const kinds = [1, 2, 3].filter(field => bytes(page, field) !== undefined);
    if (kinds.length !== 1) throw invalid();
    if (kinds[0] !== 1) continue; // Linked ads, end panels and purchase promotions are not comic pages.
    const image = child(page, 1), target = asset(text(image, 1),
      new RegExp(`^/secure/\\d+/webp/manga_page(?:_low)?/${loc.chapter}/[1-9]\\d*\\.webp\\.enc$`));
    const width = number(image, 2), height = number(image, 3);
    if (!width || !height || width > 100000 || height > 100000) throw invalid();
    items.push({id: `page-${order}`, order, width, height, contentKey: `mangaone:${target.pathname}`,
      resource: {kind: 'http', url: target.href, processing: `mangaone-aes:${key.toLowerCase()}:${iv.toLowerCase()}`}});
  }
  if (!items.length) throw unavailable();
  return {adapter: 'mangaone', url, title: `${label(text(title, 2))} ${label(text(chapter, 2))}`,
    direction: 'rtl', discoveryComplete: true, knownTotal: items.length, items, note: ''};
}
export function parseSearch(response: Uint8Array, offset: number): SourceSearchPage {
  const data = response.length ? decode(response) : new Map() as Fields;
  const items: SourceSearchHit[] = [], seen = new Set<string>();
  // Only searchResults is authoritative; recommendedTitleSection is unrelated.
  for (const row of messages(data, 3, 10000)) {
    const title = work(child(row, 1));
    if (seen.has(title.workId)) continue; seen.add(title.workId);
    items.push({catalogId: catalogKey(title.workId), catalogUrl: catalogUrl(title.workId), title: title.title, cover: title.cover});
  }
  if (offset && offset >= items.length) throw invalid();
  return {items: items.slice(offset, offset + 50), ...(offset + 50 < items.length ? {nextCursor: String(offset + 50)} : {})};
}
async function request(path: string, parameters: Record<string, string>, context: SourceNetworkContext, post = false) {
  context.signal?.throwIfAborted();
  if (!context.requestBytes) throw Error('Manga One 需要二进制来源请求支持。');
  const query = new URLSearchParams({rq: path, ...parameters});
  const response = await context.requestBytes(`${origin}/api/client?${query}`, {referer: origin + '/',
    ...(post ? {body: new Uint8Array(0)} : {})});
  context.signal?.throwIfAborted(); return response;
}
export const network = {
  async catalog(url, context) {
    const loc = source(url); if (loc.chapter) throw invalid();
    const readPage = async (page: number) => parseChapterPage(await request('viewer/chapter_list',
      {title_id: loc.work, type: 'chapter', sort_type: 'asc', page: String(page), limit: '100'}, context), loc.work, page);
    const [titleResponse, first] = await Promise.all([request('title/list', {title_ids: loc.work}, context), readPage(1)]);
    const title = parseTitle(titleResponse, loc.work), entries = [...first.entries], seen = new Set<string>();
    for (let page = 2; page <= first.pages; page++) {
      const next = await readPage(page);
      if (next.total !== first.total || next.pages !== first.pages) throw invalid();
      entries.push(...next.entries);
    }
    for (const entry of entries) {if (seen.has(entry.id)) throw invalid(); seen.add(entry.id);}
    if (entries.length !== first.total) throw invalid();
    return {id: catalogKey(loc.work), sourceId: 'mangaone', url: catalogUrl(loc.work), title: title.title, cover: title.cover,
      observedAt: Date.now(), complete: true, entries,
      groups: [{id: 'chapters', title: '作品一覧', entryIds: entries.map(entry => entry.id), complete: true}],
      defaultEntryId: entries.find(entry => entry.readable)?.id,
      note: '完整「作品一覧」目录；仅读取公开免费正文，不消耗体力、硬币或阅读券。ちょいたし与单行本商店不在此目录中。'} satisfies SourceCatalogSnapshot;
  },
  async pages(url, context) {
    const loc = source(url); if (!loc.chapter) throw invalid();
    // Explicit zeros, no CSRF token or everyday/free-ticket flag: this request cannot authorize spending.
    const response = await request('viewer_v2', {title_id: loc.work, chapter_id: loc.chapter, list_type: 'chapter',
      sort_type: 'asc', page: '1', limit: '10', free_point: '0', event_point: '0', paid_point: '0'}, context, true);
    return parsePages(response, chapterUrl(loc.work, loc.chapter));
  },
  async search(input, context) {
    if (input.siteId !== 'mangaone' || !input.query.trim() || input.cursor !== undefined &&
        (!/^[1-9]\d{0,3}$/.test(input.cursor) || Number(input.cursor) % 50 !== 0)) throw invalid();
    return parseSearch(await request('title/search', {query: input.query.trim()}, context, true), Number(input.cursor ?? 0));
  },
} satisfies SourceNetwork;
