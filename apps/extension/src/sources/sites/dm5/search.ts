import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchHit, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, dm5Location, origin} from './definition';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'dm5') throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/search', origin);
  url.search = new URLSearchParams({title: request.query, page: String(page)}).toString();
  return {url: url.href, page};
}
function hit(markup: string, heading: 'p' | 'h2'): SourceSearchHit {
  const headings = [...markup.matchAll(new RegExp('<' + heading + '\\b([^>]*)>([\\s\\S]*?)<\\/' + heading + '\\s*>', 'gi'))].filter(m => hasClass(attributes(' ' + m[1]), 'title'));
  if (headings.length !== 1) throw invalid();
  const links = [...headings[0][2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  if (links.length !== 1) throw invalid();
  const link = attributes(' ' + links[0][1]), url = new URL(link.href, origin), loc = dm5Location(url), title = textContent(links[0][2]);
  if (!loc?.slug || loc.chapterId || !title || title.length > 500) throw invalid();
  const coverTag = tags(markup, 'p').find(a => hasClass(a, 'mh-cover'));
  const coverUrl = coverTag ? /background-image\s*:\s*url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/i.exec(coverTag.style ?? '')?.[1] : tags(markup, 'img')[0]?.src;
  const chapter = [...markup.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi)].find(m => hasClass(attributes(' ' + m[1]), 'chapter'));
  const subtitle = [...markup.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi)].find(m => hasClass(attributes(' ' + m[1]), 'subtitle'));
  const authors = subtitle ? [...subtitle[2].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].map(m => textContent(m[1])).filter(Boolean) : [];
  return {catalogId: 'dm5:' + loc.slug, catalogUrl: catalogUrl(loc.slug), title, cover: sourceCover(coverUrl, origin),
    ...(authors.length ? {authors} : {}), ...(chapter ? {latestLabel: textContent(chapter[2])} : {})};
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html), button = tags(safe, 'a').filter(a => a.id === 'btnSearch');
  if (button.length !== 1 || !/相近搜索结果[（(]\d+[）)]/.test(textContent(safe))) throw invalid();
  const echo = new URL(button[0].href, origin);
  // The website inserts its default language=1 in links even when the request omits it.
  if (echo.origin !== origin || echo.pathname !== '/search' || echo.searchParams.get('title') !== request.query || ![null, '1'].includes(echo.searchParams.get('language'))) throw invalid();
  const items: SourceSearchHit[] = [];
  const featured = /<div\b[^>]*class="banner_detail_form"[^>]*>([\s\S]*?)<\/section\s*>/i.exec(safe);
  if (featured) items.push(hit(featured[1], 'p'));
  const lists = [...safe.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul\s*>/gi)].filter(m => hasClass(attributes(' ' + m[1]), 'mh-list'));
  if (lists.length !== 1) throw invalid();
  for (const card of lists[0][2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    if (!tags(card[1], 'div').some(a => hasClass(a, 'mh-item'))) throw invalid();
    items.push(hit(card[1], 'h2'));
  }
  if (items.length > 50 || !items.length && !/相近搜索结果[（(]0[）)]/.test(textContent(safe))) throw invalid();
  const unique = [...new Map(items.map(item => [item.catalogId, item])).values()];
  const pagination = /<div\b[^>]*class="page-pagination\b[^\"]*"[^>]*>([\s\S]*?)<\/div\s*>/i.exec(safe);
  let next = false, current = false;
  if (pagination) for (const link of tags(pagination[1], 'a')) {
    const url = new URL(link.href, origin), target = Number(url.searchParams.get('page'));
    if (url.origin !== origin || url.pathname !== '/search' || url.searchParams.get('title') !== request.query || ![null, '1'].includes(url.searchParams.get('language')) ||
        !Number.isSafeInteger(target) || target < 1 || [...url.searchParams.keys()].some(key => !['title', 'language', 'page'].includes(key))) throw invalid();
    if (hasClass(link, 'active')) {if (target !== page || current) throw invalid(); current = true;}
    if (target === page + 1) next = true;
  }
  if (pagination && !current || page > 1 && !pagination) throw invalid();
  return {items: unique, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
