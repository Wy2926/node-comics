import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, isOrigin, origin} from './definition';
import {byClass, coverUrl, location, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function searchPage(request: SourceSearchRequest) {
  if (request.siteId !== 'hachiraw' || !request.query.trim() || [...request.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  return page;
}
export function searchUrl(request: SourceSearchRequest) {
  const page = searchPage(request);
  return origin + '/list-manga' + (page > 1 ? '/' + page : '') + '?' + new URLSearchParams({search: request.query});
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const page = searchPage(request), safe = inertHtml(html);
  const heading = textContent(byClass(safe, 'div', 'BoxHeader')), match = /^Search Manga\s*\(\s*(\d+)\)$/.exec(heading);
  if (!match) throw invalid();
  const total = Number(match[1]);
  const cards = regions(safe, 'div', a => !!hasClass(a, 'top-15') && !!a['ng-repeat']?.startsWith('Series in vm.Directory'));
  if (total > 100000 || cards.length !== Math.max(0, Math.min(20, total - (page - 1) * 20)) || page > Math.max(1, Math.ceil(total / 20))) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    const links = regions(card.body, 'a', a => !!hasClass(a, 'SeriesName'));
    const name = one(links.filter(link => link.attrs['ng-bind-html'] === 'Series.s'), '搜索作品');
    const loc = location(text(name.attrs.href));
    if (loc.chapter || seen.has(loc.slug) || links.length !== 2) throw invalid();
    seen.add(loc.slug);
    const poster = one(links.filter(link => tags(link.body, 'img').length === 1), '搜索封面');
    const owner = location(text(poster.attrs.href));
    if (owner.chapter || owner.slug !== loc.slug) throw invalid();
    const image = one(tags(poster.body, 'img'), '封面图片');
    return {catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title: text(textContent(name.body)), cover: coverUrl(image.src, loc.slug)};
  });
  const pagers = regions(safe, 'ul', a => !!hasClass(a, 'pagination'));
  if (pagers.length > 1 || total > 20 && !pagers.length) throw invalid();
  let next = false;
  if (pagers.length) {
    const pager = pagers[0].body;
    if (textContent(byClass(pager, 'li', 'active')) !== String(page)) throw invalid();
    for (const link of tags(pager, 'a')) {
      if (link.href === '#') continue;
      const url = new URL(text(link.href), origin), path = /^\/list-manga(?:\/([1-9]\d{0,3}))?$/.exec(url.pathname);
      if (!isOrigin(url) || url.hash || !path || [...url.searchParams.keys()].length !== 1 || url.searchParams.get('search') !== request.query ||
          Number(path[1] ?? 1) !== Number(link['data-ci-pagination-page'])) throw invalid();
      if (link.rel === 'next') {
        if (next || Number(path[1]) !== page + 1) throw invalid();
        next = true;
      }
    }
  }
  if (next !== (page * 20 < total)) throw invalid();
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request));
  context.signal?.throwIfAborted();
  return parseSearch(body, request);
}
