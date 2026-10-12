import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, isOrigin, origin} from './definition';
import {byClass, cover, location, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function pageNumber(request: SourceSearchRequest) {
  if (request.siteId !== 'webtoonscan' || !request.query.trim() || [...request.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  if (request.cursor !== undefined && !/^page:[1-9]\d{0,3}$/.test(request.cursor)) throw invalid();
  return request.cursor ? Number(request.cursor.slice(5)) : 1;
}
export function searchUrl(request: SourceSearchRequest) {
  const page = pageNumber(request);
  return origin + (page === 1 ? '/' : `/page/${page}/`) + '?' + new URLSearchParams({s: request.query, post_type: 'wp-manga'});
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const page = pageNumber(request), safe = inertHtml(html);
  const query = one(tags(safe, 'input').filter(a => a.name === 's' && hasClass(a, 'search-field')), '搜索条件');
  if (query.value !== request.query) throw invalid();
  const cards = regions(safe, 'div', a => !!hasClass(a, 'c-tabs-item__content'));
  const headings = regions(safe, 'h1', a => !!hasClass(a, 'h4'));
  if (!cards.length && !headings.length && page === 1 &&
      regions(safe, 'p', () => true).some(p => textContent(p.body) === 'No matches found. Try a different search...')) return {items: []};
  const heading = textContent(one(headings, '搜索结果数').body), match = /^(\d+) results for "([\s\S]*)"$/.exec(heading);
  if (!match || match[2] !== request.query) throw invalid();
  const total = Number(match[1]);
  if (total > 100000 || page > Math.max(1, Math.ceil(total / 20)) || cards.length !== Math.min(20, total - (page - 1) * 20)) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    const link = one(regions(byClass(card.body, 'div', 'post-title'), 'a', () => true), '搜索作品');
    const loc = location(link.attrs.href);
    if (loc.chapter || seen.has(loc.slug)) throw invalid();
    seen.add(loc.slug);
    return {catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title: text(textContent(link.body)),
      cover: cover(byClass(card.body, 'div', 'tab-thumb'), loc.slug)};
  });
  const pagers = regions(safe, 'div', a => !!hasClass(a, 'wp-pagenavi'));
  if (pagers.length > 1 || total > 20 && pagers.length !== 1) throw invalid();
  let next = false;
  if (pagers.length) {
    if (textContent(byClass(pagers[0].body, 'span', 'current')) !== String(page)) throw invalid();
    const links = tags(pagers[0].body, 'a').filter(a => a.rel === 'next');
    if (links.length > 1) throw invalid();
    if (links.length) {
      const nextUrl = new URL(text(links[0].href), origin);
      if (!isOrigin(nextUrl) || nextUrl.hash || nextUrl.pathname !== `/page/${page + 1}/` ||
          [...nextUrl.searchParams].length !== 2 || nextUrl.searchParams.get('s') !== request.query || nextUrl.searchParams.get('post_type') !== 'wp-manga') throw invalid();
      next = true;
    }
  }
  if (next !== (page * 20 < total)) throw invalid();
  return {items, ...(next ? {nextCursor: `page:${page + 1}`} : {})};
}
