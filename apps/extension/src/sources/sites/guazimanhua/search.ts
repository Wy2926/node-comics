import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, guaziLocation, origin} from './definition';
import {object, one, structuredData, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'guazimanhua') throw invalid();
  const page = request.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  const url = new URL('/category.php', origin);
  url.searchParams.set('keyword', request.query);
  if (page > 1) url.searchParams.set('page', String(page));
  return {url: url.href, page};
}
export function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(request), safe = inertHtml(html);
  const collection = one(structuredData(html).filter(row => row['@type'] === 'CollectionPage'), '搜索数据');
  // The source's CollectionPage.url intentionally omits the query; its name echoes it.
  if (collection.name !== '搜索：' + request.query + '漫画') throw invalid();
  const list = object(collection.mainEntity);
  if (list['@type'] !== 'ItemList' || !Array.isArray(list.itemListElement) || list.numberOfItems !== list.itemListElement.length || list.itemListElement.length > 50) throw invalid();
  const entries = list.itemListElement;
  const cards = [...safe.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article\s*>/gi)].filter(m => hasClass(attributes(' ' + m[1]), 'card'));
  if (cards.length !== list.itemListElement.length || !cards.length && !tags(safe, 'div').some(a => hasClass(a, 'empty'))) throw invalid();
  const seen = new Set<string>();
  const items = cards.map((card, index) => {
    const entry = object(entries[index]), heading = one([...card[2].matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)], '搜索标题');
    const anchor = one([...heading[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)], '搜索链接');
    const url = new URL(text(attributes(' ' + anchor[1]).href), origin), loc = guaziLocation(url), title = text(textContent(anchor[2]));
    if (!loc?.comicId || loc.chapterId || seen.has(loc.comicId) || entry['@type'] !== 'ListItem' || entry.position !== index + 1 || entry.url !== url.href || entry.name !== title) throw invalid();
    seen.add(loc.comicId);
    const image = one(tags(card[2], 'img').filter(a => hasClass(a, 'cover')), '搜索封面');
    const meta = [...card[2].matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi)].find(m => hasClass(attributes(' ' + m[1]), 'meta'));
    const author = meta ? textContent(meta[2]).split(' · ')[0].trim() : '';
    return {catalogId: 'guazimanhua:' + loc.comicId, catalogUrl: catalogUrl(loc.comicId), title,
      ...(author ? {authors: [author]} : {}), cover: sourceCover(image.src, origin)};
  });
  const pager = one([...safe.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav\s*>/gi)].filter(m => hasClass(attributes(' ' + m[1]), 'pager')), '搜索分页');
  let next = false, current = false;
  for (const link of tags(pager[2], 'a')) {
    const url = new URL(text(link.href), origin), targetPage = Number(url.searchParams.get('page') ?? '1');
    if (url.origin !== origin || url.pathname !== '/category.php' || url.searchParams.get('keyword') !== request.query ||
        !Number.isSafeInteger(targetPage) || targetPage < 1 || [...url.searchParams.keys()].some(key => key !== 'keyword' && key !== 'page')) throw invalid();
    if (hasClass(link, 'on')) {if (targetPage !== page || current) throw invalid(); current = true;}
    if (targetPage === page + 1) next = true;
  }
  if (items.length && !current || !items.length && next) throw invalid();
  return {items, ...(next ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(html, request);
}
