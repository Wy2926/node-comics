import {attributes, hasClass, tags, textContent} from '../../shared/html';
import {sourceCover} from '../../shared/cover';
import {mangaDnaLocation, origin, type MangaDnaLocation} from './definition';

export function one<T>(items: T[], label: string): T {
  if (items.length !== 1) throw Error(`MangaDNA ${label}缺失或重复。`);
  return items[0];
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('MangaDNA 页面数据无效。');
  return value.trim();
}
export function location(value: string): MangaDnaLocation {
  const loc = mangaDnaLocation(new URL(value, origin));
  if (!loc) throw Error('MangaDNA 来源地址无效。');
  return loc;
}
/** Inert, balanced server markup; no DOM globals or source script execution. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>, opening: string) => boolean) {
  type Region = {attrs: Record<string, string>; opening: string; body: string};
  const result: Region[] = [], stack: Array<{start: number; region?: Region}> = [];
  // Match closing tags once instead of rescanning the tail for each nested region.
  for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (/^<\//.test(token[0])) {
      const frame = stack.pop();
      if (frame?.region) frame.region.body = html.slice(frame.start, token.index);
      continue;
    }
    const attrs = attributes(token[0]);
    const region = select(attrs, token[0]) ? {attrs, opening: token[0], body: ''} : undefined;
    if (region) result.push(region);
    stack.push({start: token.index + token[0].length, region});
  }
  if (stack.some(frame => frame.region)) throw Error('MangaDNA 页面结构不完整。');
  return result;
}
export const byClass = (html: string, tag: string, name: string) =>
  one(regions(html, tag, attrs => !!hasClass(attrs, name)), name).body;
export function canonical(html: string, expected: MangaDnaLocation) {
  const actual = location(text(one(tags(html, 'link').filter(a => a.rel === 'canonical'), '页面身份').href));
  if (actual.slug !== expected.slug || actual.chapter !== expected.chapter) throw Error('MangaDNA 页面归属已变化。');
}
export function coverUrl(value: unknown) {
  const cover = sourceCover(value, origin);
  if (!cover) return;
  const url = new URL(cover.url);
  return url.origin === origin && !url.hash && !url.search && /^\/(?:thumbnails|manga)\/[^/]+\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname)
    ? cover : undefined;
}
export function imageSource(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^cdn\d+\.mangadna\.com$/.test(url.hostname) || url.port || url.username || url.password || url.hash || url.search ||
      !/^\/(?:uploads|chapters|online)\/\d+\/[^/%\\]+\/[^/%\\]+\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname))
    throw Error('MangaDNA 正文图片地址无效。');
  return url;
}
export const imageUrl = (value: string) => imageSource(value).href;
export const chapterNumber = (label: string) => /^Chapter (\d+(?:\.\d+)?)$/.exec(label)?.[1];
export function pageNumber(alt: string | undefined, heading: string) {
  if (!alt?.startsWith(heading + ' Page ')) return;
  const value = alt.slice(heading.length + 6), number = Number(value);
  return /^[1-9]\d{0,3}$/.test(value) && number <= 1500 ? number : undefined;
}
export function readerInfo(html: string, loc: MangaDnaLocation) {
  if (!loc.chapter) throw Error('MangaDNA 章节地址无效。');
  canonical(html, loc);
  const breadcrumbs = byClass(html, 'ol', 'breadcrumb');
  const links = regions(breadcrumbs, 'a', () => true);
  const parent = one(links.filter(link => {
    try {const owner = location(link.attrs.href); return !owner.chapter && owner.slug === loc.slug;} catch {return false;}
  }), '章节作品');
  one(links.filter(link => {
    try {const owner = location(link.attrs.href); return owner.chapter === loc.chapter && owner.slug === loc.slug;} catch {return false;}
  }), '当前章节');
  const title = text(textContent(parent.body)), headings = regions(html, 'h1', () => true);
  const chapterTitle = text(textContent(one(headings, '章节标题').body));
  const navigation = regions(html, 'select', a => !!hasClass(a, 'navi-change-chapter'));
  if (!navigation.length) throw Error('MangaDNA 章节导航缺失。');
  let label = '';
  for (const select of navigation) {
    const selected = regions(select.body, 'option', (_, opening) => /\sselected(?:\s|=|>)/i.test(opening));
    if (!selected.length) throw Error('MangaDNA 已选章节缺失。');
    // The site sometimes repeats an identical chapter-1 option, both selected.
    for (const row of selected) {
      label = text(textContent(row.body));
      if (row.attrs['data-c'] !== loc.chapter || chapterTitle !== title + ' - ' + label)
        throw Error('MangaDNA 当前章节身份不一致。');
    }
  }
  return {title, chapterTitle, label};
}
