import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceSearchRequest, SourceSearchPage} from '../../contracts/search';
import {catalogKey, catalogUrl, origin} from './definition';
import {count, cover, invalid, json, language, list, object, request, slug, text} from './protocol';

function cursorData(input: SourceSearchRequest) {
  if (input.cursor === undefined) return;
  const cursor = json(text(input.cursor, 4096));
  if (cursor.query !== input.query.trim()) return invalid();
  return {token: text(cursor.token, 3000), ids: list(cursor.ids, 50).map(id => count(id, Number.MAX_SAFE_INTEGER))};
}

export function searchUrl(input: SourceSearchRequest): string {
  if (input.siteId !== 'comickz') return invalid();
  const query = text(input.query, 256), url = new URL('/api/search', origin);
  url.searchParams.set('q', query);
  const cursor = cursorData(input);
  if (cursor) url.searchParams.set('cursor', cursor.token);
  return url.href;
}
export function parseSearch(body: string, input: SourceSearchRequest): SourceSearchPage {
  searchUrl(input);
  const data = json(body), seen = new Set<string>(), ids: number[] = [], previous = new Set(cursorData(input)?.ids);
  const candidates = list(data.data, 50).map(value => {
    const row = object(value), work = slug(row.slug), id = count(row.id, Number.MAX_SAFE_INTEGER);
    if (!id || ids.includes(id)) return invalid();
    ids.push(id);
    if (seen.has(work)) return invalid();
    seen.add(work);
    let contentLanguages: string[] | undefined;
    if (row.lang_list != null) {
      const raw = text(row.lang_list, 1000);
      if (!/^\{[^{}]*\}$/.test(raw)) return invalid();
      contentLanguages = raw === '{}' ? [] : [...new Set(raw.slice(1, -1).split(',').map(language))];
    }
    return {catalogId: catalogKey(work), catalogUrl: catalogUrl(work), title: text(row.title), cover: cover(row.default_thumbnail, work), contentLanguages};
  });
  // The source can overlap or repeat cursor pages while issuing fresh encrypted tokens.
  // Keep one bounded page of IDs, suppress overlaps, and stop when it makes no progress.
  const items = candidates.filter((_row, index) => !previous.has(ids[index]));
  return {items, ...(data.next_cursor == null || !items.length ? {} : {
    nextCursor: text(JSON.stringify({query: input.query.trim(), token: text(data.next_cursor, 3000), ids}), 4096),
  })};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  return parseSearch(await request(searchUrl(input), context), input);
}
