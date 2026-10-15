import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {hasClass, tags, textContent} from '../html';
import type {MangaThemesiaSite} from './config';
import type {mangaThemesiaHtml} from './html';

/** Public, query-bound WordPress name search; one result page per request. */
export function mangaThemesiaSearch(site: MangaThemesiaSite, helpers: ReturnType<typeof mangaThemesiaHtml>,
  document: (html: string) => {safe: string; main: string}) {
  const {one, text, location, regions, byClass, image} = helpers;
  const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
  function pageNumber(input: SourceSearchRequest) {
    if (input.siteId !== site.id || !input.query.trim() || [...input.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(input.query) ||
      input.cursor !== undefined && !/^page:[1-9]\d{0,3}$/.test(input.cursor)) throw invalid();
    return input.cursor ? Number(input.cursor.slice(5)) : 1;
  }
  function searchUrl(input: SourceSearchRequest) {return site.searchUrl(input.query, pageNumber(input));}
  function parseSearch(html: string, input: SourceSearchRequest): SourceSearchPage {
    const page = pageNumber(input), {main} = document(html);
    const box = byClass(main, 'div', 'bixbox');
    const heading = textContent(one(regions(byClass(box, 'div', 'releases'), 'h1', () => true), '搜索标题').body);
    if (!heading.endsWith(` '${input.query.replace(/\s+/g, ' ').trim()}'`)) throw invalid();
    const list = byClass(box, 'div', 'listupd'), cards = regions(list, 'div', a => !!hasClass(a, 'bsx'));
    const pagers = regions(box, 'div', a => !!hasClass(a, 'pagination'));
    if (pagers.length > 1 || cards.length > 100 || tags(list, 'div').filter(a => hasClass(a, 'bs')).length !== cards.length) throw invalid();
    if (!cards.length) {
      // Explicit empty markup, not a challenge/error/partial response or an empty container.
      const empty = /^\s*<center>\s*<h3>([^<]*)<\/h3>\s*<\/center>\s*$/i.exec(list);
      if (page !== 1 || pagers.length || !empty || textContent(empty[1]) !== site.emptySearchText) throw invalid();
      return {items: []};
    }
    const seen = new Set<string>();
    const items = cards.map(card => {
      const link = one(regions(card.body, 'a', () => true), '搜索作品'), loc = location(link.attrs.href);
      if (!loc.catalogSlug || loc.chapterSlug || seen.has(loc.catalogSlug)) throw invalid();
      seen.add(loc.catalogSlug);
      const title = text(textContent(byClass(link.body, 'div', 'tt')));
      if (text(link.attrs.title) !== title) throw invalid();
      return {catalogId: site.catalogKey(loc.catalogSlug), catalogUrl: site.catalogUrl(loc.catalogSlug), title,
        cover: {url: image(link.body)}};
    });
    const pager = one(pagers, '搜索分页').body;
    const current = regions(pager, 'span', a => !!hasClass(a, 'current'));
    const links = tags(pager, 'a'), next = links.filter(a => hasClass(a, 'next'));
    if (current.length ? current.length !== 1 || textContent(current[0].body) !== String(page) : page !== 1 || links.length) throw invalid();
    if (next.length > 1 || next.length && page === 9999) throw invalid();
    for (const link of links) {
      const target = new URL(text(link.href), site.origin), expected = new URL(site.searchUrl(input.query, 1));
      if (target.origin !== expected.origin || target.username || target.password || target.hash ||
        target.searchParams.size !== expected.searchParams.size ||
        [...target.searchParams].some(([key, value]) => value !== expected.searchParams.get(key))) throw invalid();
      const match = /^\/page\/([1-9]\d{0,3})\/$/.exec(target.pathname);
      const number = target.pathname === '/' ? 1 : match ? Number(match[1]) : 0;
      const requested = new URL(site.searchUrl(input.query, number));
      if (!number || target.origin + target.pathname !== requested.origin + requested.pathname ||
        hasClass(link, 'next') && number !== page + 1 || hasClass(link, 'prev') && number !== page - 1) throw invalid();
      // Numbered navigation is evidence of additional pages even if a next link goes missing.
      if (number > page && !next.length) throw invalid();
    }
    return {items, ...(next.length ? {nextCursor: `page:${page + 1}`} : {})};
  }
  return {parseSearch, searchUrl};
}
