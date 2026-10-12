import {attributes, hasClass} from '../../shared/html';
import {hachiLocation, origin} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`Hachiraw ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('Hachiraw 页面数据无效。');
  return value.trim();
}
export function location(value: string) {
  const loc = hachiLocation(new URL(value, origin));
  if (!loc) throw Error('Hachiraw 来源地址无效。');
  return loc;
}
/** Only selected elements must be balanced; unrelated source markup is not a document parser. */
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
  if (selected) throw Error('Hachiraw 页面结构不完整。');
  return result;
}
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export function imageUrl(value: unknown) {
  const url = new URL(text(value), origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('Hachiraw 图片地址无效。');
  return url.href;
}
export function coverUrl(value: unknown, slug: string) {
  const url = new URL(imageUrl(value));
  // The work-specific poster, not chapter or recommendation artwork. CDN hosts may change.
  if (!decodeURIComponent(url.pathname).endsWith(`/mangacover/${slug}.jpg`)) throw Error('Hachiraw 封面作品归属错误。');
  return {url: url.href};
}
