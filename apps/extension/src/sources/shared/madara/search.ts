import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import type {SourceNetworkContext} from '../../contracts/network';
import {hasClass, inertHtml, tags, textContent} from '../html';
import type {MadaraSite} from './config';
import type {madaraHtml} from './html';

/** Verified public HTML pagination and the read-only AJAX content-search protocol. */
export function madaraSearch(site: MadaraSite, helpers: ReturnType<typeof madaraHtml>) {
  const {origin} = site, pageSize = site.searchPageSize ?? 0;
  const {byClass, cover, location, one, regions, text} = helpers;
  const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
  function pageNumber(request: SourceSearchRequest) {
    if (!pageSize) throw invalid();
    if (request.siteId !== site.id || !request.query.trim() || [...request.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(request.query)) throw invalid();
    if (request.cursor !== undefined && !/^page:[1-9]\d{0,3}$/.test(request.cursor)) throw invalid();
    return request.cursor ? Number(request.cursor.slice(5)) : 1;
  }
  function searchUrl(request: SourceSearchRequest) {
    const page = pageNumber(request);
    return origin + (page === 1 ? '/' : `/page/${page}/`) + '?' + new URLSearchParams({s: request.query, post_type: 'wp-manga'});
  }
  function searchRequest(request: SourceSearchRequest): {url: string; options?: Parameters<SourceNetworkContext['request']>[1]} {
    const page = pageNumber(request);
    if (site.search !== 'ajax') return {url: searchUrl(request)};
    return {url: origin + '/wp-admin/admin-ajax.php', options: {
      referer: origin + '/?' + new URLSearchParams({s: request.query, post_type: 'wp-manga'}),
      form: {action: 'madara_load_more', page: String(page - 1), template: 'madara-core/content/content-search',
        'vars[paged]': '1', 'vars[template]': 'search', 'vars[posts_per_page]': String(pageSize),
        'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': request.query},
    }};
  }
  function searchItems(cards: ReturnType<typeof regions>): SourceSearchPage['items'] {
    const seen = new Set<string>();
    return cards.map(card => {
      const link = one(regions(byClass(card.body, 'div', 'post-title'), 'a', () => true), '搜索作品');
      const loc = location(link.attrs.href);
      if (loc.chapter || seen.has(loc.slug)) throw invalid();
      seen.add(loc.slug);
      return {catalogId: site.catalogKey(loc.slug), catalogUrl: site.catalogUrl(loc.slug), title: text(textContent(link.body)),
        cover: cover(byClass(card.body, 'div', 'tab-thumb'), loc.slug)};
    });
  }
  function parseAjax(html: string, page: number): SourceSearchPage {
    // A genuinely empty successful response is the endpoint's no-results sentinel.
    // Do not turn a challenge, PHP error, WordPress "0" or script-only response into an empty result.
    if (!html.trim()) return {items: []};
    const safe = inertHtml(html), blocks = regions(safe, 'div', () => true);
    const terminal = blocks.at(-1);
    const done = !!terminal && hasClass(terminal.attrs, 'no-posts');
    if (done && (terminal!.body.trim() ||
        !/^<div\s+class\s*=\s*(?:"[^"]*"|'[^']*')\s*>$/i.test(safe.slice(terminal!.start, safe.indexOf('>', terminal!.start) + 1)) ||
        terminal!.attrs.class.split(/\s+/).some(name => !['invi', 'no-posts'].includes(name)))) throw invalid();
    const cards = done ? blocks.slice(0, -1) : blocks;
    if ((!cards.length && !done) || cards.length > pageSize ||
        tags(safe, 'div').filter(a => hasClass(a, 'c-tabs-item__content')).length !== cards.length) throw invalid();
    let end = 0;
    for (const block of blocks) {
      if (!(hasClass(block.attrs, 'c-tabs-item__content') || done && block === terminal) || safe.slice(end, block.start).trim()) throw invalid();
      end = block.end;
    }
    if (safe.slice(end).trim()) throw invalid();
    const items = searchItems(cards);
    // Every observed non-empty terminal page has this marker, even a full last page.
    // A short unmarked fragment could be truncated at a card boundary, not the last page.
    if (!done && (items.length !== pageSize || page === 9999)) throw invalid();
    return {items, ...(!done ? {nextCursor: `page:${page + 1}`} : {})};
  }
  function parseSearch(html: string, request: SourceSearchRequest): SourceSearchPage {
    const page = pageNumber(request);
    if (site.search === 'ajax') return parseAjax(html, page);
    const safe = inertHtml(html);
    const query = one(tags(safe, 'input').filter(a => a.name === 's' && hasClass(a, 'search-field')), '搜索条件');
    if (query.value !== request.query) throw invalid();
    const cards = regions(safe, 'div', a => !!hasClass(a, 'c-tabs-item__content'));
    const headings = regions(safe, 'h1', a => !!hasClass(a, 'h4'));
    if (!cards.length && !headings.length && page === 1 &&
        regions(safe, 'p', () => true).some(p => textContent(p.body) === 'No matches found. Try a different search...')) return {items: []};
    const heading = textContent(one(headings, '搜索结果数').body), match = /^(\d+) results? for "([\s\S]*)"$/.exec(heading);
    if (!match || match[2] !== request.query) throw invalid();
    const total = Number(match[1]);
    if (total > 100000 || page > Math.max(1, Math.ceil(total / pageSize)) || cards.length !== Math.min(pageSize, total - (page - 1) * pageSize)) throw invalid();
    const items = searchItems(cards);
    const pagers = regions(safe, 'div', a => !!hasClass(a, 'wp-pagenavi'));
    if (pagers.length > 1 || total > pageSize && pagers.length !== 1) throw invalid();
    let next = false;
    if (pagers.length) {
      if (textContent(byClass(pagers[0].body, 'span', 'current')) !== String(page)) throw invalid();
      const links = tags(pagers[0].body, 'a').filter(a => a.rel === 'next');
      if (links.length > 1) throw invalid();
      if (links.length) {
        const nextUrl = new URL(text(links[0].href), origin);
        if (nextUrl.origin !== origin || nextUrl.username || nextUrl.password || nextUrl.hash || nextUrl.pathname !== `/page/${page + 1}/` ||
            [...nextUrl.searchParams].length !== 2 || nextUrl.searchParams.get('s') !== request.query || nextUrl.searchParams.get('post_type') !== 'wp-manga') throw invalid();
        next = true;
      }
    }
    if (next !== (page * pageSize < total)) throw invalid();
    return {items, ...(next ? {nextCursor: `page:${page + 1}`} : {})};
  }
  return {parseSearch, searchUrl, searchRequest};
}
