import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchRequest, type SourceSearchPage} from '../../contracts/search';
import {api, catalogUrl} from './definition';
import {cover, entity, language, list, object, pagination, response, text} from './protocol';

const limit = 20;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  const page = request.cursor === undefined ? 1 : /^page:[2-9]\d{0,3}$|^page:1\d{1,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (request.siteId !== 'mangaball' || !Number.isSafeInteger(page) || page > 5000 || !request.query.trim() || request.query.length > 500) throw invalid();
  const url = new URL(api + '/title/search-advanced');
  // No source language filter or user identity is sent.
  url.search = new URLSearchParams({keyword: request.query, page: String(page), limit: String(limit)}).toString();
  return {url: url.href, page};
}
export function parseSearch(value: unknown, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), result = response(value), rows = list(result.data), meta = pagination(result.pagination, page, limit);
  if (rows.length !== meta.length) throw invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = entity(value), titleId = String(row.id);
    if (seen.has(titleId)) throw invalid();
    seen.add(titleId);
    // Public migrated records sometimes carry one language as a scalar instead of a singleton array.
    const contentLanguages = row.availableTranslatedLanguages == null ? [] : typeof row.availableTranslatedLanguages === 'string'
      ? [language(row.availableTranslatedLanguages)] : list(row.availableTranslatedLanguages).map(language);
    const authors = row.author == null ? [] : list(row.author).map(value => text(typeof value === 'string' ? value : object(value).name, 180));
    if (contentLanguages.length > 100 || authors.length > 30) throw invalid();
    return {catalogId: 'mangaball:' + titleId, catalogUrl: catalogUrl(titleId), title: text(row.name, 500),
      cover: cover(row.image), ...(authors.length ? {authors} : {}), ...(contentLanguages.length ? {contentLanguages: [...new Set(contentLanguages)]} : {})};
  });
  return {items, ...(page < meta.pages && page < 5000 ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(JSON.parse(body), request);
}
