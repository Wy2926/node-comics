import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceSearchPage, SourceSearchRequest} from '../../contracts/search';
import {inertHtml} from '../../shared/html';
import {catalogKey, origin} from './definition';
import {imageUrl, integer, island, location, object, prop, text} from './html';

export function searchUrl(input: SourceSearchRequest) {
  const query = text(input.query), page = input.cursor === undefined ? 1 : Number(input.cursor);
  if (input.siteId !== 'asurascans' || query.length > 200 || input.cursor !== undefined &&
      (!/^[1-9]\d*$/.test(input.cursor) || page < 2 || page > 500)) throw Error('Asura Scans 搜索参数无效。');
  const url = new URL('/browse/comics', origin);
  url.searchParams.set('search', query); url.searchParams.set('page', String(page));
  return url.href;
}
export function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
  const url = new URL(searchUrl(input)), page = Number(url.searchParams.get('page'));
  const props = island(inertHtml(html), 'BrowseFilters'), rows = prop(props, 'initialSeries');
  const total = integer(prop(props, 'totalCount')), last = integer(prop(props, 'initialTotalPages'), 500);
  if (prop(props, 'fixedContentMode') !== 'comics' || prop(props, 'initialQuery') !== input.query.trim() ||
      integer(prop(props, 'initialCurrentPage'), 500) !== page || last !== Math.ceil(total / 20) ||
      page > Math.max(1, last) || !Array.isArray(rows) || rows.length !== Math.min(20, Math.max(0, total - (page - 1) * 20)))
    throw Error('Asura Scans 搜索分页不完整或结构已变化。');
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), loc = location(text(row.public_url));
    if (loc.chapter !== undefined || row.slug !== loc.work || !['manga', 'manhwa', 'manhua'].includes(text(row.type)) || seen.has(loc.work))
      throw Error('Asura Scans 搜索结果重复或作品归属不符。');
    seen.add(loc.work);
    return {catalogId: catalogKey(loc.work), catalogUrl: loc.catalogUrl, title: text(row.title),
      ...(row.author ? {authors: [text(row.author)]} : {}), cover: {url: imageUrl(row.cover, 'covers')},
      latestLabel: integer(row.chapter_count) + ' chapters'};
  });
  return {items, ...(page < last ? {nextCursor: String(page + 1)} : {})};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  const url = searchUrl(input);
  context.signal?.throwIfAborted(); const html = await context.request(url); context.signal?.throwIfAborted();
  return parseSearch(html, input);
}
