import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, origin} from './definition';
import {blocks, coverUrl, label, location, one, text} from './html';

const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
function validate(query: SourceSearchRequest) {
  if (query.siteId !== 'baozimh' || !query.query.trim()) throw invalid();
}
export async function parseSearch(raw: string, query: SourceSearchRequest): Promise<SourceSearchPage> {
  validate(query);
  const html = inertHtml(raw);
  if (one(tags(html, 'input').filter(a => a.name === 'q')).value !== query.query) throw invalid();
  const hint = textContent(one(blocks(html, 'div', 'class', 'keyword-hinter')));
  const count = /相近搜索结果\((\d+)\)$/.exec(hint)?.[1];
  const list = one(blocks(html, 'div', 'class', 'classify-items'));
  const cards = blocks(list, 'div', 'class', 'comics-card');
  if (count === undefined || Number(count) !== cards.length || cards.length > 5000) throw invalid();
  const seen = new Set<string>();
  const hits = cards.map(card => {
    const info = one([...card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].filter(m => hasClass(attributes(' ' + m[1]), 'comics-card__info')));
    const attrs = attributes(' ' + info[1]), loc = location(new URL(text(attrs.href), origin).href);
    if (loc.chapter !== undefined || seen.has(loc.comic)) throw invalid();
    seen.add(loc.comic);
    const author = blocks(info[2], 'small', 'class', 'tags').map(textContent).filter(Boolean);
    const poster = one(blocks(card, 'a', 'class', 'comics-card__poster'));
    const cover = coverUrl(tags(poster, 'amp-img')[0]?.src, loc.comic);
    return {catalogId: catalogKey(loc.comic), catalogUrl: catalogUrl(loc.comic), title: label(info[2], 'h3', 'text-truncate'),
      ...(cover ? {cover} : {}), ...(author.length ? {authors: author} : {})};
  });
  // One server response contains every match; bounded pages remain tied to that exact result.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([query.query, hits])));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  if (query.cursor !== undefined) {
    const match = /^([1-9]\d{0,3}):([a-f0-9]{64})$/.exec(query.cursor);
    if (!match || match[2] !== fingerprint) throw new SourceSearchError('SOURCE_SEARCH_CURSOR_EXPIRED');
    offset = Number(match[1]);
    if (offset % 50 || offset >= hits.length) throw invalid();
  }
  return {items: hits.slice(offset, offset + 50), ...(offset + 50 < hits.length ? {nextCursor: `${offset + 50}:${fingerprint}`} : {})};
}
export async function search(query: SourceSearchRequest, context: SourceNetworkContext) {
  validate(query); context.signal?.throwIfAborted();
  const raw = await context.request(origin + '/search?' + new URLSearchParams({q: query.query}));
  context.signal?.throwIfAborted();
  return parseSearch(raw, query);
}
