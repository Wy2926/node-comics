import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin, rawLocation} from './definition';
import {byClass, coverUrl, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'rawlazy' || request.cursor || !request.query.trim() || [...request.query].length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
  return origin + '/?' + new URLSearchParams({s_manga: request.query});
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  searchUrl(request);
  const safe = inertHtml(html), lists = regions(safe, 'div', a => !!hasClass(a, 'row-of-mangas'));
  if (!lists.length) {
    if (!regions(safe, 'p', a => !!hasClass(a, 'text-danger')).some(p => textContent(p.body) === 'Sorry, no manga found!')) throw invalid();
    return {items: []};
  }
  const label = regions(safe, 'p', a => !!hasClass(a, 'font-15x')).filter(p => textContent(p.body).startsWith('Search: '));
  if (textContent(one(label, '搜索标题').body) !== 'Search: ' + request.query) throw invalid();
  const list = one(lists, '搜索列表').body, cards = regions(list, 'div', a => !!hasClass(a, 'entry-tag'));
  if (!cards.length || cards.length > 20) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    const heading = byClass(card.body, 'h2', 'name'), link = one(tags(heading, 'a'), '搜索作品');
    const loc = rawLocation(new URL(text(link.href), origin));
    if (!loc?.catalogSlug || loc.chapterSlug || seen.has(loc.catalogSlug)) throw invalid();
    seen.add(loc.catalogSlug);
    const poster = one(regions(card.body, 'a', a => !!hasClass(a, 'thumb')), '搜索封面');
    const posterLoc = rawLocation(new URL(text(poster.attrs.href), origin));
    if (!posterLoc || posterLoc.catalogSlug !== loc.catalogSlug || posterLoc.chapterSlug) throw invalid();
    const image = one(tags(poster.body, 'img'), '封面图片'), latest = regions(card.body, 'h4', () => true)[0];
    return {catalogId: catalogKey(loc.catalogSlug), catalogUrl: catalogUrl(loc.catalogSlug), title: text(textContent(heading), 1024),
      cover: coverUrl(image['data-src'] || image.src), ...(latest ? {latestLabel: text(textContent(latest.body), 512)} : {})};
  });
  return {items};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const body = await context.request(searchUrl(request));
  context.signal?.throwIfAborted(); return parseSearch(body, request);
}
