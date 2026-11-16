import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin} from './definition';
import {coverUrl, location, one, region, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'mangago' || !request.query.trim() || request.query.length > 150 || /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/r/l_search/', origin); url.searchParams.set('name', request.query);
  if (page > 1) url.searchParams.set('page', String(page));
  return {url: url.href, page};
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html);
  if (one(tags(safe, 'input').filter(a => a.id === 'searchform_name')).value !== request.query ||
      textContent(region(safe, 'title')) !== `${request.query} Search Result Page ${page} - Mangago`) throw invalid();
  const list = region(safe, 'ul', a => a.id === 'search_list'), rows = regions(list, 'li'), seen = new Set<string>();
  if (rows.length > 50 || rows.length !== tags(list, 'li').length || !rows.length && !/\bTotal:\s*0\b/.test(textContent(safe))) throw invalid();
  const items = rows.map(row => {
    const link = one(regions(region(row.body, 'h2'), 'a')), loc = location(text(link.attrs.href));
    const poster = one(regions(row.body, 'a', a => !!hasClass(a, 'thm-effect'))), owner = location(text(poster.attrs.href));
    if (loc.chapter || owner.chapter || loc.work !== owner.work || seen.has(loc.work)) throw invalid();
    seen.add(loc.work);
    const title = text(textContent(link.body)), img = one(tags(poster.body, 'img'));
    if (img.alt !== title) throw invalid();
    return {catalogId: catalogKey(loc.work), catalogUrl: catalogUrl(loc.work), title, cover: coverUrl(text(img.src))};
  });
  const pagers = regions(safe, 'div', a => !!hasClass(a, 'pagination'));
  if (!pagers.length) {
    if (page !== 1) throw invalid();
    return {items};
  }
  const pager = one(pagers), total = Number(pager.attrs.total);
  if (!/^[1-9]\d{0,3}$/.test(pager.attrs.total ?? '') || total < page || !items.length) throw invalid();
  const current = one(regions(pager.body, 'li', a => !!hasClass(a, 'current')));
  if (textContent(current.body) !== String(page)) throw invalid();
  const pages = regions(pager.body, 'a').map(link => {
    const url = new URL(text(link.attrs.href), origin);
    if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== '/r/l_search/' ||
        url.searchParams.getAll('name').length !== 1 || url.searchParams.get('name') !== request.query ||
        url.searchParams.getAll('page').length !== 1 || !/^[1-9]\d{0,3}$/.test(url.searchParams.get('page') ?? '') ||
        [...url.searchParams.keys()].some(k => !['name', 'page'].includes(k))) throw invalid();
    const n = Number(url.searchParams.get('page')); if (n > total) throw invalid();
    return n;
  });
  if (!pages.includes(page) || page < total && !pages.includes(page + 1)) throw invalid();
  return {items, ...(page < total ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
