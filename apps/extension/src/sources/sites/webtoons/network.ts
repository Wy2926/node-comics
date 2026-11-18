import type {SourceNetwork, SourceNetworkContext, SourceRequestOptions} from '../../contracts/network';
import type {SourceEntry, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags} from '../../shared/html';
import {languages} from './definition';
import {block, imageUrl, meta, ownership, requireLocation, unavailable} from './html';
import {search} from './search';

async function request(url: string, context: SourceNetworkContext, options?: SourceRequestOptions) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, options);
  context.signal?.throwIfAborted();
  return body;
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
    const safe = inertHtml(await request(loc.catalogUrl, context, {desktop: true}));
    ownership(safe, loc.catalogUrl);
    const title = meta(safe, 'og:title')?.trim(), cover = meta(safe, 'og:image');
    if (!title) throw unavailable();
    const entries: SourceEntry[] = [], pageSize = 100;
    const endpoint = `https://m.webtoons.com/api/v1/${loc.section === 'canvas' ? 'canvas' : 'webtoon'}/${loc.title}/episodes?pageSize=${pageSize}`;
    let cursor = 0, pages = 0;
    while (true) {
      if (++pages > 1000) throw unavailable();
      const response = await request(endpoint + (cursor ? '&cursor=' + cursor : ''), context);
      let data;
      try {data = JSON.parse(response);} catch {throw unavailable();}
      const rows = data?.result?.episodeList, next = data?.result?.nextCursor;
      if (data?.success !== true || !Array.isArray(rows) || rows.length > pageSize || !Number.isSafeInteger(next) || next < 0)
        throw unavailable();
      for (const row of rows) {
        if (!Number.isSafeInteger(row?.episodeNo) || row.episodeNo <= cursor || typeof row.viewerLink !== 'string' ||
            typeof row.episodeTitle !== 'string' || !row.episodeTitle.trim() || entries.length >= 10000) throw unavailable();
        const target = new URL(row.viewerLink, loc.catalogUrl), entry = requireLocation(target.href);
        if (entry.key !== loc.key || entry.episode !== String(row.episodeNo)) throw unavailable();
        target.hostname = 'www.webtoons.com';
        entries.push({id: loc.key + ':episode:' + entry.episode, catalogId: loc.key, remoteId: entry.episode,
          url: target.href, title: row.episodeTitle.trim(), order: entries.length, groupIds: ['episodes'], rawTypes: [], related: false,
          sequenceId: loc.key, contentLanguage: languages[loc.language]});
        cursor = row.episodeNo;
      }
      if (next === 0) break;
      // The cursor is an episode number, not an offset that shifts when new chapters appear.
      if (!rows.length || next !== cursor) throw unavailable();
    }
    if (!entries.length) throw unavailable();
    return {id: loc.key, sourceId: 'webtoons', url: loc.catalogUrl, title, observedAt: Date.now(), complete: true,
      cover: cover ? {url: imageUrl(cover)} : undefined,
      note: '网站公开目录；登录、付费、年龄验证与 App 专属内容以源站实际开放范围为准。',
      groups: [{id: 'episodes', title: 'Episodes', entryIds: entries.map(e => e.id), complete: true}], entries, defaultEntryId: entries[0]?.id};
  },
  async pages(url, context) {
    requireLocation(url);
    const target = new URL(url); target.hostname = 'www.webtoons.com';
    return parsePages(await request(target.href, context, {desktop: true}), url);
  },
} satisfies SourceNetwork;
