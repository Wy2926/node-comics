import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {comicLocation, origin, type ComicLocation} from './definition';

export function one<T>(values: T[]): T {
  if (values.length !== 1) throw Error('Read Comics Online 页面结构缺失或重复。');
  return values[0];
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('Read Comics Online 页面数据无效。');
  return value.trim();
}
export function location(value: string): ComicLocation {
  const loc = comicLocation(new URL(value, origin));
  if (!loc) throw Error('Read Comics Online 来源地址无效。');
  return loc;
}
/** Balance only the requested element; never evaluate source scripts or repair a truncated list. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>, raw: string) => boolean) {
  const tokens = [...html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))];
  const result: Array<{attrs: Record<string, string>; body: string; raw: string}> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^<\//.test(token[0])) continue;
    const attrs = attributes(token[0]);
    if (!select(attrs, token[0])) continue;
    let depth = 1, end = i + 1;
    for (; end < tokens.length; end++) {
      depth += /^<\//.test(tokens[end][0]) ? -1 : 1;
      if (!depth) break;
    }
    if (depth) throw Error('Read Comics Online 页面结构不完整。');
    result.push({attrs, raw: token[0], body: html.slice(token.index! + token[0].length, tokens[end].index)});
  }
  return result;
}
export const region = (html: string, tag: string, select: (attrs: Record<string, string>) => boolean) => one(regions(html, tag, select)).body;
export const sameChapter = (a: ComicLocation, b: ComicLocation) => a.slug === b.slug && a.chapter === b.chapter;

export function checkedHtml(html: string, expected: ComicLocation) {
  const safe = inertHtml(html), canonical = one(tags(safe, 'link').filter(a => a.rel === 'canonical'));
  if (!sameChapter(location(text(canonical.href)), expected)) throw Error('Read Comics Online 页面归属错误。');
  return safe;
}
function resource(value: string) {
  const url = new URL(text(value), origin);
  if (url.origin !== 'https://cdn.readcomicsonline.ru' || url.username || url.password || url.hash)
    throw Error('Read Comics Online 图片地址无效。');
  return url;
}
export function coverUrl(value: string, slug: string) {
  const url = resource(value);
  if (!url.pathname.startsWith(`/uploads/manga/${slug}/cover/`) ||
      !/^cover(?:_\d+x\d+)?\.(?:jpe?g|png|webp)$/i.test(url.pathname.split('/').at(-1)!))
    throw Error('Read Comics Online 封面归属错误。');
  return {url: url.href};
}
export function imageUrl(value: string, loc: ComicLocation) {
  const url = resource(value), prefix = `/uploads/manga/${loc.slug}/chapters/${loc.chapter}/`;
  if (!loc.chapter || !url.pathname.startsWith(prefix) ||
      !/^[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname.slice(prefix.length)))
    throw Error('Read Comics Online 正文图片归属错误。');
  return url.href;
}
export function readerWork(safe: string, loc: ComicLocation) {
  const nav = region(safe, 'nav', a => a['aria-label'] === 'Breadcrumb');
  const owner = one(regions(nav, 'a', a => {
    try {const target = location(text(a.href)); return target.slug === loc.slug && !target.chapter;} catch {return false;}
  }));
  const title = text(textContent(owner.body));
  const selectors = regions(safe, 'select', a => !!hasClass(a, 'js-chapter-select'));
  if (!selectors.length || selectors.length > 2) throw Error('Read Comics Online 章节选择器缺失。');
  const labels = selectors.map(selector => {
    const selected = one(regions(selector.body, 'option', (_a, raw) => /\sselected(?:\s|=|>)/i.test(raw)));
    const actual = location(text(selected.attrs.value)), label = text(textContent(selected.body));
    if (!sameChapter(actual, loc) || actual.page || !label.startsWith('Chapter #'))
      throw Error('Read Comics Online 当前章节归属错误。');
    return label.slice('Chapter '.length);
  });
  if (labels.some(label => label !== labels[0])) throw Error('Read Comics Online 当前章节不一致。');
  return {title, chapterTitle: title + ' ' + labels[0]};
}
