import {inertHtml, tags} from '../../shared/html';
import {asuraLocation, origin} from './definition';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Asura Scans 数据结构无效。');
  return value as Record<string, unknown>;
}
export function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value))
    throw Error('Asura Scans 文本字段无效。');
  return value.trim();
}
export function integer(value: unknown, max = 10000) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw Error('Asura Scans 数量字段无效。');
  return Number(value);
}
export function chapterNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(String(value)))
    throw Error('Asura Scans 章节编号无效。');
  return String(value);
}
export function location(value: string) {
  const loc = asuraLocation(new URL(value, origin));
  if (!loc) throw Error('Asura Scans 来源地址无效。');
  return loc;
}
export function imageUrl(value: unknown, kind: 'covers' | 'chapters') {
  const url = new URL(text(value));
  if (url.origin !== 'https://cdn.asurascans.com' || url.username || url.password || url.hash ||
      !url.pathname.startsWith('/asura-images/' + kind + '/') || !/\.(?:webp|png|jpe?g|avif)$/i.test(url.pathname))
    throw Error('Asura Scans 图片地址无效。');
  return url.href;
}

/** Only the inert JSON object/array/primitive tuples observed in this site's SSR props. Never import site code. */
function decode(value: unknown, depth = 0): unknown {
  if (depth > 24 || !Array.isArray(value) || value.length < 1 || value.length > 2)
    throw Error('Asura Scans 页面数据编码无效。');
  const [type, data] = value;
  if (type === 1 && Array.isArray(data)) return data.map(item => decode(item, depth + 1));
  if (type !== 0 || Array.isArray(data)) throw Error('Asura Scans 页面数据类型不支持。');
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Asura Scans 页面字段无效。');
    return [key, decode(item, depth + 1)];
  }));
  return data;
}
export function parseProps(value: string | null) {
  if (!value || value.length > 6 * 1024 * 1024) throw Error('Asura Scans 页面数据缺失或过大。');
  return object(JSON.parse(value));
}
export const prop = (props: Record<string, unknown>, key: string) => decode(props[key]);
export function componentPath(component: string, path: string | null) {
  return !!path && new RegExp('^/_astro/' + component + '\\.[\\w-]+\\.js$').test(path);
}
export function island(safe: string, component: string) {
  const matches = tags(safe, 'astro-island').filter(attrs => componentPath(component, attrs['component-url']));
  if (matches.length !== 1) throw Error('Asura Scans 页面数据缺失；请检查源站访问状态或页面结构。');
  return parseProps(matches[0].props);
}
export function responsePage(html: string, url: string) {
  const expected = location(url), safe = inertHtml(html);
  const canonical = tags(safe, 'link').filter(attrs => attrs.rel === 'canonical');
  // Comic readers omit canonical links; ChapterReader's seriesSlug/chapterNumber are authoritative there.
  if (!canonical.length && expected.chapter !== undefined) return {safe, loc: expected};
  if (canonical.length !== 1 || !canonical[0].href) throw Error('Asura Scans 页面身份缺失。');
  const actual = location(canonical[0].href);
  if (actual.work !== expected.work || actual.chapter !== expected.chapter) throw Error('Asura Scans 页面归属不符。');
  return {safe, loc: actual};
}
