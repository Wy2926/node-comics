import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, mangapillLocation, origin} from './definition';
import {coverUrl, one, region, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'mangapill' || !request.query.trim() || [...request.query].length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/search', origin);
  url.searchParams.set('q', request.query);
  if (page > 1) url.searchParams.set('page', String(page));
  return {url: url.href, page};
}
function paginationPage(value: string, query: string) {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== '/search' ||
      url.searchParams.get('q') !== query || url.searchParams.getAll('q').length !== 1 ||
      !/^[1-9]\d{0,3}$/.test(url.searchParams.get('page') ?? '') || url.searchParams.getAll('page').length !== 1 ||
      [...url.searchParams.keys()].some(key => !['q', 'page', 'status', 'type'].includes(key)) ||
      ['status', 'type'].some(key => url.searchParams.getAll(key).length > 1 || (url.searchParams.get(key) ?? '') !== ''))
    throw invalid();
  return Number(url.searchParams.get('page'));
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html);
  const query = one(tags(safe, 'input').filter(a => a.name === 'q'), '搜索查询');
  if (query.value !== request.query) throw invalid();
  const list = region(safe, 'div', a => !!hasClass(a, 'grid') && !!hasClass(a, 'justify-end') && !!hasClass(a, 'lg:grid-cols-5'));
  const covers = regions(list, 'a', a => !!hasClass(a, 'relative') && !!hasClass(a, 'block'));
  const titles = regions(list, 'a', a => !!hasClass(a, 'mb-2'));
  if (covers.length > 50 || covers.length !== titles.length || tags(list, 'img').length !== covers.length ||
      tags(list, 'a').length !== covers.length * 2) throw invalid();
  if (!covers.length && (!/\bNo results found\b/.test(textContent(safe)) || list.trim())) throw invalid();
  const seen = new Set<string>();
  const items = covers.map((card, index) => {
    const titleCard = titles[index], url = new URL(text(titleCard.attrs.href), origin), loc = mangapillLocation(url);
    const poster = mangapillLocation(new URL(text(card.attrs.href), origin));
    if (!loc || !loc.slug || loc.chapter || !poster || poster.chapter || poster.work !== loc.work || seen.has(loc.work)) throw invalid();
    seen.add(loc.work);
    const title = text(textContent(region(titleCard.body, 'div', a => !!hasClass(a, 'font-black') && !!hasClass(a, 'line-clamp-2'))));
    const image = one(tags(card.body, 'img'), '搜索封面');
    const cover = coverUrl(image['data-src'] || image.src, loc.work);
    if (!cover) throw invalid();
    return {catalogId: catalogKey(loc.work), catalogUrl: url.href, title, cover};
  });
  const pager = region(safe, 'div', a => !!hasClass(a, 'flex') && !!hasClass(a, 'items-center') &&
    !!hasClass(a, 'justify-center') && !!hasClass(a, 'my-3') && !!hasClass(a, 'gap-3'));
  const links = regions(pager, 'a', () => true), next = links.filter(link => textContent(link.body) === 'Next');
  const previous = links.filter(link => textContent(link.body) === 'Previous');
  if (next.length > 1 || previous.length !== (page > 1 ? 1 : 0) || links.length !== next.length + previous.length ||
      next.some(link => paginationPage(text(link.attrs.href), request.query) !== page + 1) ||
      previous.some(link => paginationPage(text(link.attrs.href), request.query) !== page - 1) || next.length && !items.length)
    throw invalid();
  return {items, ...(next.length ? {nextCursor: 'page:' + (page + 1)} : {})};
}
/** The source's small quick-search fragment supplies the canonical parent URL for a verified chapter. */
export function resolveQuickCatalog(html: string, work: string) {
  const cards = regions(inertHtml(html), 'a', () => true);
  if (cards.length > 50) throw Error('MangaPill 作品定位结果无效。');
  const selected = cards.filter(card => {
    const loc = mangapillLocation(new URL(text(card.attrs.href), origin));
    return loc?.work === work && !loc.chapter;
  });
  const card = one(selected, '章节作品定位'), url = new URL(text(card.attrs.href), origin), loc = mangapillLocation(url);
  if (!loc?.slug || loc.chapter || url.search || url.hash) throw Error('MangaPill 作品定位地址无效。');
  const image = one(tags(card.body, 'img'), '定位作品封面');
  if (!coverUrl(image['data-src'] || image.src, work)) throw Error('MangaPill 定位作品封面归属错误。');
  return url.href;
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
