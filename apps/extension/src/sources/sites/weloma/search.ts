import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, isOrigin, origin} from './definition';
import {byClass, byId, imageUrl, location, one, regions, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function searchLocation(input: SourceSearchRequest) {
  if (input.siteId !== 'weloma' || !input.query.trim() || [...input.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(input.query)) throw invalid();
  if (input.cursor === undefined) return {page: 1, code: '0OYCn'};
  const match = /^page:([1-9]\d{0,3}):([A-Za-z0-9]{1,64})$/.exec(input.cursor);
  if (!match || Number(match[1]) < 2) throw invalid();
  return {page: Number(match[1]), code: match[2]};
}
export function searchUrl(input: SourceSearchRequest) {
  return `${origin}/l/${searchLocation(input).code}?${new URLSearchParams({name: input.query})}`;
}
export function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
  const {page} = searchLocation(input), safe = inertHtml(html), grid = byId(safe, 'div', 'history');
  const cards = regions(grid, 'div', a => !!hasClass(a, 'thumb-item-flow')), seen = new Set<string>();
  if (cards.length > 100 || !cards.length && textContent(grid)) throw invalid();
  const items = cards.map(card => {
    const name = one(regions(byClass(card.body, 'div', 'series-title'), 'a', () => true), '搜索作品'), loc = location(name.attrs.href);
    if (!loc.work || loc.chapter || seen.has(loc.work)) throw invalid();
    seen.add(loc.work);
    const wrapper = byClass(card.body, 'div', 'thumb-wrapper');
    const poster = one(regions(wrapper, 'a', a => {
      try {return !!location(a.href).work;} catch {return false;}
    }), '搜索封面');
    if (location(poster.attrs.href).work !== loc.work) throw invalid();
    const artwork = one(tags(poster.body, 'div').filter(a => hasClass(a, 'img-in-ratio')), '搜索图片');
    const match = /background-image\s*:\s*url\(\s*(['"])([^'"\r\n]+)\1\s*\)/i.exec(artwork.style ?? '');
    if (!match) throw invalid();
    const cover = imageUrl(match[2]);
    const latest = regions(wrapper, 'div', a => !!hasClass(a, 'chapter-title'));
    return {catalogId: catalogKey(loc.work), catalogUrl: catalogUrl(loc.work), title: text(textContent(name.body)),
      ...(cover === origin + '/app/manga/themes/dark/assets/images/no-cover.png' ? {} : {cover: {url: cover}}),
      ...(latest.length ? {latestLabel: text(textContent(one(latest, '最新章节').body))} : {})};
  });
  const pager = byClass(safe, 'ul', 'pagination'), links = regions(pager, 'a', () => true);
  if (!links.length) {
    if (page !== 1) throw invalid();
    return {items};
  }
  if (textContent(one(links.filter(a => hasClass(a.attrs, 'active')), '当前页').body) !== String(page) || !items.length) throw invalid();
  let nextCursor: string | undefined, maxPage = page;
  for (const link of links) {
    const number = textContent(link.body);
    if (!/^\d+$/.test(number)) continue;
    maxPage = Math.max(maxPage, Number(number));
    if (Number(number) === page) continue;
    const target = new URL(text(link.attrs.href), origin), match = /^\/l\/([A-Za-z0-9]{1,64})$/.exec(target.pathname);
    if (!isOrigin(target) || target.search || target.hash || !match || Number(number) > 9999) throw invalid();
    if (Number(number) === page + 1) {
      if (nextCursor) throw invalid();
      nextCursor = `page:${page + 1}:${match[1]}`;
    }
  }
  if ((maxPage > page) !== !!nextCursor) throw invalid();
  return {items, ...(nextCursor ? {nextCursor} : {})};
}
export async function search(input: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const html = await context.request(searchUrl(input));
  context.signal?.throwIfAborted(); return parseSearch(html, input);
}
