import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {sourceCover} from '../../shared/cover';
import {comixLocation} from './definition';
import {api, object} from './api';

const pageSize = 12;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function pageNumber(request: SourceSearchRequest) {
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (request.siteId !== 'comix' || !Number.isSafeInteger(page)) throw invalid();
  return page;
}
export function parseSearch(result: Record<string, unknown>, request: SourceSearchRequest): SourceSearchPage {
  const page = pageNumber(request), meta = object(result.meta), total = meta.total;
  if (!Number.isSafeInteger(total) || Number(total) < 0 || meta.perPage !== pageSize || meta.page !== page ||
      meta.lastPage !== Math.max(1, Math.ceil(Number(total) / pageSize)) || meta.hasNext !== (page < Number(meta.lastPage)) ||
      !Array.isArray(result.items) || result.items.length !== Math.min(pageSize, Math.max(0, Number(total) - (page - 1) * pageSize))) throw invalid();
  const seen = new Set<string>();
  const items = result.items.map(value => {
    const row = object(value);
    if (typeof row.url !== 'string' || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 1024) throw invalid();
    const url = new URL(row.url, 'https://comix.to'), loc = comixLocation(url);
    if (!loc || loc.chapterId || loc.hid !== row.hid || url.search || url.hash || seen.has(loc.hid)) throw invalid();
    seen.add(loc.hid);
    const poster = row.poster == null ? {} : object(row.poster);
    return {catalogId: 'comix:' + loc.hid, catalogUrl: url.href, title: row.title.trim(),
      cover: sourceCover(poster.large, url.href) ?? sourceCover(poster.medium, url.href),
      ...(typeof row.latestChapter === 'number' && Number.isFinite(row.latestChapter) && row.latestChapter > 0
        ? {latestLabel: 'Chapter ' + row.latestChapter} : {})};
  });
  // originalLanguage describes the original work, not the language of available chapters.
  return {items, ...(meta.hasNext && page < 9999 ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  const page = pageNumber(request);
  const result = await api('/manga', context, {keyword: request.query, limit: String(pageSize), page: String(page), 'order[relevance]': 'desc'});
  return parseSearch(result, request);
}
