import {attributes, inertHtml, tags, textContent} from '../../shared/html';
import {mangapillLocation, origin, type MangapillLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`MangaPill ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('MangaPill 页面数据无效。');
  return value.trim();
}
export function location(value: string): MangapillLocation {
  const loc = mangapillLocation(new URL(value));
  if (!loc) throw Error('MangaPill 来源地址无效。');
  return loc;
}
/** Closed, balanced source regions; downloaded scripts stay inert. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>, raw: string) => boolean) {
  const tokens = [...html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))];
  const result: Array<{attrs: Record<string, string>; body: string}> = [];
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
    if (depth) throw Error('MangaPill 页面结构不完整。');
    result.push({attrs, body: html.slice(token.index! + token[0].length, tokens[end].index)});
  }
  return result;
}
export const region = (html: string, tag: string, select: (attrs: Record<string, string>, raw: string) => boolean) =>
  one(regions(html, tag, select), '页面结构').body;

function resource(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.readdetectiveconan.com' || url.port ||
      url.username || url.password || url.hash) throw Error('MangaPill 图片地址无效。');
  return url;
}
export function coverUrl(value: unknown, work: string): {url: string} | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = resource(value), match = /^\/file\/mangapill\/i\/([1-9]\d{0,11})\.(?:jpe?g|png|webp)$/i.exec(url.pathname);
    if (!match || match[1] !== work || [...url.searchParams.keys()].some(key => key !== 'h') ||
        url.searchParams.getAll('h').length > 1 || url.searchParams.has('h') &&
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(url.searchParams.get('h')!)) return;
    return {url: url.href};
  } catch {return;}
}
export function imageUrl(value: string, expected: MangapillLocation) {
  const url = resource(value);
  // Older chapters use work/chapter; recent uploads add a dated directory and upload UUID.
  const match = /^\/file\/mangap\/(?:\d{4}\/\d{1,2}\/)?([1-9]\d{0,11})\/(\d{1,16})\/(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\/)?[1-9]\d{0,5}\.(?:jpe?g|png|webp)$/i.exec(url.pathname);
  if (!expected.chapter || !match || match[1] !== expected.work || match[2] !== expected.chapter ||
      [...url.searchParams.keys()].some(key => key !== 't') || url.searchParams.getAll('t').length > 1 ||
      url.searchParams.has('t') && !/^\d{1,16}$/.test(url.searchParams.get('t')!))
    throw Error('MangaPill 正文图片归属无效。');
  return url.href;
}
export function readerWork(html: string, expected: MangapillLocation) {
  if (!expected.chapter) throw Error('MangaPill 章节地址无效。');
  const safe = inertHtml(html), modal = region(safe, 'div', a => a.id === 'js-chapter-selector-modal');
  const owner = one(tags(modal, 'a').filter(a => a['data-hotkey'] === 'm'), '章节作品');
  const actual = location(new URL(text(owner.href), origin).href);
  if (actual.work !== expected.work || actual.chapter) throw Error('MangaPill 章节作品归属错误。');
  const heading = textContent(region(modal, 'div', a => a.id === 'chapter-selector-modal-title'));
  if (!heading.endsWith(' Chapters')) throw Error('MangaPill 作品标题结构已变化。');
  const title = text(heading.slice(0, -' Chapters'.length));
  const chapterTitle = text(textContent(region(safe, 'h1', a => a.id === 'top')));
  if (!chapterTitle.startsWith(title + ' ')) throw Error('MangaPill 章节标题归属错误。');
  const fragment = one(tags(modal, 'include-fragment').filter(a => a.id === 'js-chapter-selector-fragment'), '当前章节身份');
  const identity = new URL(text(fragment.src), origin);
  if (identity.origin !== origin || identity.username || identity.password || identity.hash ||
      identity.pathname !== `/manga/${expected.work}/chapters` || identity.searchParams.get('current') !== expected.chapter ||
      identity.searchParams.getAll('current').length !== 1 || [...identity.searchParams.keys()].some(key => key !== 'current'))
    throw Error('MangaPill 当前章节身份错误。');
  return {title, chapterTitle};
}
