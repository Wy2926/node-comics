import type {SourceSearchRequest, SourceSearchPage} from '../../contracts/search';
import type {SourceNetworkContext} from '../../contracts/network';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogUrl, origin, seriesKey} from './definition';
import {changed, count, coverUrl, json, location, object, request, text} from './protocol';

export async function parseSearch(raw: string, query: SourceSearchRequest): Promise<SourceSearchPage> {
  if (query.siteId !== 'comicdays' || !query.query.trim()) throw changed();
  const html = inertHtml(raw);
  if (tags(html, 'html')[0]?.['data-route'] !== 'common:search_result' ||
      tags(html, 'input').find(attrs => attrs.name === 'q')?.value !== query.query) throw changed();
  const lists = [...html.matchAll(/(<ul\b[^>]*>)([\s\S]*?)<\/ul\s*>/gi)]
    .filter(match => hasClass(attributes(match[1]), 'series-list') || hasClass(attributes(match[1]), 'list-empty'));
  if (lists.length !== 1) throw changed();
  const empty = hasClass(attributes(lists[0][1]), 'list-empty'), seen = new Set<string>();
  const hits = empty ? [] : [...lists[0][2].matchAll(/(<li\b[^>]*>)([\s\S]*?)<\/li\s*>/gi)].map(match => {
    const attrs = attributes(match[1]), body = match[2], title = text(attrs['data-title'], 1024);
    const links = tags(body, 'a').filter(link => hasClass(link, 'main-link')), images = tags(body, 'img');
    if (links.length !== 1 || images.length !== 1 || location(links[0].href).catalog) throw changed();
    const cover = coverUrl(images[0].src), key = seriesKey(cover.series);
    if (seen.has(key)) throw changed(); seen.add(key);
    const authors = [...body.matchAll(/(<p\b[^>]*>)([\s\S]*?)<\/p\s*>/gi)]
      .filter(row => hasClass(attributes(row[1]), 'author')).map(row => textContent(row[2])).filter(Boolean);
    return {catalogId: key, catalogUrl: catalogUrl(cover.series), title, cover: {url: cover.url},
      ...(authors.length ? {authors} : {})};
  });
  if (!empty && !hits.length || hits.length > 5000) throw changed();
  // The source has no result pagination. Bound UI pages and reject cursors if its results change.
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
export async function search(query: SourceSearchRequest, context: SourceNetworkContext) {
  if (query.siteId !== 'comicdays' || !query.query.trim()) throw changed();
  return parseSearch(await request(context, origin + '/search?' + new URLSearchParams({q: query.query}),
    {referer: origin + '/search', acceptStatuses: [404]}), query);
}
