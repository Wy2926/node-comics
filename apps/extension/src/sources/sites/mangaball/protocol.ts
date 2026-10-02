import {safeImageUrl} from '../../shared/urls';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('MangaBall 数据结构已变化。');
  return value as JsonObject;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('MangaBall 未提供完整列表。');
  return value;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('MangaBall 字段无效。');
  return value.trim();
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/.test(value)) throw Error('MangaBall 身份字段无效。');
  return value;
}
export function entity(value: unknown): JsonObject {
  const row = object(value), key = id(row.id ?? row._id);
  if (row.id !== undefined && row._id !== undefined && row.id !== row._id) throw Error('MangaBall 身份字段不一致。');
  return {...row, id: key};
}
export function response(value: unknown) {
  const row = object(value);
  if (row.status !== 'success' || row.code !== 200) throw Error('MangaBall 暂未提供可访问的内容，请在源站确认。');
  return row;
}
export function count(value: unknown, max = 100000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw Error('MangaBall 数量字段无效。');
  return Number(value);
}
export function chapterNumber(value: unknown): string | undefined {
  if (value === null || value === undefined) return;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(?:\.\d+)?$/.test(String(value))) throw Error('MangaBall 话号无效。');
  return String(value);
}
export function language(value: unknown): string {
  const raw = text(value, 35);
  const mapped = ({cn: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant-HK', jp: 'ja', kr: 'ko'} as Record<string, string>)[raw.toLowerCase()] ?? raw;
  try {return Intl.getCanonicalLocales(mapped)[0];} catch {throw Error('MangaBall 内容语言无效。');}
}
export function pagination(value: unknown, page: number, limit: number) {
  const row = object(value), total = count(row.total), pages = count(row.total_pages);
  // The search endpoint reports zero total_pages for empty results; the chapter endpoint may report one.
  if (row.page !== page || row.limit !== limit || (total ? pages !== Math.ceil(total / limit) : pages > 1) || page > Math.max(1, pages)) throw Error('MangaBall 分页不完整或已变化，请重试。');
  return {total, pages, length: Math.min(limit, Math.max(0, total - (page - 1) * limit))};
}
export function cover(value: unknown): {url: string} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const image = value as JsonObject;
  // Use the dedicated original supplied by the API when available.
  if (typeof image.cdn_mangadex === 'string') {
    const url = safeImageUrl(image.cdn_mangadex, 'https://mangaball.com/');
    if (url) return {url};
  }
  if (!image.cover || typeof image.cover !== 'object') return;
  const path = (image.cover as JsonObject).path;
  if (typeof path !== 'string') return;
  const url = safeImageUrl(path.replaceAll('\\', '/'), 'https://bulbasaur.poke-black-and-white.net/covers/');
  return url ? {url} : undefined;
}
/** API page addresses use the public image URL rules, without site CDN or filename restrictions. */
export function imageUrl(value: unknown): string {
  const url = safeImageUrl(text(value, 8192), 'https://mangaball.com/');
  if (!url) throw Error('MangaBall 图片地址无效。');
  return url;
}
