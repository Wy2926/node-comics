import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceSearchPage, SourceSearchRequest} from '../../contracts/search';
import {catalogKey, catalogUrl, origin} from './definition';
import {asset, invalid, list, object, remoteId, request, sourceLocation, text} from './protocol';

function searchInput(input: SourceSearchRequest) {
  const query = text(input.query, 200);
  if (input.siteId !== 'mangataro') return invalid();
  let page = 1;
  if (input.cursor !== undefined) {
    const cursor = object(JSON.parse(text(input.cursor, 1024)));
    if (cursor.query !== query || typeof cursor.page !== 'number' || !Number.isInteger(cursor.page) || cursor.page < 2 || cursor.page > 1000) return invalid();
    page = cursor.page;
  }
  return {query, page};
}
export function parseSearch(body: string, input: SourceSearchRequest): SourceSearchPage {
  const {query, page} = searchInput(input), rows = list(JSON.parse(body), 100), ids = new Set<string>(), slugs = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), id = remoteId(row.id), loc = sourceLocation(text(row.url, 2048));
    if (loc.id || ids.has(id) || slugs.has(loc.slug)) return invalid();
    ids.add(id); slugs.add(loc.slug);
    return {catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title: text(row.title),
      cover: {url: asset(row.cover)}, type: text(row.type, 40)};
  }).filter(row => row.type !== 'Novel').map(({type: _type, ...row}) => row);
  // Like the native browse page, only an empty server page proves the end.
  return {items, ...(rows.length && page < 1000 ? {nextCursor: JSON.stringify({query, page: page + 1})} : {})};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  const {query, page} = searchInput(input);
  const form = {page: String(page), search: query, years: '[]', genres: '[]', types: '[]', statuses: '[]', sort: 'latest', genreMatchMode: 'AND'};
  return parseSearch(await request(origin + '/wp-json/manga/v1/load', context, origin + '/browse', form), input);
}
