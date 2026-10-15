import {attributes, hasClass, tags} from '../html';
import type {MadaraLocation, MadaraSite} from './config';

/** Bounded by the caller's HTTP budget; does not create DOM nodes or execute scripts. */
export function madaraHtml(site: MadaraSite) {
  function one<T>(values: T[], label: string): T {
    if (values.length !== 1) throw Error(`${site.name} ${label}缺失或重复。`);
    return values[0];
  }
  function text(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value.trim()))
      throw Error(`${site.name} 页面数据无效。`);
    return value.trim();
  }
  function location(value: string) {
    const loc = site.location(new URL(text(value), site.origin));
    if (!loc) throw Error(`${site.name} 来源地址无效。`);
    return loc;
  }
  function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
    const result: Array<{attrs: Record<string, string>; body: string; start: number; end: number}> = [];
    let selected: {attrs: Record<string, string>; start: number; bodyStart: number} | undefined, depth = 0;
    for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      if (/^<\//.test(token[0])) {
        if (selected && --depth === 0) {
          result.push({attrs: selected.attrs, body: html.slice(selected.bodyStart, token.index), start: selected.start,
            end: token.index! + token[0].length}); selected = undefined;
        }
      } else if (selected) depth++;
      else {
        const attrs = attributes(token[0]);
        if (select(attrs)) {selected = {attrs, start: token.index!, bodyStart: token.index! + token[0].length}; depth = 1;}
      }
    }
    if (selected) throw Error(`${site.name} 页面结构不完整。`);
    return result;
  }
  const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
  function canonical(html: string, expected: MadaraLocation) {
    const link = one(tags(html, 'link').filter(a => a.rel === 'canonical'), '规范地址');
    const actual = location(link.href);
    if (actual.slug !== expected.slug || actual.chapter !== expected.chapter) throw Error(`${site.name} 页面归属错误。`);
  }
  function cover(html: string, slug: string) {
    const link = one(regions(html, 'a', () => true), '封面作品');
    const owner = location(link.attrs.href);
    if (owner.chapter || owner.slug !== slug) throw Error(`${site.name} 封面作品归属错误。`);
    // Lazy covers include a noscript copy, not a second cover image.
    const active = link.body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
    const image = one(tags(active, 'img'), '作品封面');
    return {url: site.imageUrl(image['data-lazy-src'] || image['data-src'] || image.src)};
  }
  return {one, text, location, regions, byClass, canonical, cover};
}
