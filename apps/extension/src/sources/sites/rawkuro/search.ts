import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origins} from './definition';
import {byClass, byId, coverUrl, location, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function searchLocation(request: SourceSearchRequest) {
  if (!Object.hasOwn(origins, request.siteId) || !request.query.trim() || [...request.query].length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  return {origin: origins[request.siteId as keyof typeof origins], page};
}
export function searchUrl(request: SourceSearchRequest) {
  const {origin, page} = searchLocation(request);
  return origin + '/search/' + (page > 1 ? page + '/' : '') + '?' + new URLSearchParams({keyword: request.query});
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {origin, page} = searchLocation(request), safe = inertHtml(html), main = byId(safe, 'div', 'Blog1');
  if (textContent(one(regions(main, 'h1', () => true), '搜索标题').body) !== '検索結果：' + request.query.trim()) throw invalid();
  const grids = regions(main, 'div', a => !!hasClass(a, 'gtc-f141a'));
  if (!grids.length) {
    if (page !== 1 || !regions(main, 'p', () => true).some(row => textContent(row.body) === '漫画は見つかりません！')) throw invalid();
    return {items: []};
  }
  const grid = one(grids, '搜索列表').body, cards = regions(grid, 'div', () => true), seen = new Set<string>();
  if (!cards.length || cards.length > 100) throw invalid();
  const items = cards.map(card => {
    const name = one(regions(byClass(card.body, 'div', 'text-center'), 'a', () => true), '搜索作品');
    const loc = location(text(name.attrs.href), origin);
    if (loc.chapter || seen.has(loc.slug)) throw invalid();
    seen.add(loc.slug);
    const poster = one(regions(card.body, 'a', a => !!hasClass(a, 'pt-140p')), '搜索封面');
    const owner = location(text(poster.attrs.href), origin), img = one(tags(poster.body, 'img'), '封面图片');
    if (owner.chapter || owner.slug !== loc.slug) throw invalid();
    return {catalogId: catalogKey(loc), catalogUrl: catalogUrl({...loc, origin}), title: text(textContent(name.body)),
      cover: coverUrl(img['data-src'] || img.src, origin)};
  });
  const pager = byId(main, 'div', 'blog-pager');
  if (textContent(byClass(pager, 'span', 'pagecurrent')) !== String(page)) throw invalid();
  let maxPage = page, next = false;
  for (const link of tags(pager, 'a')) {
    const url = new URL(text(link.href), origin), match = /^\/search(?:\/([1-9]\d{0,3}))?\/?$/.exec(url.pathname);
    if (url.origin !== origin || url.username || url.password || url.hash || !match ||
      [...url.searchParams.keys()].length !== 1 || url.searchParams.get('keyword') !== request.query) throw invalid();
    const target = Number(match[1] ?? 1);
    maxPage = Math.max(maxPage, target); if (target === page + 1) next = true;
  }
  if ((maxPage > page) !== next) throw invalid();
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const body = await context.request(searchUrl(request));
  context.signal?.throwIfAborted(); return parseSearch(body, request);
}
