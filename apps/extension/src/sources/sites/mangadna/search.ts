import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin} from './definition';
import {byClass, coverUrl, location, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'mangadna') throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/search', origin);
  url.searchParams.set('q', request.query);
  if (page > 1) url.searchParams.set('page', String(page));
  return {url: url.href, page};
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html);
  if (textContent(byClass(safe, 'h1', 'boxtitle')) !== `RESULTS FOR "${request.query}"`) throw invalid();
  const list = byClass(safe, 'div', 'listupd'), cards = regions(list, 'div', a => !!hasClass(a, 'home-item'));
  if (cards.length > 50 || !cards.length && textContent(list) !== `No result for "${request.query}"`) throw invalid();
  const items = [], seen = new Set<string>();
  for (const card of cards) {
    const anchor = one(regions(byClass(card.body, 'h3', 'htitle'), 'a', () => true), '搜索作品');
    const loc = location(text(anchor.attrs.href));
    if (loc.chapter) throw invalid();
    const title = text(textContent(anchor.body), 1024);
    const artwork = one(tags(byClass(card.body, 'div', 'hthumb'), 'img'), '搜索封面');
    const chapters = regions(card.body, 'a', a => !!hasClass(a, 'btn-link'));
    for (const chapter of chapters) {
      const target = location(text(chapter.attrs.href));
      if (target.slug !== loc.slug || !target.chapter) throw invalid();
    }
    if (seen.has(loc.slug)) continue;
    seen.add(loc.slug);
    items.push({catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title,
      cover: coverUrl(artwork['data-src'] || artwork.src), ...(chapters.length ? {latestLabel: text(textContent(chapters[0].body), 512)} : {})});
  }
  const pager = byClass(safe, 'div', 'blog-pager');
  const links = tags(pager, 'a');
  if (links.length) {
    const current = one(regions(pager, 'li', a => !!hasClass(a, 'active')), '搜索当前页');
    const url = new URL(text(one(tags(current.body, 'a'), '搜索当前页地址').href), origin);
    if (url.searchParams.get('page') !== String(page)) throw invalid();
  }
  let next = false;
  for (const link of links) {
    const url = new URL(text(link.href), origin), targetPage = Number(url.searchParams.get('page'));
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/search' || url.hash ||
        url.searchParams.get('q') !== request.query || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 9999 ||
        [...url.searchParams.keys()].some(key => key !== 'q' && key !== 'page') ||
        url.searchParams.getAll('q').length !== 1 || url.searchParams.getAll('page').length !== 1) throw invalid();
    if (targetPage === page + 1) next = true;
  }
  if (!items.length && next) throw invalid();
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
