import type {SourceSearchPage, SourceSearchRequest} from '../../contracts/search';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin} from './definition';
import {artwork, byClass, location, one, regions, text} from './html';

export function searchRequest(input: SourceSearchRequest) {
  const query = text(input.query), page = input.cursor === undefined ? 1 : Number(input.cursor);
  if (input.siteId !== 'goodtoon' || query.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      input.cursor !== undefined && String(page) !== input.cursor) throw Error('GoodToon 搜索参数无效。');
  const url = new URL(origin + '/'); url.searchParams.set('q', query);
  if (page > 1) url.searchParams.set('pg', String(page));
  return {url: url.href, query, page};
}
export function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
  const {query, page} = searchRequest(input), safe = inertHtml(html), grid = byClass(safe, 'div', 'card-grid');
  const cards = regions(grid, 'a', a => !!hasClass(a, 'card'));
  if (cards.length > 63 || tags(grid, 'a').length !== cards.length ||
      /<(?:button|form|nav|select|iframe)\b/i.test(grid) || !cards.length && grid.trim())
    throw Error('GoodToon 搜索列表不完整或结构已变化。');
  const seen = new Set<string>();
  const items = cards.map(card => {
    const owner = location(card.attrs.href);
    if (owner.chapter || seen.has(owner.slug)) throw Error('GoodToon 搜索作品重复或归属错误。');
    seen.add(owner.slug);
    const title = text(textContent(byClass(card.body, 'div', 'subject')));
    const cover = one(tags(byClass(card.body, 'div', 'thumb'), 'img').filter(a => !hasClass(a, 'platform-icon')), '搜索封面');
    return {catalogId: catalogKey(owner.slug), catalogUrl: catalogUrl(owner.slug), title,
      cover: artwork(cover['data-src'] || cover.src, owner.slug)};
  });
  const pagers = regions(safe, 'div', a => !!hasClass(a, 'pagination'));
  if (!pagers.length) {
    if (page !== 1 || cards.length === 63) throw Error('GoodToon 搜索分页缺失。');
    return {items};
  }
  const pager = one(pagers, '搜索分页').body, links = regions(pager, 'a', () => true);
  if (!cards.length || !links.length || tags(pager, 'a').length !== links.length || /<(?:button|form|select)\b/i.test(pager))
    throw Error('GoodToon 搜索分页无效。');
  let current = 0, next = 0;
  for (const link of links) {
    const target = new URL(text(link.attrs.href), origin), n = Number(target.searchParams.get('pg')), label = textContent(link.body);
    if (target.origin !== origin || target.username || target.password || target.pathname !== '/' || target.hash ||
        [...target.searchParams].length !== 2 || target.searchParams.get('q') !== query ||
        !Number.isSafeInteger(n) || n < 1 || n > 1000 || String(n) !== target.searchParams.get('pg') || !hasClass(link.attrs, 'page-numbers'))
      throw Error('GoodToon 搜索分页归属错误。');
    if (hasClass(link.attrs, 'current')) {
      if (n !== page || label !== String(page)) throw Error('GoodToon 当前搜索页错误。');
      current++;
    } else if (label.startsWith('다음')) {
      if (n !== page + 1) throw Error('GoodToon 下一页不连续。');
      next++;
    } else if (label.endsWith('이전')) {
      if (n !== page - 1) throw Error('GoodToon 上一页不连续。');
    } else if (label !== String(n)) throw Error('GoodToon 搜索分页标记无效。');
  }
  if (current !== 1 || next > 1 || next && cards.length !== 63 || !next && links.some(link => Number(new URL(link.attrs.href, origin).searchParams.get('pg')) > page))
    throw Error('GoodToon 搜索分页不完整。');
  return {items, ...(next ? {nextCursor: String(page + 1)} : {})};
}
