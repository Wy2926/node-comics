import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, origin} from './definition';

const pageSize = 12;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value.trim();
}
export function searchUrl(request: SourceSearchRequest) {
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (request.siteId !== 'comicpash' || !Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/api/search', origin);
  url.search = new URLSearchParams({q: request.query, page: String(page), size: String(pageSize)}).toString();
  return {url: url.href, page};
}
export function parseSearch(body: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), result = object(object(object(JSON.parse(body)).searchResult).series);
  const total = result.total, rows = result.series;
  if (!Number.isSafeInteger(total) || Number(total) < 0 || !Array.isArray(rows) ||
      rows.length !== Math.min(pageSize, Math.max(0, Number(total) - (page - 1) * pageSize))) throw invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), id = text(row.id, 128);
    if (!/^[a-zA-Z0-9]+$/.test(id) || seen.has(id)) throw invalid();
    seen.add(id);
    const authors = row.author == null ? [] : row.author;
    const thumbnails = row.thumbnailImages == null ? [] : row.thumbnailImages;
    const images = row.images == null ? [] : row.images;
    if (!Array.isArray(authors) || authors.length > 30 || !Array.isArray(thumbnails) || !Array.isArray(images)) throw invalid();
    const poster = thumbnails.map(object).find(image => image.size === 'large') ?? (images[0] ? object(images[0]) : undefined);
    const url = catalogUrl(id);
    return {catalogId: 'comicpash:series:' + id, catalogUrl: url, title: text(row.name, 1024),
      ...(authors.length ? {authors: authors.map(author => text(object(author).name, 180))} : {}), cover: sourceCover(poster?.url, url)};
  });
  // Only title matches are candidates. Author matches and individual episodes are separate source collections.
  return {items, ...(page * pageSize < Number(total) && page < 9999 ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(body, request);
}
