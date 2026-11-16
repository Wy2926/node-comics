import {attributes, inertHtml, tags} from '../../shared/html';
import {mangagoLocation, origin, type MangagoLocation} from './definition';

export function one<T>(values: T[]): T {
  if (values.length !== 1) throw Error('Mangago 页面结构缺失或重复。');
  return values[0];
}
export function text(value: string | undefined) {
  if (!value?.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('Mangago 页面数据无效。');
  return value.trim();
}
export function location(value: string) {
  const loc = mangagoLocation(new URL(value, origin));
  if (!loc) throw Error('Mangago 来源地址无效。');
  return loc;
}
export function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean = () => true) {
  const tokens = [...html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))];
  const result: Array<{attrs: Record<string, string>; body: string}> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^<\//.test(token[0])) continue;
    // The reader container repeats style attributes; styles are not protocol data.
    const attrs = attributes(token[0].replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''));
    if (!select(attrs)) continue;
    let depth = 1, end = i + 1;
    for (; end < tokens.length; end++) {
      depth += /^<\//.test(tokens[end][0]) ? -1 : 1;
      if (!depth) break;
    }
    if (depth) throw Error('Mangago 页面结构不完整。');
    result.push({attrs, body: html.slice(token.index! + token[0].length, tokens[end].index)});
  }
  return result;
}
export const region = (html: string, tag: string, select?: (attrs: Record<string, string>) => boolean) =>
  one(regions(html, tag, select)).body;
export function checkedHtml(html: string, expected: MangagoLocation) {
  const safe = inertHtml(html), canonical = one(tags(safe, 'link').filter(a => a.rel === 'canonical'));
  const actual = location(text(canonical.href));
  if (actual.work !== expected.work || actual.chapter !== expected.chapter) throw Error('Mangago 页面归属错误。');
  return safe;
}
export function resourceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^(?:i(?:web_?)?\d+|pic\d+)\.mangapicgallery\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || url.hash || url.href.length > 2048) throw Error('Mangago 图片地址无效。');
  return url;
}
export function coverUrl(value: string) {
  const url = resourceUrl(value);
  if (!/^\/r\/coverlink\/[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/.test(url.pathname) ||
      [...url.searchParams].some(([key, value]) => url.searchParams.getAll(key).length !== 1 ||
        !(key === 'acc' ? /^[a-zA-Z0-9_-]{1,256}$/.test(value) : key === 'exp' || key === 'v' ? /^\d{1,16}$/.test(value) : /^\d{1,16}$/.test(key) && value === '')))
    throw Error('Mangago 封面地址无效。');
  return {url: url.href};
}
