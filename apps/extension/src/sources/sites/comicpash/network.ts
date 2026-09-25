import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceEntry, SourceSnapshot} from '../../contracts/source';
import {catalogUrl, comicpashLocation, episodeUrl, origin} from './definition';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {parseProcessing} from './images';
import {sourceCover} from '../../shared/cover';

const changed = () => Error('Comic PASH 目录或阅读协议已变化，请回源确认后重试。');
function location(url: string) {
  const loc = comicpashLocation(new URL(url));
  if (!loc) throw changed();
  return loc;
}
function canonical(html: string, url: string) {
  const links = tags(html, 'link').filter(attrs => attrs.rel === 'canonical');
  if (links.length !== 1 || !links[0].href) throw changed();
  const requested = location(url), actual = location(new URL(links[0].href, origin).href);
  if (actual.episodeId !== requested.episodeId || !requested.episodeId && actual.seriesId !== requested.seriesId) throw changed();
}
export function parseCatalogPage(raw: string, url: string) {
  const html = inertHtml(raw), loc = location(url);
  if (!loc.seriesId || loc.episodeId) throw changed();
  canonical(html, url);
  const title = tags(html, 'meta').find(attrs => attrs.property === 'og:title')?.content?.trim();
  if (!title || title.length > 2048) throw changed();
  const links = [...html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/gi)]
    .map(match => ({attrs: attributes(match[1]), body: match[2]}));
  const ranges = links.filter(({attrs, body}) => hasClass(attrs, 'series-sort-link') && /^\d+-\d+$/.test(textContent(body)))
    .map(({attrs, body}) => {
      const target = new URL(attrs.href, origin), targetLoc = location(target.href);
      const [start, end] = textContent(body).split('-').map(Number);
      if (targetLoc.seriesId !== loc.seriesId || targetLoc.episodeId || target.search || target.hash ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 10000) throw changed();
      return {start, end, url: target.href};
    }).sort((a, b) => a.start - b.start).map((range, index) => {
      // The selected range links back to the bare series URL even on page 2+.
      // Other ranges expose numbered paths. Normalize to the verified numbered form.
      const suffix = new URL(range.url).pathname.slice(`/series/${loc.seriesId}`.length);
      if (suffix && suffix !== '/' && suffix !== '/' + (index + 1)) throw changed();
      return {...range, url: catalogUrl(loc.seriesId!) + '/' + (index + 1)};
    });
  if (!ranges.length || ranges.length > 500 || ranges.some((r, i) => r.start !== (i ? ranges[i - 1].end + 1 : 1)) ||
    new Set(ranges.map(r => r.url)).size !== ranges.length) throw changed();
  const entries = links.filter(({attrs}) => hasClass(attrs, 'series-eplist-item-link')).map(({attrs, body}) => {
    const target = location(new URL(attrs.href, origin).href);
    const headings = [...body.matchAll(/(<span\b[^>]*>)([\s\S]*?)<\/span\s*>/gi)]
      .filter(match => hasClass(attributes(match[1]), 'series-eplist-item-h-text'));
    const title = headings.length === 1 && textContent(headings[0][2]);
    if (!target.episodeId || !title || title.length > 2048) throw changed();
    return {remoteId: target.episodeId, title};
  });
  if (!entries.length || new Set(entries.map(e => e.remoteId)).size !== entries.length) throw changed();
  const cover = sourceCover(tags(html, 'img').find(attrs => hasClass(attrs, 'series-h-img'))?.src, url)
    ?? sourceCover(tags(html, 'meta').find(attrs => attrs.property === 'og:image')?.content, url);
  return {title, cover, ranges, entries};
}
async function request(context: SourceNetworkContext, url: string) {
  context.signal?.throwIfAborted();
  const value = await context.request(url);
  context.signal?.throwIfAborted();
  return value;
}
export function parseReader(raw: string, url: string) {
  const html = inertHtml(raw), loc = location(url);
  if (!loc.episodeId) throw changed();
  canonical(html, url);
  const viewers = tags(html, 'div').filter(attrs => attrs.id === 'comici-viewer');
  const viewer = viewers[0];
  if (viewers.length !== 1 || !/^[a-f\d]{32}$/.test(viewer['data-comici-viewer-id'] ?? '') ||
    !/^[a-zA-Z0-9]+$/.test(viewer['data-series-id'] ?? ''))
    throw Error('Comic PASH 未提供可读取的正文，请在源站确认登录、免费范围或购买状态。');
  if (viewer['data-api-domain'] !== '/api' || loc.seriesId && loc.seriesId !== viewer['data-series-id']) throw changed();
  return {viewerId: viewer['data-comici-viewer-id'], seriesId:viewer['data-series-id'],
    title: tags(html, 'meta').find(attrs => attrs.property === 'og:title')?.content?.slice(0, 2048) || `Comic PASH ${loc.episodeId}`};
}
type Contents = {totalPages: number; scrollDirection: string; result: Array<{sort: number; width: number; height: number; scramble: string; imageUrl: string}>};
export function parseContents(raw: string, viewerId: string) {
  let body: Contents;
  try { body = JSON.parse(raw); } catch { throw changed(); }
  if (!body || !Number.isInteger(body.totalPages) || body.totalPages < 1 || body.totalPages > 1500 ||
    !['横', '縦'].includes(body.scrollDirection) || !Array.isArray(body.result) || !body.result.length || body.result.length > body.totalPages) throw changed();
  const items = body.result.map(row => {
    if (!row || !Number.isInteger(row.sort) || row.sort < 0 || row.sort >= body.totalPages ||
      !Number.isInteger(row.width) || !Number.isInteger(row.height) || typeof row.scramble !== 'string') throw changed();
    let order: unknown;
    try { order = JSON.parse(row.scramble); } catch { throw changed(); }
    if (!Array.isArray(order) || order.some(n => typeof n !== 'number')) throw changed();
    const processing = `comici-v1:${row.width}:${row.height}:${order.join(',')}`;
    parseProcessing(processing);
    const image = new URL(row.imageUrl);
    if (image.protocol !== 'https:' || image.hostname !== 'viewer.comicpash.jp' || image.port || image.username || image.password ||
      !image.pathname.startsWith(`/book/${viewerId}/`) || image.pathname.endsWith('/')) throw changed();
    return {id: 'page-' + row.sort, order: row.sort, width: row.width, height: row.height,
      resource: {kind: 'http' as const, url: image.href, processing}};
  }).sort((a, b) => a.order - b.order);
  if (new Set(items.map(item => item.order)).size !== items.length) throw changed();
  return {total: body.totalPages, direction: body.scrollDirection === '縦' ? 'ltr' as const : 'rtl' as const, items};
}
export const network = {
  async resolveCatalog(url,context){
    const loc=location(url);
    if(!loc.episodeId)throw changed();
    return catalogUrl(parseReader(await request(context,episodeUrl(loc.episodeId)),url).seriesId);
  },
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.seriesId || loc.episodeId) throw changed();
    const firstUrl = catalogUrl(loc.seriesId) + '/1';
    const first = parseCatalogPage(await request(context, firstUrl), firstUrl);
    const id = 'comicpash:series:' + loc.seriesId, entries: SourceEntry[] = [], seen = new Set<string>();
    for (const [index, range] of first.ranges.entries()) {
      const page = index === 0 ? first : parseCatalogPage(await request(context, range.url), range.url);
      if (JSON.stringify(page.ranges) !== JSON.stringify(first.ranges) || page.entries.length !== range.end - range.start + 1) throw changed();
      for (const row of page.entries) {
        if (seen.has(row.remoteId)) throw changed();
        seen.add(row.remoteId);
        entries.push({id: 'comicpash:episode:' + row.remoteId, catalogId: id, remoteId: row.remoteId,
          url: episodeUrl(row.remoteId, loc.seriesId), title: row.title, groupIds: [], rawTypes: [],
          order: entries.length, related: false, sequenceId: id});
      }
    }
    if (first.ranges.length > 1) {
      const check = parseCatalogPage(await request(context, firstUrl), firstUrl);
      if (JSON.stringify(check) !== JSON.stringify(first)) throw changed();
    }
    return {id, sourceId: 'comicpash', url: catalogUrl(loc.seriesId), title: first.title, observedAt: Date.now(),
      cover: first.cover,
      complete: true, groups: [], entries, defaultEntryId: entries[0]?.id,
      note: '已读取网站公开目录；需要登录、等待或购买的章节仍受源站访问限制。'};
  },
  async pages(url, context): Promise<SourceSnapshot> {
    const loc = location(url);
    if (!loc.episodeId) throw changed();
    const reader = parseReader(await request(context, episodeUrl(loc.episodeId)), url);
    const endpoint = `${origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${reader.viewerId}&page-from=0&page-to=`;
    const first = parseContents(await request(context, endpoint + '0'), reader.viewerId);
    const full = first.total === 1 ? first : parseContents(await request(context, endpoint + (first.total - 1)), reader.viewerId);
    if (full.total !== first.total || full.direction !== first.direction || full.items.length !== full.total ||
      full.items.some((item, i) => item.order !== i)) throw changed();
    return {url, adapter: 'comicpash', title: reader.title, direction: full.direction, discoveryComplete: true,
      knownTotal: full.total, note: '', items: full.items};
  },
} satisfies SourceNetwork;
