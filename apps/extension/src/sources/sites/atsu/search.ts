import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {catalogUrl, origin} from './definition';
import {assetUrl, count, id, list, object, request as read, text} from './protocol';

const pageSize = 24;
const invalid = (): never => {throw new SourceSearchError('SOURCE_SEARCH_INVALID');};
function page(request: SourceSearchRequest): number {
  if (request.siteId !== 'atsu' || !request.query.trim() || request.query.length > 512) return invalid();
  if (request.cursor === undefined) return 1;
  try {
    const cursor = object(JSON.parse(request.cursor));
    if (cursor.query !== request.query) return invalid();
    const number = count(cursor.page, 100000);
    return number > 1 ? number : invalid();
  } catch {return invalid();}
}
export function searchPath(request: SourceSearchRequest): string {
  // The public Typesense proxy is also used by the site's name search; no account or API key is sent.
  const params = new URLSearchParams({q: request.query, query_by: 'title,englishTitle,otherNames,acronyms',
    query_by_weights: '4,3,2,1', num_typos: '4,3,2,0', prefix: 'true,true,true,false', infix: 'off,off,fallback,off',
    include_fields: 'id,title,authors,poster,medium', filter_by: 'medium:=Comic && hidden:!=true',
    page: String(page(request)), per_page: String(pageSize)});
  return '/collections/manga/documents/search?' + params;
}
export function parseSearch(value: unknown, request: SourceSearchRequest): SourceSearchPage {
  const current = page(request), data = object(value), rows = list(data.hits, pageSize), found = count(data.found, 10000000);
  const expected = Math.min(pageSize, Math.max(0, found - (current - 1) * pageSize));
  if (data.page !== current || rows.length !== expected) return invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(object(value).document), mangaId = id(row.id);
    if (row.medium !== 'Comic' || seen.has(mangaId)) return invalid();
    seen.add(mangaId);
    return {catalogId: 'atsu:' + mangaId, catalogUrl: catalogUrl(mangaId), title: text(row.title),
      authors: row.authors == null ? undefined : list(row.authors, 100).map(value => text(value, 180)),
      cover: row.poster ? {url: assetUrl(row.poster, 'cover')} : undefined};
  });
  // Search has no content-language field. Country/type/name do not prove the language of its releases.
  return {items, ...(current * pageSize < found ? {nextCursor: JSON.stringify({query: request.query, page: current + 1})} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  return parseSearch(await read(searchPath(request), origin + '/explore', context), request);
}
