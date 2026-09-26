import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {sourceCover} from '../../shared/cover';
import {mangaCopyLocation} from './definition';

const pageSize = 12;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
const origins: Record<string, string> = {mangacopy: 'https://www.mangacopy.com', copy4000: 'https://www.copy4000.com'};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value.trim();
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) throw invalid();
  return Number(value);
}
export function searchUrl(request: SourceSearchRequest) {
  const origin = origins[request.siteId];
  if (!origin) throw invalid();
  const offset = request.cursor === undefined ? 0 : /^offset:[1-9]\d{0,5}$/.test(request.cursor) ? Number(request.cursor.slice(7)) : NaN;
  if (!Number.isSafeInteger(offset) || offset % pageSize) throw invalid();
  const url = new URL('/api/kb/web/searchci/comics', origin);
  url.search = new URLSearchParams({offset: String(offset), platform: '2', limit: String(pageSize), q: request.query, q_type: ''}).toString();
  return {url: url.href, offset, origin};
}
export function parseSearch(body: string, request: SourceSearchRequest): SourceSearchPage {
  const {offset, origin} = searchUrl(request), response = object(JSON.parse(body));
  if (response.code === 429) throw new SourceSearchError('SOURCE_SEARCH_RATE_LIMITED');
  if (response.code === 401 || response.code === 403) throw new SourceSearchError('SOURCE_SEARCH_VERIFICATION_REQUIRED');
  if (response.code !== 200) throw invalid();
  const result = object(response.results), total = number(result.total);
  if (number(result.offset) !== offset || number(result.limit) !== pageSize || !Array.isArray(result.list) ||
      result.list.length !== Math.min(pageSize, Math.max(0, total - offset))) throw invalid();
  const seen = new Set<string>();
  const items = result.list.map(value => {
    const row = object(value), slug = text(row.path_word, 180), url = new URL('/comic/' + slug, origin).href;
    if (mangaCopyLocation(url)?.slug !== slug || seen.has(slug) || !Array.isArray(row.author) || row.author.length > 30) throw invalid();
    seen.add(slug);
    return {catalogId: 'mangacopy:' + slug, catalogUrl: url, title: text(row.name),
      authors: row.author.map(author => text(object(author).name, 180)), cover: sourceCover(row.cover, origin)};
  });
  return {items, ...(offset + items.length < total ? {nextCursor: 'offset:' + (offset + pageSize)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(body, request);
}
