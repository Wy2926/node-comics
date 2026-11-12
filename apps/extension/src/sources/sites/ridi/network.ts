import type {SourceNetwork, SourceNetworkContext, SourceRequestOptions} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {catalogUrl, episodeKey, episodeUrl, origin, validId} from './definition';
import {catalogInfo, changed, json, label, object, readerInfo, script, source} from './protocol';

const episodesQuery = `query Episodes($id: UUID!, $context: BookDetailHomeEpisodeBookListCellContext!) {
  riGrid { cells { bookDetailHome { episodeBookListCell(id: $id, context: $context) { cell {
    seriesId currentOrder currentTabType books { bookId title badges }
    pagination { nextPage { order offset limit } prevPage { order offset limit } }
  } } } } }
}`;
async function request(context: SourceNetworkContext, url: string, options?: SourceRequestOptions) {
  context.signal?.throwIfAborted();
  const raw = await context.request(url, options);
  context.signal?.throwIfAborted();
  return raw;
}
export function parsePages(raw: string, info: ReturnType<typeof readerInfo>, url: string): SourceSnapshot {
  const response = json(raw);
  if (response.success !== true) throw Error('RIDI 未提供可读取的正文，请在源站确认登录、年龄验证或购买状态。');
  const data = object(response.data);
  if (data.type !== 'comic' || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 1500) throw changed();
  const seen = new Set<string>();
  const items = data.pages.map((value, order) => {
    const page = object(value), filename = label(page.filename);
    let target: URL;
    try {target = new URL(label(page.src));} catch {throw changed();}
    if (!/^[\w.-]+\.(?:webp|png|jpe?g)$/i.test(filename) || seen.has(filename) ||
      !['https://webview-cache.ridibooks.com', 'https://webview-cache2.ridibooks.com'].includes(target.origin) || target.username || target.password || target.hash ||
      target.pathname !== `/${info.bookId}/webtoon/${filename}` ||
      !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) ||
      Number(page.width) < 1 || Number(page.height) < 1 || Number(page.width) > 100000 || Number(page.height) > 100000) throw changed();
    seen.add(filename);
    return {id: 'page-' + order, order, width: Number(page.width), height: Number(page.height),
      resource: {kind: 'http' as const, url: target.href}};
  });
  // RIDI may revise bytes at the same filename; expiring URLs are not content hashes.
  return {url, adapter: 'ridi', title: info.title, direction: info.direction, discoveryComplete: true,
    knownTotal: items.length, note: '', items};
}
export const network = {
  async resolveCatalog(url, context) {
    const loc = source(url);
    if (!loc.reader) throw changed();
    const info = readerInfo(script(await request(context, episodeUrl(loc.bookId)), 'app_init'), url);
    return catalogUrl(info.seriesId);
  },
  async catalog(url, context): Promise<SourceCatalogSnapshot> {
    const loc = source(url);
    if (loc.reader) throw changed();
    const target = catalogUrl(loc.bookId);
    const loadInfo = async () => catalogInfo(script(await request(context, target), '__NEXT_DATA__'), target);
    const info = await loadInfo(), entries: SourceCatalogSnapshot['entries'] = [], seen = new Set<string>();
    let list = info.list, limit: number | undefined, requests = 0;
    const tab = list.currentTabType;
    if (tab !== 'BUY' && tab !== 'RENT' || object(list.pagination).prevPage !== null) throw changed();
    while (true) {
      if (list.seriesId !== loc.bookId || list.currentOrder !== 'SEQUENTIAL' || list.currentTabType !== tab ||
        !Array.isArray(list.books) || !list.books.length || list.books.length > 1000 ||
        limit !== undefined && list.books.length !== Math.min(limit, info.total - entries.length)) throw changed();
      for (const value of list.books) {
        const row = object(value);
        if (!validId(row.bookId) || seen.has(row.bookId) || !Array.isArray(row.badges) || row.badges.length > 100) throw changed();
        seen.add(row.bookId);
        entries.push({id: episodeKey(row.bookId), remoteId: row.bookId, catalogId: info.catalogId,
          url: episodeUrl(row.bookId, loc.bookId), title: label(row.title), order: entries.length,
          groupIds: ['episodes'], rawTypes: row.badges.map(label), related: false, sequenceId: info.catalogId, contentLanguage: 'ko'});
      }
      if (entries.length > info.total) throw changed();
      const next = object(list.pagination).nextPage;
      if (next === null) break;
      const cursor = object(next);
      if (cursor.order !== 'SEQUENTIAL' || cursor.offset !== entries.length || entries.length >= info.total ||
        !Number.isSafeInteger(cursor.limit) || Number(cursor.limit) < 1 || Number(cursor.limit) > 1000 || ++requests > 500) throw changed();
      limit = Number(cursor.limit);
      const response = json(await request(context, 'https://api.ridibooks.com/graphql', {referer: target, json: {
        query: episodesQuery, variables: {id: info.cellId, context: {bookId: loc.bookId, deviceType: 'DESKTOP', order: 'SEQUENTIAL',
          tabType: tab, pagination: {offset: cursor.offset, limit}}},
      }}));
      if (response.errors !== undefined) throw changed();
      list = object(object(object(object(object(object(response.data).riGrid).cells).bookDetailHome).episodeBookListCell).cell);
    }
    if (entries.length !== info.total) throw changed();
    if (requests) {
      const check = await loadInfo();
      if (check.total !== info.total || check.title !== info.title || JSON.stringify(check.list) !== JSON.stringify(info.list)) throw changed();
    }
    return {id: info.catalogId, sourceId: 'ridi', url: target, title: info.title,
      cover: {url: `https://img.ridicdn.net/cover/${loc.bookId}/large`}, observedAt: Date.now(), complete: true,
      entries, groups: [{id: 'episodes', title: '회차', entryIds: entries.map(entry => entry.id), complete: true}], defaultEntryId: entries[0]?.id,
      note: '已读取完整条漫目录；正文沿用源站阅读权限。'};
  },
  async pages(url, context) {
    const loc = source(url);
    if (!loc.reader) throw changed();
    const referer = episodeUrl(loc.bookId);
    const info = readerInfo(script(await request(context, referer), 'app_init'), url);
    return parsePages(await request(context, origin + '/api/web-viewer/generate', {referer, json: {book_id: loc.bookId}}), info, url);
  },
} satisfies SourceNetwork;
