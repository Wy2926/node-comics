import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, klLocation, origin} from './definition';
import {byClass, coverUrl, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function searchPage(request: SourceSearchRequest) {
  if (request.siteId !== 'klmanga' || !request.query.trim() || [...request.query].length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  return page;
}
export function searchUrl(request: SourceSearchRequest) {
  const page = searchPage(request);
  return origin + (page > 1 ? `/page/${page}/` : '/') + '?' + new URLSearchParams({s: request.query});
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const page = searchPage(request), safe = inertHtml(html);
  if (textContent(one(regions(safe, 'h4', () => true).filter(h => textContent(h.body).startsWith('Search: ')), '搜索标题').body)
      !== 'Search: ' + request.query.replace(/\s+/g, ' ').trim()) throw invalid();
  const lists = regions(safe, 'div', a => !!hasClass(a, 'grid-of-mangas'));
  if (!lists.length) {
    if (!regions(safe, 'p', () => true).some(p => textContent(p.body) === 'There is no item found!')) throw invalid();
    return {items: []};
  }
  const list = one(lists, '搜索列表').body, cards = regions(list, 'div', a => !!hasClass(a, 'entry'));
  if (!cards.length || cards.length > 20) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    const heading = byClass(card.body, 'h2', 'name'), link = one(tags(heading, 'a'), '搜索作品');
    const loc = klLocation(new URL(text(link.href), origin));
    if (!loc || loc.chapter || seen.has(loc.slug)) throw invalid();
    seen.add(loc.slug);
    const thumb = one(regions(card.body, 'a', a => !!hasClass(a, 'thumb')), '搜索封面');
    const poster = klLocation(new URL(text(thumb.attrs.href), origin));
    if (!poster || poster.chapter || poster.slug !== loc.slug) throw invalid();
    const image = one(tags(thumb.body, 'img'), '封面图片');
    const latest = regions(card.body, 'a', a => !!hasClass(a, 'meta-info'));
    if (latest.length > 1) throw invalid();
    return {catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title: text(textContent(heading), 1024),
      cover: coverUrl(image['data-src'] || image.src), ...(latest.length ? {latestLabel: text(textContent(latest[0].body), 512)} : {})};
  });
  const pager = byClass(safe, 'div', 'z-pagination'), links = tags(pager, 'a');
  const current = regions(pager, 'span', a => !!hasClass(a, 'current'));
  if (pager.trim() || page > 1) {
    const selected = one(current, '搜索页码');
    if (selected.attrs['aria-current'] !== 'page' || textContent(selected.body) !== String(page)) throw invalid();
  }
  let next = false, previous = false;
  for (const link of links) {
    const url = new URL(text(link.href), origin), path = /^\/page\/([1-9]\d{0,3})\/$/.exec(url.pathname);
    const targetPage = url.pathname === '/' ? 1 : path ? Number(path[1]) : NaN;
    if (url.origin !== origin || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].length !== 1 || url.searchParams.get('s') !== request.query || !Number.isSafeInteger(targetPage)) throw invalid();
    if (hasClass(link, 'next')) {
      if (next || targetPage !== page + 1) throw invalid();
      next = true;
    }
    if (hasClass(link, 'prev')) {
      if (previous || targetPage !== page - 1) throw invalid();
      previous = true;
    }
  }
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const body = await context.request(searchUrl(request));
  context.signal?.throwIfAborted(); return parseSearch(body, request);
}
