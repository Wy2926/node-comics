import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchRequest, type SourceSearchPage} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {sourceCover} from '../../shared/cover';
import {catalogKey, catalogUrl, origin} from './definition';
import {location, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(input: SourceSearchRequest) {
  if (input.siteId !== 'batcave' || !input.query.trim() || [...input.query].length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(input.query)) throw invalid();
  const page = input.cursor === undefined ? 1 : /^page:[1-9]\d{0,3}$/.test(input.cursor) ? Number(input.cursor.slice(5)) : NaN;
  if (!Number.isSafeInteger(page)) throw invalid();
  return {url: `${origin}/search/${encodeURIComponent(input.query)}${page > 1 ? '/page/' + page + '/' : ''}`, page};
}
export function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
  const {page} = searchUrl(input), main = regions(inertHtml(html), 'main', () => true)[0]?.body;
  if (main === undefined) throw invalid();
  const rows = regions(main, 'div', a => !!hasClass(a, 'readed'));
  if (!rows.length && !tags(main, 'input').some(a => a.id === 'searchinput' || a.name === 'story')) throw invalid();
  const seen = new Set<string>();
  const items = rows.flatMap(row => {
    try {
      const heading = regions(row.body, 'h2', () => true)[0]?.body ?? '';
      const loc = location(text(tags(heading, 'a')[0]?.href)), title = text(textContent(heading));
      if (loc.chapter || seen.has(loc.work)) return [];
      const image = tags(row.body, 'img')[0];
      const cover = sourceCover(image?.['data-src'] || image?.src, origin);
      seen.add(loc.work);
      return [{catalogId: catalogKey(loc.work), catalogUrl: catalogUrl(loc), title, cover}];
    } catch {return [];}
  });
  if (rows.length && !items.length) throw invalid();
  const next = page < 9999 ? searchUrl({...input, cursor: 'page:' + (page + 1)}).url.replace(/\/$/, '') : undefined;
  const hasNext = tags(main, 'a').some(a => {
    try {return new URL(a.href, origin).href.replace(/\/$/, '') === next;} catch {return false;}
  });
  return {items, ...(hasNext ? {nextCursor: 'page:' + (page + 1)} : {})};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  const {url} = searchUrl(input);
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return parseSearch(html, input);
}
