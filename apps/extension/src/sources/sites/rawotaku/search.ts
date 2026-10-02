import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin, rawLocation} from './definition';
import {byClass, coverUrl, one, region, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'rawotaku' || !request.query.trim() || [...request.query].length > 256) throw invalid();
  const url = new URL(request.cursor ?? '/', origin);
  if (request.cursor && (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== '/' ||
      url.searchParams.get('q') !== request.query || [...url.searchParams.keys()].some(key => key !== 'q' && key !== 'page') ||
      url.searchParams.getAll('q').length !== 1 || url.searchParams.getAll('page').length !== 1 ||
      !/^[1-9]\d{0,3}$/.test(url.searchParams.get('page') ?? ''))) throw invalid();
  url.searchParams.set('q', request.query); return url.href;
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const current = new URL(searchUrl(request)), safe = inertHtml(html), main = region(safe, 'div', a => a.id === 'main-content');
  const canonical = one(tags(safe, 'link').filter(a => a.rel === 'canonical'), '搜索身份');
  const identity = new URL(text(canonical.href), origin);
  if (identity.origin !== origin || identity.pathname !== '/' || identity.searchParams.get('q') !== request.query ||
      (identity.searchParams.get('page') ?? '1') !== (current.searchParams.get('page') ?? '1')) throw invalid();
  const cards = regions(main, 'div', a => !!hasClass(a, 'flw-item'));
  if (!cards.length) {
    if (textContent(byClass(main, 'div', 'notice')) !== 'データなし！') throw invalid();
    return {items: []};
  }
  if (cards.length > 100) throw invalid();
  const seen = new Set<string>();
  const items = cards.flatMap(card => {
    const heading = byClass(card.body, 'h3', 'manga-name'), link = one(tags(heading, 'a'), '搜索作品');
    const loc = rawLocation(new URL(text(link.href), origin));
    if (!loc || loc.chapter) throw invalid();
    if (seen.has(loc.slug)) return [];
    seen.add(loc.slug);
    const poster = byClass(card.body, 'a', 'manga-poster'), image = one(tags(poster, 'img'), '搜索封面');
    const posterLink = one(regions(card.body, 'a', a => !!hasClass(a, 'manga-poster')), '封面作品地址');
    const posterLoc = rawLocation(new URL(text(posterLink.attrs.href), origin));
    if (!posterLoc || posterLoc.slug !== loc.slug || posterLoc.chapter) throw invalid();
    const language = textContent(byClass(poster, 'span', 'tick-lang')).toLowerCase();
    const latest = regions(card.body, 'div', a => !!hasClass(a, 'chapter'))[0];
    return [{catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug), title: text(textContent(heading), 1024),
      cover: coverUrl(image['data-src'] || image.src), contentLanguages: [Intl.getCanonicalLocales(language)[0]],
      ...(latest ? {latestLabel: text(textContent(latest.body), 512)} : {})}];
  });
  if (items.length > 50) throw invalid();
  const pager = byClass(main, 'div', 'pre-pagination'), page = Number(current.searchParams.get('page') ?? 1);
  const next = tags(pager, 'a').map(a => new URL(text(a.href), origin)).filter(url =>
    url.searchParams.get('q') === request.query && Number(url.searchParams.get('page')) === page + 1);
  const nextCursor = next[0]?.href;
  if (nextCursor) searchUrl({...request, cursor: nextCursor});
  return {items, ...(nextCursor ? {nextCursor} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const html = await context.request(searchUrl(request));
  context.signal?.throwIfAborted(); return parseSearch(html, request);
}
