import {attributes, hasClass, tags} from '../../shared/html';
import {rawLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`RawKuro ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('RawKuro 页面数据无效。');
  return value.trim();
}
export function location(value: string, base?: string) {
  const loc = rawLocation(new URL(value, base));
  if (!loc) throw Error('RawKuro 来源地址无效。');
  return loc;
}
/** Balance only selected regions; unrelated source markup is not a document parser. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
  const result: Array<{attrs: Record<string, string>; body: string}> = [];
  let selected: {attrs: Record<string, string>; start: number} | undefined, depth = 0;
  for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (/^<\//.test(token[0])) {
      if (selected && --depth === 0) {
        result.push({attrs: selected.attrs, body: html.slice(selected.start, token.index)}); selected = undefined;
      }
    } else if (selected) depth++;
    else {
      const attrs = attributes(token[0]);
      if (select(attrs)) {selected = {attrs, start: token.index! + token[0].length}; depth = 1;}
    }
  }
  if (selected) throw Error('RawKuro 页面结构不完整。');
  return result;
}
export const byId = (html: string, tag: string, id: string) => one(regions(html, tag, a => a.id === id), id).body;
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export function canonicalLocation(html: string, url: string) {
  const loc = location(url), canonical = one(tags(html, 'link').filter(a => a.rel === 'canonical'), '规范地址');
  const target = location(text(canonical.href), url);
  if (target.slug !== loc.slug || target.chapter !== loc.chapter) throw Error('RawKuro 页面作品或章节归属错误。');
  return loc;
}
export function imageUrl(value: unknown, base: string) {
  const url = new URL(text(value), base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('RawKuro 图片地址无效。');
  return url.href;
}
export function coverUrl(value: unknown, base: string) {
  const url = new URL(imageUrl(value, base));
  if (!/\/uploads\/covers\/[^/]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) throw Error('RawKuro 专门封面地址无效。');
  return {url: url.href};
}
