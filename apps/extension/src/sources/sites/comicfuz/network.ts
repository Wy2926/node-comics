import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import type {SourceSearchPage} from '../../contracts/search';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {cover, id, imageId, imageUrl, label, list, nextData, object, sourceLocation} from './data';
import {bytes, decode, encode, invalid, messages, number, text} from '../../shared/protobuf';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = sourceLocation(url), data = nextData(html, loc.manga), manga = object(data.manga);
  if (loc.chapter || id(manga.mangaId) !== loc.manga) throw invalid();
  const key = catalogKey(loc.manga), entries: SourceCatalogSnapshot['entries'] = [], groups: SourceCatalogSnapshot['groups'] = [];
  const seen = new Set<string>(), groupIds = new Set<string>();
  // This is the full SSR ChapterGroup list, also rendered by the site's first-to-last toggle.
  for (const value of [...list(data.chapters, 1000)].reverse()) {
    const group = object(value), header = group.bookIssueHeader === undefined ? undefined : object(group.bookIssueHeader);
    const groupId = header?.bookIssueId ? 'book-' + id(header.bookIssueId) : 'chapters';
    if (groupIds.has(groupId)) throw invalid(); groupIds.add(groupId);
    const entryIds: string[] = [];
    for (const value of [...list(group.chapters)].reverse()) {
      const row = object(value), chapter = id(row.chapterId), entryId = chapterKey(chapter);
      if (seen.has(chapter) || entries.length >= 10000) throw invalid(); seen.add(chapter);
      const point = object(row.pointConsumption), amount = point.amount ?? 0;
      if (!Number.isSafeInteger(amount) || (amount as number) < 0 || ![0, 1, 2].includes(Number(point.type ?? 0))) throw invalid();
      entryIds.push(entryId);
      entries.push({id: entryId, catalogId: key, remoteId: chapter, url: chapterUrl(loc.manga, chapter),
        title: [label(row.chapterMainName), row.chapterSubName ? label(row.chapterSubName) : ''].filter(Boolean).join(' '),
        groupIds: [groupId], rawTypes: row.campaign ? [label(row.campaign)] : [], order: entries.length, related: false,
        sequenceId: key + ':' + groupId, readable: amount === 0});
    }
    groups.push({id: groupId, title: header ? label(header.text) : '話一覧', entryIds, complete: true});
  }
  if (!entries.length) throw invalid();
  const initial = id(object(object(data.viewButton).chapter).chapterId);
  if (!seen.has(initial)) throw invalid();
  return {id: key, sourceId: 'comicfuz', url: catalogUrl(loc.manga), title: label(manga.mangaName),
    cover: cover(manga.mainThumbnailUrl), observedAt: Date.now(), complete: true, entries, groups,
    defaultEntryId: entries.find(entry => entry.remoteId === initial && entry.readable)?.id ?? entries.find(entry => entry.readable)?.id,
    note: '保留网站完整连载目录；需点数或阅读券解锁的章节不自动消费，请在源站阅读。单行本商店和杂志不在此目录中。'};
}
const device = encode([3, 2]);
export const viewerRequest = (chapter: string) => encode([1, device], [2, 0], [3, encode([1, 0], [2, 0])], [4, Number(id(chapter))]);
async function requestBytes(endpoint: string, body: Uint8Array, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  if (!context.requestBytes) throw Error('COMIC FUZ 需要二进制来源请求支持。');
  const response = await context.requestBytes(`https://api.comic-fuz.com/v1/${endpoint}`, {referer: origin + '/', body});
  context.signal?.throwIfAborted(); return response;
}
export function parsePages(response: Uint8Array, url: string): SourceSnapshot {
  const loc = sourceLocation(url), data = decode(response);
  if (!loc.chapter || String(number(data, 12)) !== loc.chapter || !bytes(data, 11) ||
    String(number(decode(bytes(data, 11)!), 1)) !== loc.manga) throw invalid();
  const chapters = messages(data, 5, 1000).flatMap(group => messages(group, 2, 10000));
  if (chapters.filter(chapter => String(number(chapter, 1)) === loc.chapter).length !== 1) throw invalid();
  const viewer = bytes(data, 2);
  if (!viewer) throw Error('此 COMIC FUZ 章节当前不可读，请在源站确认登录及阅读权限；插件不会消耗点数或阅读券。');
  const info = decode(viewer), pages = messages(info, 2), items: SourceSnapshot['items'] = [];
  const direction = number(info, 3);
  if (direction > 3) throw invalid();
  const imagePath = new RegExp(`^/f/[\\w-]+/${imageId(loc.chapter)}/[\\w-]+\\.(?:jpe?g|png|webp)(?:\\.enc)?$`);
  for (const [order, page] of pages.entries()) {
    const kinds = [1, 2, 3, 4].filter(field => bytes(page, field) !== undefined);
    if (kinds.length !== 1) throw invalid();
    // Web views, last-page panels and ads are not comic pages. Preserve original slot indices.
    if (kinds[0] !== 1) continue;
    const image = decode(bytes(page, 1)!), extra = number(image, 7);
    if (extra > 1) throw invalid(); if (extra) continue;
    const target = imageUrl(text(image, 1), imagePath);
    const key = text(image, 4), iv = text(image, 3), width = number(image, 5), height = number(image, 6);
    if (!width || !height || width > 100000 || height > 100000 || (!!key !== !!iv) ||
      key && (!/^[a-f\d]{64}$/i.test(key) || !/^[a-f\d]{32}$/i.test(iv)) || target.pathname.endsWith('.enc') !== !!key) throw invalid();
    items.push({id: 'page-' + order, order, width, height,
      // Versioned source path, unlike its expiring signature, is the image content identity.
      contentKey: 'comicfuz:' + target.pathname,
      resource: {kind: 'http', url: target.href, ...(key ? {processing: `comicfuz-aes:${key.toLowerCase()}:${iv.toLowerCase()}`} : {})}});
  }
  if (!items.length) throw invalid();
  return {adapter: 'comicfuz', url, title: label(text(info, 1)), direction: direction === 1 ? 'ltr' : 'rtl',
    discoveryComplete: true, knownTotal: items.length, note: '', items};
}
export function parseSearch(response: Uint8Array, page: number): SourceSearchPage {
  const data = decode(response), total = number(data, 6), rows = messages(data, 2, 100), seen = new Set<string>();
  if (total > 1000 || page > Math.max(1, total) || !total && rows.length) throw invalid();
  const items = rows.map(row => {
    const manga = id(number(row, 1));
    if (seen.has(manga)) throw invalid(); seen.add(manga);
    return {catalogId: catalogKey(manga), catalogUrl: catalogUrl(manga), title: label(text(row, 2)), cover: cover(text(row, 4))};
  });
  if (page < total && !items.length) throw invalid();
  return {items, ...(page < total ? {nextCursor: String(page + 1)} : {})};
}
export const network = {
  async catalog(url, context) {
    const loc = sourceLocation(url);
    context.signal?.throwIfAborted();
    const html = await context.request(catalogUrl(loc.manga), {referer: origin + '/'});
    context.signal?.throwIfAborted(); return parseCatalog(html, url);
  },
  async pages(url, context) {
    const loc = sourceLocation(url); if (!loc.chapter) throw invalid();
    return parsePages(await requestBytes('web_manga_viewer_2', viewerRequest(loc.chapter), context), url);
  },
  async search(request, context) {
    const query = request.query.trim(), page = Number(request.cursor ?? '1');
    if (request.siteId !== 'comicfuz' || !query || query.length > 200 || !/^[1-9]\d{0,3}$/.test(request.cursor ?? '1') || page > 1000) throw invalid();
    return parseSearch(await requestBytes('search', encode([1, device], [2, query], [4, page], [5, 1]), context), page);
  },
} satisfies SourceNetwork;
