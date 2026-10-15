import {attributes, hasClass, tags} from '../html';
import type {MangaThemesiaLocation, MangaThemesiaSite} from './config';

export function mangaThemesiaHtml(site: MangaThemesiaSite) {
  function one<T>(values: T[], label: string): T {
    if (values.length !== 1) throw Error(`${site.name} ${label}缺失或重复。`);
    return values[0];
  }
  function text(value: unknown, max = 2048): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value.trim()))
      throw Error(`${site.name} 页面数据无效。`);
    return value.trim();
  }
  function location(value: string) {
    const loc = site.location(new URL(text(value), site.origin));
    if (!loc) throw Error(`${site.name} 来源地址无效。`);
    return loc;
  }
  /** Inert balanced containers, bounded by the caller's response budget. */
  function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
    const result: Array<{attrs: Record<string, string>; body: string}> = [];
    let selected: {attrs: Record<string, string>; bodyStart: number} | undefined, depth = 0;
    for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      if (/^<\//.test(token[0])) {
        if (selected && --depth === 0) {
          result.push({attrs: selected.attrs, body: html.slice(selected.bodyStart, token.index)}); selected = undefined;
        }
      } else if (selected) depth++;
      else {
        const attrs = attributes(token[0]);
        if (select(attrs)) {selected = {attrs, bodyStart: token.index! + token[0].length}; depth = 1;}
      }
    }
    if (selected) throw Error(`${site.name} 页面结构不完整。`);
    return result;
  }
  const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
  const byId = (html: string, tag: string, id: string) => one(regions(html, tag, a => a.id === id), id).body;
  function canonical(html: string, expected: MangaThemesiaLocation) {
    const actual = location(one(tags(html, 'link').filter(a => a.rel === 'canonical'), '规范地址').href);
    if (expected.chapterSlug ? actual.chapterSlug !== expected.chapterSlug :
      actual.chapterSlug || actual.catalogSlug !== expected.catalogSlug) throw Error(`${site.name} 页面归属错误。`);
  }
  function image(html: string) {
    const active = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
    const attrs = one(tags(active, 'img'), '图片');
    return site.imageUrl(text(attrs['data-lazy-src'] || attrs['data-src'] || attrs['data-cfsrc'] || attrs.src, 8192));
  }
  return {one, text, location, regions, byClass, byId, canonical, image};
}
