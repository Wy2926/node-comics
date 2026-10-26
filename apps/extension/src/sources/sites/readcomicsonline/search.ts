import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchRequest, type SourceSearchPage} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin} from './definition';
import {coverUrl, location, one, region, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(input: SourceSearchRequest) {
  if (input.siteId !== 'readcomicsonline' || !input.query.trim() || [...input.query].length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(input.query)) throw invalid();
  const page = input.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(input.cursor) ? Number(input.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/advanced-search', origin);
  url.searchParams.set('name', input.query);
  if (page > 1) url.searchParams.set('page', String(page));
  return {url: url.href, page};
}
export function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(input), main = region(inertHtml(html), 'main', () => true);
  if (one(tags(main, 'input').filter(a => a.name === 'name')).value !== input.query) throw invalid();
  const heading = textContent(one(regions(main, 'h2', () => true)).body);
  const count = /^Search results \((\d{1,6})\)$/.exec(heading);
  if (!count) throw invalid();
  const total = Number(count[1]), expected = Math.max(0, Math.min(60, total - (page - 1) * 60));
  if (page > Math.max(1, Math.ceil(total / 60))) throw invalid();
  const grids = regions(main, 'div', a => !!hasClass(a, 'grid-cols-3') && !!hasClass(a, 'md:grid-cols-6'));
  const list = total ? one(grids).body : '';
  if (!total && (grids.length || !regions(main, 'p', () => true).some(p => textContent(p.body) === 'No comics match those filters.')))
    throw invalid();
  const cards = regions(list, 'a', a => !!hasClass(a, 'group'));
  if (cards.length !== expected || tags(list, 'a').length !== cards.length || tags(list, 'img').length !== cards.length) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    const loc = location(text(card.attrs.href));
    if (loc.chapter || seen.has(loc.slug)) throw invalid();
    seen.add(loc.slug);
    const title = text(textContent(region(card.body, 'p', () => true))), poster = one(tags(card.body, 'img'));
    if (poster.alt?.replace(/\s+/g, ' ').trim() !== title) throw invalid();
    return {catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title, cover: coverUrl(text(poster.src), loc.slug)};
  });
  const pagers = regions(main, 'nav', a => a['aria-label'] === 'Pagination Navigation');
  const hasNext = page * 60 < total;
  if (total <= 60) {if (pagers.length) throw invalid();}
  else {
    const pager = one(pagers).body;
    if (textContent(region(pager, 'span', a => a['aria-current'] === 'page')) !== String(page)) throw invalid();
    const next = tags(pager, 'a').filter(a => a.rel === 'next');
    if (hasNext ? !next.length || next.length > 2 : next.length) throw invalid();
    for (const link of tags(pager, 'a')) {
      const url = new URL(text(link.href), origin), target = url.searchParams.get('page');
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== '/advanced-search' ||
          url.searchParams.getAll('name').length !== 1 || url.searchParams.get('name') !== input.query ||
          url.searchParams.getAll('page').length !== 1 || !/^[1-9]\d{0,3}$/.test(target ?? '') ||
          [...url.searchParams.keys()].some(key => !['name', 'page'].includes(key)) || Number(target) > Math.ceil(total / 60) ||
          link.rel === 'next' && Number(target) !== page + 1 || link.rel === 'prev' && Number(target) !== page - 1) throw invalid();
    }
  }
  return {items, ...(hasNext ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(input).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, input);
}
