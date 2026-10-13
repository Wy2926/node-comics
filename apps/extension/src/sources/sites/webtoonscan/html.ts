import {attributes, hasClass, tags} from '../../shared/html';
import {origin, webtoonLocation, type WebtoonLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`WebtoonScan ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value.trim()))
    throw Error('WebtoonScan 页面数据无效。');
  return value.trim();
}
export function location(value: string) {
  const loc = webtoonLocation(new URL(text(value), origin));
  if (!loc) throw Error('WebtoonScan 来源地址无效。');
  return loc;
}
/** Read balanced selected containers, without evaluating any source scripts. */
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
  if (selected) throw Error('WebtoonScan 页面结构不完整。');
  return result;
}
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export function canonical(html: string, expected: WebtoonLocation) {
  const link = one(tags(html, 'link').filter(a => a.rel === 'canonical'), '规范地址');
  const actual = location(link.href);
  if (actual.slug !== expected.slug || actual.chapter !== expected.chapter) throw Error('WebtoonScan 页面归属错误。');
}
export function imageUrl(value: unknown) {
  const url = new URL(text(value), origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('WebtoonScan 图片地址无效。');
  return url.href;
}
export function cover(html: string, slug: string) {
  const link = one(regions(html, 'a', () => true), '封面作品');
  const owner = location(link.attrs.href);
  if (owner.chapter || owner.slug !== slug) throw Error('WebtoonScan 封面作品归属错误。');
  // Lazy covers include a noscript copy, not a second cover image.
  const active = link.body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
  const image = one(tags(active, 'img'), '作品封面');
  return {url: imageUrl(image['data-lazy-src'] || image['data-src'] || image.src)};
}
