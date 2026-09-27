import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceEntry, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {languages, location} from './definition';
import {block, imageUrl, label, meta, ownership, requireLocation, unavailable} from './html';
import {search} from './search';

async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = inertHtml(await context.request(url));
  context.signal?.throwIfAborted();
  return html;
}
export function parseCatalog(html: string, url: string, page: number) {
  const safe = inertHtml(html), loc = ownership(safe, url);
  if (loc.episode) throw unavailable();
  const list = block(safe, 'ul', 'id', '_listUl'), paging = block(safe, 'div', 'class', 'paginate');
  const current = [...paging.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(m => attributes(' ' + m[1])['aria-current'] === 'true');
  if (current.length !== 1 || Number(textContent(current[0][2])) !== page) throw unavailable();
  const rows = [...list.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
  if (!rows.length || rows.length > 100) throw unavailable();
  const entries = rows.map(([_, opening, body]): SourceEntry => {
    const attrs = attributes(' ' + opening), links = tags(body, 'a').filter(a => a.href && location(new URL(a.href, url))?.episode);
    if (!hasClass(attrs, '_episodeItem') || links.length !== 1) throw unavailable();
    const target = new URL(links[0].href, url).href, entry = requireLocation(target), title = label(body, 'subj');
    if (entry.key !== loc.key || entry.episode !== attrs['data-episode-no'] || !title) throw unavailable();
    return {id: loc.key + ':episode:' + entry.episode, catalogId: loc.key, remoteId: entry.episode,
      url: target, title, order: 0, groupIds: ['episodes'], rawTypes: [], related: false,
      sequenceId: loc.key, contentLanguage: languages[loc.language]};
  });
  const pages = tags(paging, 'a').flatMap(a => {
    if (!a.href || a.href === '#') return [];
    const target = new URL(a.href, url), found = location(target), n = Number(target.searchParams.get('page'));
    if (!found || found.key !== loc.key || found.episode || !Number.isSafeInteger(n) || n < 1 || n > 1000) throw unavailable();
    return [n];
  });
  if (pages.some(n => n > page) && !pages.includes(page + 1)) throw unavailable();
  const title = meta(safe, 'og:title');
  if (!title?.trim()) throw unavailable();
  return {entries, title, cover: meta(safe, 'og:image'), next: pages.includes(page + 1)};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const safe = inertHtml(html), loc = ownership(safe, url);
  if (!loc.episode) throw unavailable();
  const viewer = block(safe, 'div', 'id', '_imageList'), images = tags(viewer, 'img');
  if (!images.length || images.length > 1500 || images.some(a => !hasClass(a, '_images'))) throw unavailable();
  const items = images.map((a, order) => {
    const width = Number(a.width), height = Number(a.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw unavailable();
    return {id: 'page-' + order, order, width, height, resource: {kind: 'http' as const, url: imageUrl(a['data-url'])}};
  });
  return {url, adapter: 'webtoons', title: meta(safe, 'og:title') || loc.key, direction: 'ltr',
    discoveryComplete: true, knownTotal: items.length, note: '', items};
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = requireLocation(url);
    if (loc.episode) throw unavailable();
    const entries: SourceEntry[] = [], seen = new Set<string>();
    const first = parseCatalog(await request(loc.catalogUrl, context), loc.catalogUrl, 1);
    let current = first, page = 1;
    while (true) {
      for (const entry of current.entries) {
        if (seen.has(entry.id) || entries.length && Number(entries.at(-1)!.remoteId) <= Number(entry.remoteId)) throw unavailable();
        seen.add(entry.id); entries.push(entry);
      }
      if (!current.next) break;
      if (++page > 1000 || entries.length > 10000) throw unavailable();
      current = parseCatalog(await request(loc.catalogUrl + '&page=' + page, context), loc.catalogUrl, page);
    }
    if (page > 1) {
      const head = parseCatalog(await request(loc.catalogUrl, context), loc.catalogUrl, 1);
      if (head.next !== first.next || head.entries.map(e => e.id).join() !== first.entries.map(e => e.id).join()) throw unavailable();
    }
    entries.reverse().forEach((entry, order) => {entry.order = order;});
    return {id: loc.key, sourceId: 'webtoons', url: loc.catalogUrl, title: first.title, observedAt: Date.now(), complete: true,
      cover: first.cover ? {url: imageUrl(first.cover)} : undefined,
      note: '网站公开目录；登录、付费、年龄验证与 App 专属内容以源站实际开放范围为准。',
      groups: [{id: 'episodes', title: 'Episodes', entryIds: entries.map(e => e.id), complete: true}], entries, defaultEntryId: entries[0]?.id};
  },
  async pages(url, context) {requireLocation(url); return parsePages(await request(url, context), url);},
} satisfies SourceNetwork;
