import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {artworkUrl, catalogKey, catalogUrl, entryKey, isId, origin, pixivLocation, type PixivCollection} from './definition';

type ObjectValue = Record<string, unknown>;
const invalid = (field = '响应结构') => Error(`Pixiv 返回的数据不完整或已变化（${field}），请稍后重试。`);
function object(value: unknown, field = '对象结构'): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
  return value as ObjectValue;
}
function list(value: unknown, field = '列表结构'): unknown[] {if (!Array.isArray(value)) throw invalid(field); return value;}
function text(value: unknown, field = '文本字段'): string {if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw invalid(field); return value;}
function count(value: unknown, max = 10000, field = '数量字段'): number {if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw invalid(field); return Number(value);}
function record(value: unknown) {return Array.isArray(value) && !value.length ? {} : object(value);}
function location(url: string) {const loc = pixivLocation(new URL(url)); if (!loc) throw Error('请使用 Pixiv 作者作品页或作者标签作品页链接。'); return loc;}
const compareIds = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
async function request(path: string, collection: PixivCollection, context: SourceNetworkContext): Promise<unknown> {
  context.signal?.throwIfAborted();
  const raw = await context.request(origin + path, {referer: catalogUrl(collection)});
  context.signal?.throwIfAborted();
  let value: unknown;
  try {value = JSON.parse(raw);} catch {throw invalid('接口未返回 JSON');}
  const response = object(value);
  if (response.error === true) throw Error('Pixiv 暂时无法读取此内容，请在源站确认作品可见性或登录后重试。');
  if (response.error !== false || response.body === undefined || response.body === null) throw invalid();
  return response.body;
}
function profileIds(value: unknown, {category}: PixivCollection): string[] {
  const profile = object(value), ids = [
    ...(category === 'manga' ? [] : Object.keys(record(profile.illusts))),
    ...(category === 'illustrations' ? [] : Object.keys(record(profile.manga))),
  ];
  if (ids.length > 10000 || ids.some(id => !isId(id)) || new Set(ids).size !== ids.length) throw invalid();
  return ids.sort(compareIds);
}
function matchesCategory(type: unknown, {category}: PixivCollection) {
  return category === 'manga' ? type === 1 : category === 'illustrations' ? type === 0 || type === 2 : type === 0 || type === 1 || type === 2;
}
function work(value: unknown, collection: PixivCollection) {
  const row = object(value);
  if (!isId(row.id)) throw invalid('作品 ID');
  if (row.userId !== collection.userId) throw invalid('作品作者归属');
  if (!matchesCategory(row.illustType, collection)) throw invalid('作品分类');
  if (collection.tag !== undefined && !list(row.tags, '作品标签').includes(collection.tag)) throw invalid('作品标签归属');
  return {id: row.id, title: text(row.title, '作品标题'), readable: row.illustType !== 2 && row.isMasked !== true && count(row.pageCount, 1500, '作品页数') > 0};
}
function catalogSnapshot(collection: PixivCollection, title: string, rows: ReturnType<typeof work>[]): SourceCatalogSnapshot {
  if (new Set(rows.map(row => row.id)).size !== rows.length || rows.length > 10000) throw invalid();
  const label = collection.category === 'illustrations' ? '插画' : collection.category === 'manga' ? '漫画' : undefined;
  const id = catalogKey(collection);
  const entries = rows.map((row, order) => ({id: entryKey(collection, row.id), catalogId: id, remoteId: row.id,
    url: artworkUrl(collection, row.id), title: row.title, groupIds: ['artworks'], rawTypes: [], order, related: false,
    sequenceId: `${id}:artworks`, readable: row.readable}));
  return {id, sourceId: 'pixiv', url: catalogUrl(collection), title, complete: true, observedAt: Date.now(),
    note: rows.some(row => !row.readable) ? '目录保留动画与当前不可读作品；动画暂不支持在阅读器中播放。' : '',
    entries, groups: [{id: 'artworks', title: collection.tag ?? label ?? '作品', entryIds: entries.map(entry => entry.id), complete: true}],
    defaultEntryId: entries.find(entry => entry.readable)?.id};
}
export function parseCatalog(userValue: unknown, values: unknown[], collection: PixivCollection): SourceCatalogSnapshot {
  const user = object(userValue);
  if (user.userId !== collection.userId || collection.seriesId) throw invalid();
  const label = collection.category === 'illustrations' ? '插画' : collection.category === 'manga' ? '漫画' : undefined;
  const title = [text(user.name), label, collection.tag].filter(value => value !== undefined).join(' · ');
  return catalogSnapshot(collection, title, values.map(value => work(value, collection)).sort((a, b) => compareIds(a.id, b.id)));
}
async function readSeries(collection: PixivCollection, context: SourceNetworkContext): Promise<SourceCatalogSnapshot> {
  const rows: ReturnType<typeof work>[] = [];
  let total: number | undefined, title = '';
  for (let pageNumber = 1; total === undefined || rows.length < total; pageNumber++) {
    const body = object(await request(`/ajax/series/${collection.seriesId}?p=${pageNumber}`, collection, context)), page = object(body.page, '系列分页');
    const info = list(body.illustSeries, '系列资料').map(value => object(value)).find(row => row.id === collection.seriesId);
    if (!info) throw invalid('系列资料');
    const size = count(page.total, 10000, '系列作品总数'), positions = list(page.series, '系列作品列表').map(value => object(value));
    if (total !== undefined && total !== size || positions.length !== Math.min(12, size - rows.length)) throw invalid(`系列第 ${pageNumber} 页作品数量`);
    total = size; title = text(info.title, '系列名称');
    const thumbnails = new Map(list(object(body.thumbnails, '系列作品摘要').illust, '系列作品摘要列表')
      .map(value => {const row = object(value); return [row.id, row];}));
    for (const position of positions) {
      // The series list is authoritative; summaries and details need not repeat its membership.
      if (!isId(position.workId)) throw invalid('系列作品 ID');
      const value = thumbnails.get(position.workId) ?? await request(`/ajax/illust/${position.workId}`, collection, context);
      rows.push(work(value, collection));
    }
  }
  return catalogSnapshot(collection, title, rows.reverse());
}
export function parsePages(detailValue: unknown, pagesValue: unknown, url: string): SourceSnapshot {
  const loc = location(url), detail = object(detailValue);
  if (!loc.artworkId || detail.id !== loc.artworkId || detail.userId !== loc.userId) throw Error('Pixiv 作品不属于当前作者目录。');
  if (!matchesCategory(detail.illustType, loc)) throw Error('Pixiv 作品不属于当前插画或漫画分类，请刷新目录。');
  if (loc.tag !== undefined && !list(object(detail.tags).tags).some(tag => object(tag).tag === loc.tag)) throw Error('Pixiv 作品已不属于当前标签目录，请刷新目录。');
  if (detail.illustType === 2) throw Error('Pixiv 动画暂不支持在阅读器中播放，请在源站查看。');
  if (detail.illustType !== 0 && detail.illustType !== 1 || detail.isMasked === true) throw invalid();
  const pages = list(pagesValue), total = count(detail.pageCount, 1500);
  if (!total || pages.length !== total) throw invalid();
  const items = pages.map((value, order) => {
    const page = object(value), image = new URL(text(object(page.urls).original));
    if (image.origin !== 'https://i.pximg.net' || image.username || image.password || image.search || image.hash ||
      !new RegExp(`^/img-original/img/\\d{4}(?:/\\d{2}){5}/${loc.artworkId}_p${order}\\.(?:png|jpe?g|gif|webp|avif)$`, 'i').test(image.pathname))
      throw Error('Pixiv 原图地址与作品页序不一致。');
    const width = count(page.width, 100000), height = count(page.height, 100000);
    if (!width || !height) throw invalid();
    return {id: `page-${order}`, order, width, height, resource: {kind: 'http' as const, url: image.href}};
  });
  return {adapter: 'pixiv', url, title: text(detail.title), direction: 'rtl', note: '', discoveryComplete: true, knownTotal: total, items};
}
export const network = {
  async catalog(url, context) {
    const collection = location(url);
    if (collection.artworkId) throw Error('请使用 Pixiv 作者作品页链接。');
    if (collection.seriesId) return readSeries(collection, context);
    const user = await request(`/ajax/user/${collection.userId}?full=1`, collection, context), values: unknown[] = [];
    if (collection.tag !== undefined) {
      let total: number | undefined;
      do {
        const params = new URLSearchParams({tag: collection.tag, offset: String(values.length), limit: '48'});
        const endpoint = collection.category === 'illustrations' ? 'illusts' : collection.category === 'manga' ? 'manga' : 'illustmanga';
        const batch = object(await request(`/ajax/user/${collection.userId}/${endpoint}/tag?${params}`, collection, context));
        const size = count(batch.total), rows = list(batch.works);
        if (total !== undefined && total !== size || rows.length !== Math.min(48, size - values.length)) throw invalid();
        total = size; values.push(...rows);
      } while (values.length < total);
    } else {
      const path = `/ajax/user/${collection.userId}/profile/all`, ids = profileIds(await request(path, collection, context), collection);
      for (let offset = 0; offset < ids.length; offset += 48) {
        const batchIds = ids.slice(offset, offset + 48), params = new URLSearchParams({work_category: 'illustManga', is_first_page: '0'});
        for (const id of batchIds) params.append('ids[]', id);
        const batch = record(object(await request(`/ajax/user/${collection.userId}/profile/illusts?${params}`, collection, context)).works);
        if (Object.keys(batch).length !== batchIds.length || batchIds.some(id => object(batch[id]).id !== id)) throw invalid();
        values.push(...batchIds.map(id => batch[id]));
      }
    }
    return parseCatalog(user, values, collection);
  },
  async pages(url, context) {
    const collection = location(url);
    if (!collection.artworkId) throw Error('请从 Pixiv 作者目录选择作品阅读。');
    const path = `/ajax/illust/${collection.artworkId}`, detail = await request(path, collection, context);
    return parsePages(detail, await request(path + '/pages', collection, context), url);
  },
} satisfies SourceNetwork;
