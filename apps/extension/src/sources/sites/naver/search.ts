import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchHit, type SourceSearchRequest} from '../../contracts/search';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, levels, origin, type Section} from './definition';

const sections: readonly Section[] = ['webtoon', 'bestChallenge', 'challenge'];
const pageSize = 10;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value.trim();
}
export function searchPosition(request: SourceSearchRequest) {
  if (request.siteId !== 'naver') throw invalid();
  if (request.cursor === undefined) return {page: 1, sections};
  const match = /^page:([1-9]\d{0,3}):([a-zA-Z,]+)$/.exec(request.cursor);
  if (!match || Number(match[1]) < 2) throw invalid();
  const active = sections.filter(section => match[2].split(',').includes(section));
  if (!active.length || active.join(',') !== match[2]) throw invalid();
  return {page: Number(match[1]), sections: active};
}
export function searchUrl(query: string, section: Section, page: number) {
  const url = new URL('/api/search/' + section, origin);
  // The site's client pre-encodes the keyword before its HTTP query serializer.
  url.search = new URLSearchParams({keyword: encodeURIComponent(query), page: String(page)}).toString();
  return url.href;
}
export function parseSearch(body: string, section: Section, page: number) {
  const result = object(JSON.parse(body)), meta = object(result.pageInfo), total = meta.totalRows;
  if (!Number.isSafeInteger(total) || Number(total) < 0 || meta.pageSize !== pageSize || meta.page !== page ||
      meta.totalPages !== Math.max(1, Math.ceil(Number(total) / pageSize)) || !Array.isArray(result.searchList) ||
      result.searchList.length !== Math.min(pageSize, Math.max(0, Number(total) - (page - 1) * pageSize))) throw invalid();
  const seen = new Set<number>();
  const items = result.searchList.map(value => {
    const row = object(value), id = row.titleId;
    if (!Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > 9999999999 || row.webtoonLevelCode !== levels[section] || seen.has(Number(id))) throw invalid();
    seen.add(Number(id));
    const artists = row.communityArtists;
    if (artists != null && (!Array.isArray(artists) || artists.length > 30)) throw invalid();
    const authors = Array.isArray(artists) && artists.length ? artists.map(artist => text(object(artist).name, 180))
      : row.displayAuthor ? [text(row.displayAuthor, 180)] : [];
    const url = catalogUrl(String(id), section);
    return {catalogId: 'naver:' + section + ':' + id, catalogUrl: url, title: text(row.titleName, 1024),
      ...(authors.length ? {authors} : {}), cover: sourceCover(row.thumbnailUrl, url),
      ...(row.publishDescription ? {latestLabel: text(row.publishDescription, 512)} : {})};
  });
  return {items, hasNext: page < Number(meta.totalPages)};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  const position = searchPosition(request), items: SourceSearchHit[] = [], next: Section[] = [];
  // One bounded page from each supported section; exhausted sections are absent from the next cursor.
  for (const section of position.sections) {
    context.signal?.throwIfAborted();
    const body = await context.request(searchUrl(request.query, section, position.page));
    context.signal?.throwIfAborted();
    const result = parseSearch(body, section, position.page);
    items.push(...result.items);
    if (result.hasNext) next.push(section);
  }
  return {items, ...(next.length && position.page < 9999 ? {nextCursor: `page:${position.page + 1}:${next.join(',')}`} : {})};
}
