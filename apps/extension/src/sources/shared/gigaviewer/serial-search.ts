import type {SourceSearchRequest, SourceSearchPage} from '../../contracts/search';
import type {SourceNetworkContext} from '../../contracts/network';
import {attributes, hasClass, inertHtml, tags, textContent} from '../html';
import {protocolChanged as changed} from './pages';
import {count, json, object, request, text, type GigaViewerSerialProtocol} from './serial-protocol';

// Both templates are verified GigaViewer search pages. Site identity remains explicit.
export type GigaViewerSearchMarkup = string | {mediaName: string};
const componentClass = (attrs: Record<string, string>, name: string) =>
  attrs.class?.split(/\s+/).some(value => value.startsWith(name + '__') && value.length > name.length + 2);

export function gigaViewerSerialSearch(protocol: GigaViewerSerialProtocol, markup: GigaViewerSearchMarkup, mixedProducts = false) {
  const {sourceId, origin, catalogUrl, seriesKey, location, coverUrl} = protocol;
  const ssr = typeof markup !== 'string';
  const matches = (attrs: Record<string, string>, legacy: string, component: string) =>
    ssr ? componentClass(attrs, component) : hasClass(attrs, legacy);
  async function parseSearch(raw: string, query: SourceSearchRequest): Promise<SourceSearchPage> {
    if (query.siteId !== sourceId || !query.query.trim()) throw changed();
    const html = inertHtml(raw);
    const root = tags(html, 'html');
    if (root.length !== 1 || (ssr ? root[0]['data-media-name'] !== markup.mediaName : root[0]['data-route'] !== markup) ||
        tags(html, 'input').find(attrs => attrs.name === 'q')?.value !== query.query) throw changed();
    const lists = [...html.matchAll(/(<ul\b[^>]*>)([\s\S]*?)<\/ul\s*>/gi)]
      .filter(match => matches(attributes(match[1]), mixedProducts ? 'search-series-list' : 'series-list', 'SearchResult_search_result_list') ||
        !ssr && hasClass(attributes(match[1]), 'list-empty'));
    if (lists.length !== 1) throw changed();
    const rows = [...lists[0][2].matchAll(/(<li\b[^>]*>)([\s\S]*?)<\/li\s*>/gi)];
    const empty = ssr ? rows.length === 1 && componentClass(attributes(rows[0][1]), 'SearchResult_list_empty_li') :
      hasClass(attributes(lists[0][1]), 'list-empty');
    if (empty && ssr && (tags(rows[0][2], 'a').length || tags(rows[0][2], 'img').length)) throw changed();
    const seen = new Set<string>();
    if (!empty && !rows.length || rows.length > 5000) throw changed();
    const hits = empty ? [] : rows.flatMap(match => {
      const attrs = attributes(match[1]), body = match[2];
      const paragraphs = [...body.matchAll(/(<p\b[^>]*>)([\s\S]*?)<\/p\s*>/gi)];
      const titles = paragraphs.filter(row => componentClass(attributes(row[1]), 'SearchResultItem_series_title'));
      if (ssr && (!componentClass(attrs, 'SearchResultItem_li') || titles.length !== 1)) throw changed();
      const title = text(ssr ? textContent(titles[0][2]) : attrs['data-title'], 1024);
      const links = tags(body, 'a').filter(link => matches(link, 'main-link', 'SearchResultItem_main_link')), images = tags(body, 'img');
      if (links.length !== 1 || images.length !== 1) throw changed();
      const target = new URL(links[0].href);
      if (ssr) {
        const previews = [...body.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/gi)].filter(row => tags(row[2], 'img').length);
        if (previews.length !== 1 || new URL(attributes(previews[0][1]).href).href !== target.href) throw changed();
      }
      // Mixed source search explicitly includes purchased books/magazines, outside our episode scope.
      if (mixedProducts && target.origin === origin && !target.username && !target.password &&
          /^\/(volume|magazine)\/[1-9]\d{0,24}\/?$/.test(target.pathname)) return [];
      if (location(target.href).catalog) throw changed();
      const cover = coverUrl(images[0].src), key = seriesKey(cover.series);
      if (seen.has(key)) throw changed(); seen.add(key);
      const authors = paragraphs.filter(row => matches(attributes(row[1]), 'author', 'SearchResultItem_author'))
        .map(row => textContent(row[2])).filter(Boolean);
      return [{catalogId: key, catalogUrl: catalogUrl(cover.series), title, cover: {url: cover.url},
        ...(authors.length ? {authors} : {})}];
    });
    // The source returns all hits. Bound UI pages and bind cursors to the observed result set.
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(hits)));
    const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    let offset = 0;
    if (query.cursor !== undefined) {
      const cursor = object(json(query.cursor));
      offset = count(cursor.offset, 5000);
      if (cursor.query !== query.query || cursor.fingerprint !== fingerprint || !offset || offset % 50 || offset >= hits.length) throw changed();
    }
    return {items: hits.slice(offset, offset + 50), ...(offset + 50 < hits.length ?
      {nextCursor: JSON.stringify({query: query.query, offset: offset + 50, fingerprint})} : {})};
  }
  async function search(query: SourceSearchRequest, context: SourceNetworkContext) {
    if (query.siteId !== sourceId || !query.query.trim()) throw changed();
    return parseSearch(await request(context, origin + '/search?' + new URLSearchParams({q: query.query}),
      {referer: origin + '/search', acceptStatuses: [404]}), query);
  }
  return {parseSearch, search};
}
