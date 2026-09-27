import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchRequest, type SourceSearchPage} from '../../contracts/search';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {languages, location, origin} from './definition';
import {imageUrl, label} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  const language = request.siteId.replace(/^webtoons-/, '') as keyof typeof languages;
  const cursor = /^(originals|canvas):([1-9]\d{0,2})$/.exec(request.cursor ?? 'originals:1');
  if (request.siteId !== 'webtoons-' + language || !Object.hasOwn(languages, language) || !cursor || !request.query.trim()) throw invalid();
  const section = cursor[1], page = Number(cursor[2]);
  const url = new URL(`/${language}/search/${section}`, origin);
  url.search = new URLSearchParams({keyword: request.query, page: String(page)}).toString();
  return {url: url.href, language, section, page};
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const target = searchUrl(request), safe = inertHtml(html), anchors = [...safe.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  // The active source search tab distinguishes a real empty result from an access/error page.
  if (!anchors.some(m => {const a = attributes(' ' + m[1]); if (a['aria-current'] !== 'page' || !a.href) return false;
    const url = new URL(a.href, origin); return url.origin === origin && url.pathname === new URL(target.url).pathname && url.searchParams.get('keyword') === request.query;})) throw invalid();
  const current = anchors.filter(m => {const a = attributes(' ' + m[1]); return hasClass(a, 'pagination') && a['aria-current'] === 'true';});
  if (current.length > 1 || (target.page > 1 && !current.length) || current.length && Number(textContent(current[0][2])) !== target.page) throw invalid();
  const seen = new Set<string>();
  const items = anchors.filter(m => hasClass(attributes(' ' + m[1]), '_card_item')).map(m => {
    const attrs = attributes(' ' + m[1]), url = new URL(attrs.href, origin), loc = location(url), title = label(m[2], 'title');
    if (!loc || loc.episode || loc.language !== target.language || loc.section !== target.section || !title || seen.has(loc.key) || attrs['data-title-no'] !== loc.title) throw invalid();
    seen.add(loc.key);
    const author = label(m[2], 'author'), cover = tags(m[2], 'img')[0];
    return {catalogId: loc.key, catalogUrl: loc.catalogUrl, title, ...(author ? {authors: [author]} : {}),
      contentLanguages: [languages[loc.language]], ...(cover ? {cover: {url: imageUrl(cover.src)}} : {})};
  });
  const next = tags(safe, 'a').some(a => {
    if (!hasClass(a, 'pagination') || !a.href || a.href === '#') return false;
    const url = new URL(a.href, origin);
    if (url.origin !== origin || url.pathname !== new URL(target.url).pathname || url.searchParams.get('keyword') !== request.query) throw invalid();
    return Number(url.searchParams.get('page')) === target.page + 1;
  }) || tags(safe, 'button').some(a => {
    if (!hasClass(a, 'next') || !a['data-url-to']) return false;
    const url = new URL(a['data-url-to'], origin);
    if (url.origin !== origin || url.pathname !== new URL(target.url).pathname || url.searchParams.get('keyword') !== request.query) throw invalid();
    return Number(url.searchParams.get('page')) === target.page + 1;
  });
  if (next && (!items.length || target.page >= 999)) throw invalid();
  return {items, nextCursor: next ? `${target.section}:${target.page + 1}` : target.section === 'originals' ? 'canvas:1' : undefined};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  const result = parseSearch(body, request);
  // An empty Originals result must still search Canvas; the shared UI hides empty result pagination.
  if (!result.items.length && result.nextCursor === 'canvas:1') return search({...request, cursor: result.nextCursor}, context);
  return result;
}
