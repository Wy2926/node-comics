import {attributes, hasClass, tags, textContent} from '../../shared/html';
import {origin, rawLocation, type RawLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`RawOtaku ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('RawOtaku 页面数据无效。');
  return value.trim();
}
export function location(url: string): RawLocation {
  const loc = rawLocation(new URL(url));
  if (!loc) throw Error('RawOtaku 来源地址无效。');
  return loc;
}
/** Balanced source markup; no DOM globals or downloaded script execution in HTTP parsers. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
  const tokens = [...html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))];
  const result: Array<{attrs: Record<string, string>; body: string}> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^<\//.test(token[0])) continue;
    const attrs = attributes(token[0]);
    if (!select(attrs)) continue;
    let depth = 1, end = i + 1;
    for (; end < tokens.length; end++) {
      depth += /^<\//.test(tokens[end][0]) ? -1 : 1;
      if (!depth) break;
    }
    if (depth) throw Error('RawOtaku 页面结构不完整。');
    result.push({attrs, body: html.slice(token.index! + token[0].length, tokens[end].index)});
  }
  return result;
}
export const region = (html: string, tag: string, select: (attrs: Record<string, string>) => boolean) =>
  one(regions(html, tag, select), '正文结构').body;
export const byClass = (html: string, tag: string, name: string) => region(html, tag, attrs => !!hasClass(attrs, name));
export function canonical(html: string, expected: RawLocation) {
  const actual = location(new URL(text(one(tags(html, 'link').filter(a => a.rel === 'canonical'), '页面身份').href), origin).href);
  if (actual.slug !== expected.slug || actual.language !== expected.language || actual.chapter !== expected.chapter)
    throw Error('RawOtaku 页面归属已变化。');
}
export function coverUrl(value: unknown): {url: string} | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !(url.hostname === 'mgoimg.view47.com' && /^\/thumb\/\d+\/upload\/\d{4}\/\d{2}\/[\da-f]+\.(?:webp|jpe?g|png)$/i.test(url.pathname) ||
          url.hostname === 'f002.backblazeb2.com' && /^\/file\/WCMS-Images\/MangaOnline\/p\d+$/.test(url.pathname))) return;
    return {url: url.href};
  } catch {return;}
}
export function imageUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search ||
      !/^sv[1-5]\.freeimgmg\.online$/.test(url.hostname) ||
      !/^\/files\/\d+\/\d+\/\d+\.(?:webp|jpe?g|png)$/i.test(url.pathname)) throw Error('RawOtaku 正文图片地址无效。');
  return url.href;
}
export function readerInfo(html: string, loc: RawLocation) {
  if (!loc.chapter) throw Error('RawOtaku 章节地址无效。');
  canonical(html, loc);
  const owner = one(regions(html, 'a', a => !!hasClass(a, 'hr-manga')), '章节作品');
  const parent = location(new URL(text(owner.attrs.href), origin).href);
  if (parent.chapter || parent.slug !== loc.slug) throw Error('RawOtaku 章节作品归属错误。');
  const title = text(textContent(byClass(owner.body, 'h2', 'manga-name')));
  const list = region(html, 'ul', a => a.id === loc.language + '-chapters' && !!hasClass(a, 'lang-chapters'));
  const row = one(regions(list, 'li', a => a['data-number'] === loc.chapter && !!hasClass(a, 'chapter-item')), '当前章节');
  const link = one(tags(row.body, 'a'), '当前章节地址');
  const actual = location(new URL(text(link.href), origin).href);
  if (actual.slug !== loc.slug || actual.language !== loc.language || actual.chapter !== loc.chapter ||
      !/^[1-9]\d{0,12}$/.test(row.attrs['data-id'])) throw Error('RawOtaku 当前章节身份错误。');
  return {title, chapterTitle: text(textContent(byClass(row.body, 'span', 'name'))), remoteId: row.attrs['data-id']};
}
