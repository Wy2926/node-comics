import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {catalogUrl, origin} from './definition';
import {assetUrl, count, id, list, number, object, request as read, text} from './protocol';

const pageSize = 12;
const invalid = (): never => {throw new SourceSearchError('SOURCE_SEARCH_INVALID');};
export function searchPath(request: SourceSearchRequest): string {
  if (request.siteId !== 'mangadot' || !request.query.trim()) return invalid();
  const params = new URLSearchParams({search: request.query, limit: String(pageSize), sortBy: 'relevance', sortOrder: 'desc'});
  if (request.cursor !== undefined) {
    try {
      const cursor = object(JSON.parse(request.cursor));
      if (cursor.query !== request.query) return invalid();
      params.set('cursor', text(cursor.value, 2000));
    } catch {return invalid();}
  }
  return '/api/search?' + params;
}
export function parseSearch(value: unknown, request: SourceSearchRequest): SourceSearchPage {
  searchPath(request);
  const data = object(value), pagination = object(data.pagination), rows = list(data.manga_list, pageSize);
  if (data.query !== request.query || pagination.per_page !== pageSize || count(pagination.current_page, 1000000) < 1 ||
      count(pagination.total_results, 10000000) < rows.length) return invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), mangaId = id(row.id);
    if (seen.has(mangaId)) return invalid();
    seen.add(mangaId);
    return {catalogId: 'mangadot:' + mangaId, catalogUrl: catalogUrl(mangaId), title: text(row.title, 1024),
      latestLabel: row.latest_chapter_number == null ? undefined : `Ch. ${number(row.latest_chapter_number)}`,
      cover: row.photo ? {url: assetUrl(row.photo, 'cover')} : undefined};
  });
  // Search does not publish content languages/authors; do not substitute country_of_origin.
  const next = pagination.next_cursor;
  if (next == null) return {items};
  if (!rows.length) return invalid();
  const nextCursor = JSON.stringify({query: request.query, value: text(next, 2000)});
  if (nextCursor === request.cursor || nextCursor.length > 4096) return invalid();
  return {items, nextCursor};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  return parseSearch(await read(searchPath(request), origin + '/search', context), request);
}
