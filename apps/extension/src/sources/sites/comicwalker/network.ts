import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {artwork, completeList, count, list, nextData, pageData, record, text, uuid, viewerUrl} from './data';
import {catalogKey, catalogUrl, episodeCode, episodeKey, episodeUrl, location, origin, workCode} from './definition';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const data = pageData(nextData(html), url), id = catalogKey(data.work);
  const entries: SourceCatalogSnapshot['entries'] = [], groups: SourceCatalogSnapshot['groups'] = [], seen = new Set<string>();
  function group(rows: Record<string, unknown>[], groupId: string, title: string, type: string) {
    const entryIds: string[] = [];
    for (const row of rows) {
      const code = text(row.code), entryId = episodeKey(code);
      if (!episodeCode.test(code) || code.slice(3, 9) !== data.work.slice(3, 9) || seen.has(entryId) ||
        typeof row.isActive !== 'boolean') throw Error('ComicWalker 目录包含重复章节或错误归属。');
      seen.add(entryId); entryIds.push(entryId);
      entries.push({id: entryId, catalogId: id, remoteId: code, url: episodeUrl(data.work, code, type),
        title: [text(row.title), typeof row.subTitle === 'string' ? row.subTitle.trim() : ''].filter(Boolean).join(' '),
        order: entries.length, groupIds: [groupId], rawTypes: [text(row.type)], related: false,
        sequenceId: `${id}:${groupId}`, contentLanguage: text(data.metadata.language, 35),
        readable: row.isActive && ['web', 'web_trial'].includes(String(row.serviceId))});
    }
    if (entryIds.length) groups.push({id: groupId, title, entryIds, complete: true});
  }
  group(completeList(data.details.firstEpisodes), 'serial', '話', 'first');
  for (const comic of completeList(data.details.comics))
    group(list(comic.episodes).map(record), 'comic:' + uuid(comic.id), text(comic.title), 'comics');
  if (!entries.length) throw Error('ComicWalker 作品没有网页章节。');
  return {id, sourceId: 'comicwalker', url: catalogUrl(data.work), title: text(data.metadata.title),
    cover: artwork(data.metadata.originalThumbnail), observedAt: Date.now(), complete: true, note: '', groups, entries,
    defaultEntryId: entries.find(e => e.readable)?.id};
}
export function parsePages(value: unknown, url: string, title: string, expectedTotal: number): SourceSnapshot {
  const loc = location(new URL(url)), data = record(value), rows = list(data.manuscripts, 1500).map(record);
  if (!loc?.work || !loc.episode || !rows.length || rows.length !== expectedTotal ||
    !['rtl', 'ltr', 'vertical'].includes(String(data.scrollDirection))) throw Error('ComicWalker 正文清单不完整。');
  const ordered = [...rows].sort((a, b) => count(a.page, 1) - count(b.page, 1));
  const items = ordered.map((row, order) => {
    const imageUrl = new URL(text(row.drmImageUrl, 8192)), hash = text(row.drmHash, 16);
    if (count(row.page, 1) !== order + 1 || row.drmMode !== 'xor' || !/^[a-f0-9]{16}$/.test(hash) ||
      imageUrl.origin !== 'https://cdn.comic-walker.com' || imageUrl.username || imageUrl.password ||
      !imageUrl.pathname.startsWith(`/images/${Number(loc.work!.slice(3, 9))}/`) || !/\.webp$/.test(imageUrl.pathname))
      throw Error('ComicWalker 图片归属、页序或还原格式无效。');
    return {id: `${episodeKey(loc.episode!)}:page:${order + 1}`, order,
      contentKey: `comicwalker:${imageUrl.pathname}:${hash}`, width: count(row.width, 1), height: count(row.height, 1),
      resource: {kind: 'http' as const, url: imageUrl.href, processing: 'comicwalker-xor:' + hash}};
  });
  return {adapter: 'comicwalker', url, title, direction: data.scrollDirection === 'rtl' ? 'rtl' : 'ltr',
    items, knownTotal: items.length, discoveryComplete: true, note: ''};
}
async function request(url: string, context: SourceNetworkContext, referer?: string) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, referer ? {referer} : undefined);
  context.signal?.throwIfAborted(); return body;
}
async function viewerEntry(url: string, context: SourceNetworkContext) {
  const loc = location(new URL(url));
  if (!loc?.episode || loc.work) throw Error('ComicWalker 阅读器地址无效。');
  // Legacy /viewer URLs redirect, but the shared transport rejects redirects.
  // The code prefix is only a lookup candidate: the returned catalog must own this exact episode.
  const candidate = catalogUrl(`KC_${loc.episode.slice(3, 9)}_S`);
  const catalog = parseCatalog(await request(candidate, context), candidate);
  const entry = catalog.entries.find(e => e.remoteId === loc.episode);
  if (!entry) throw Error('ComicWalker 目录未确认该章节归属。');
  return {catalogUrl: catalog.url, url: entry.url};
}
export const network: SourceNetwork = {
  async resolveCatalog(url, context) {
    if (!location(new URL(url))?.work) return (await viewerEntry(url, context)).catalogUrl;
    const data = pageData(nextData(await request(url, context)), url);
    return catalogUrl(data.work);
  },
  async catalog(url, context) {
    const loc = location(new URL(url));
    if (!loc?.work) throw Error('ComicWalker 作品地址无效。');
    return parseCatalog(await request(catalogUrl(loc.work), context), catalogUrl(loc.work));
  },
  async pages(url, context) {
    const loc = location(new URL(url));
    if (!loc?.episode) throw Error('ComicWalker 章节地址无效。');
    if (!loc.work) url = (await viewerEntry(url, context)).url;
    const data = pageData(nextData(await request(url, context)), url);
    const episode = record(data.query('/api/contents/details/episode').episode);
    if (episode.code !== data.episode || episode.isActive !== true || !['web', 'web_trial'].includes(String(episode.serviceId)))
      throw Error('ComicWalker 章节未公开或已结束公开。');
    const type = text(data.props.episodeType, 10);
    if (!['first', 'latest', 'comics'].includes(type)) throw Error('ComicWalker 章节分组无效。');
    const target = episodeUrl(data.work, data.episode!, type);
    return parsePages(JSON.parse(await request(viewerUrl(uuid(episode.id)), context, target)), target,
      text(episode.title), count(record(episode.internal).pageCount, 1));
  },
  async search(input, context) {
    if (input.siteId !== 'comicwalker' || !input.query.trim()) throw Error('ComicWalker 搜索条件无效。');
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || offset % 32 ||
      input.cursor !== undefined && String(offset) !== input.cursor) throw Error('ComicWalker 搜索游标无效。');
    const params = new URLSearchParams({keywords: input.query.trim(), sortBy: 'popularity', offset: String(offset), limit: '32'});
    const data = record(JSON.parse(await request(`${origin}/api/search/keywords?${params}`, context, origin + '/search')));
    const rows = list(data.result, 32).map(record), total = count(record(data.pagination).total), seen = new Set<string>();
    if (offset + rows.length > total || offset + rows.length < total && rows.length !== 32) throw Error('ComicWalker 搜索结果不完整。');
    const items = rows.map(row => {
      const code = text(row.code);
      if (!workCode.test(code) || seen.has(code)) throw Error('ComicWalker 搜索作品标识无效。');
      seen.add(code);
      return {catalogId: catalogKey(code), catalogUrl: catalogUrl(code),
        title: text(row.title), cover: artwork(row.originalThumbnail), authors: list(row.authors, 100).map(a => text(record(a).name)),
        contentLanguages: [text(row.language, 35)]};
    });
    return {items, ...(offset + rows.length < total ? {nextCursor: String(offset + rows.length)} : {})};
  },
};
