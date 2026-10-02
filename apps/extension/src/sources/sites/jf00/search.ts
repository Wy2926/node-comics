import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, jfLocation, origin} from './definition';
import {coverUrl, div, one, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'jf00') throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = page === 1 ? new URL('/search', origin) : new URL(`/search/${encodeURIComponent(request.query)}/${page}`, origin);
  if (page === 1) url.searchParams.set('key', request.query);
  return {url: url.href, page};
}
function paginationPage(value: string, query: string) {
  const url = new URL(value, origin);
  const route = /^\/search\/([^/]+)(?:\/([1-9]\d{0,3}))?$/.exec(url.pathname);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !route || decodeURIComponent(route[1]) !== query) throw invalid();
  return Number(route[2] ?? 1);
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html), section = div(safe, 'comic-section');
  const heading = one([...section.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)], '搜索标题');
  if (textContent(heading[1]) !== `“${request.query}”搜索结果`) throw invalid();
  const totalText = textContent(div(section, 'page-info')), count = /^共(\d+)部漫画$/.exec(totalText), total = count ? Number(count[1]) : NaN;
  if (!Number.isSafeInteger(total) || total > 300000 || (page > 1 && (page - 1) * 30 >= total)) throw invalid();
  const list = div(section, 'comic-list'), cards = [...list.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi)];
  if (cards.length !== Math.min(30, Math.max(0, total - (page - 1) * 30)) || tags(list, 'div').length !== cards.length ||
      list.replace(/<div\b[^>]*>[\s\S]*?<\/div\s*>/gi, '').trim()) throw invalid();
  const seen = new Set<string>();
  const items = cards.map(card => {
    if (!hasClass(attributes(' ' + card[1]), 'comic-item')) throw invalid();
    const h3 = one([...card[2].matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)], '搜索作品名');
    const anchor = one(tags(h3[1], 'a'), '搜索作品地址'), url = new URL(text(anchor.href), origin), loc = jfLocation(url);
    if (!loc || loc.chapter || seen.has(loc.comic)) throw invalid();
    seen.add(loc.comic);
    const title = text(anchor.title), image = one(tags(card[2], 'img'), '搜索封面');
    const cover = one(tags(card[2], 'a').filter(a => hasClass(a, 'comic-cover')), '搜索封面链接');
    if (new URL(text(cover.href), origin).href !== url.href || image.alt !== title) throw invalid();
    const author = one([...card[2].matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi)]
      .filter(p => hasClass(attributes(' ' + p[1]), 'comic-author')), '作者');
    const name = textContent(author[2]);
    return {catalogId: catalogKey(loc.comic), catalogUrl: catalogUrl(loc.comic), title, cover: coverUrl(image.src),
      ...(name ? {authors: [name]} : {})};
  });
  const pager = div(section, 'pagination'), links = tags(pager, 'a'), current = links.filter(a => hasClass(a, 'on'));
  if (paginationPage(text(one(current, '当前搜索页').href), request.query) !== page) throw invalid();
  const pages = links.map(a => paginationPage(text(a.href), request.query)), next = page * 30 < total;
  if (next !== pages.includes(page + 1) || pages.some(n => n > Math.max(1, Math.ceil(total / 30)))) throw invalid();
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
