import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogUrl, chapterKey, chapterUrl, isKlOrigin, klLocation, origin} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`KLManga ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('KLManga 页面数据无效。');
  return value.trim();
}
export function location(url: string) {
  const loc = klLocation(new URL(url));
  if (!loc) throw Error('KLManga 来源地址无效。');
  return loc;
}
/** Walk matching tags once; preserve nested markup without a DOM or downloaded scripts. */
export function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
  const result: Array<{attrs: Record<string, string>; body: string; index: number; opening: string}> = [];
  const stack: Array<{attrs: Record<string, string>; start: number; index: number; selected: boolean; opening: string}> = [];
  for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (!/^<\//.test(token[0])) {
      const attrs = attributes(token[0]);
      stack.push({attrs, start: token.index! + token[0].length, index: token.index!, selected: select(attrs), opening: token[0]});
    } else {
      const open = stack.pop();
      if (!open) throw Error('KLManga 页面结构不完整。');
      if (open.selected) result.push({attrs: open.attrs, body: html.slice(open.start, token.index), index: open.index, opening: open.opening});
    }
  }
  if (stack.length) throw Error('KLManga 页面结构不完整。');
  return result.sort((a, b) => a.index - b.index);
}
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export function coverUrl(value: unknown): {url: string} | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (!isKlOrigin(url) || url.hash || url.search ||
      !/^\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+\.(?:webp|png|jpe?g|avif)$/i.test(url.pathname)) return;
    return {url: url.href};
  } catch {return;}
}
export function imageUrl(value: string): string {
  const url = new URL(value);
  if (url.origin === 'https://placehold.co' && url.pathname === '/800x250/png' &&
    /^Fail Image [1-9]\d{0,3}$/.test(url.searchParams.get('text') ?? ''))
    throw Error('KLManga 源站返回“Fail Image”占位图，未提供正文原图；请稍后重试或在源站检查当前章节。');
  if (url.protocol !== 'https:' || url.hostname !== 'p1.pubg-img.si' || !['', '183'].includes(url.port) ||
    url.username || url.password || url.hash || url.search || !/^\/d\/[a-z0-9]+\/[^/]+$/i.test(url.pathname))
    throw Error('KLManga 正文图片地址无效。');
  return url.href;
}
export function canonicalLocation(safe: string, url: string) {
  const expected = location(url), canonical = one(tags(safe, 'link').filter(a => a.rel === 'canonical'), '页面身份');
  const actual = location(new URL(text(canonical.href), origin).href);
  if (actual.slug !== expected.slug || actual.chapter !== expected.chapter) throw Error('KLManga 页面归属已变化。');
  return expected;
}
export function readerInfo(html: string, url: string) {
  const safe = inertHtml(html), loc = canonicalLocation(safe, url);
  if (!loc.chapter) throw Error('KLManga 章节地址无效。');
  const breadcrumb = byClass(safe, 'ol', 'breadcrumb');
  const owners = tags(breadcrumb, 'a').filter(a => {
    const owner = klLocation(new URL(a.href || '', origin));
    return owner && !owner.chapter;
  });
  const owner = location(new URL(text(one(owners, '所属作品').href), origin).href);
  if (owner.slug !== loc.slug) throw Error('KLManga 章节作品归属错误。');
  const list = byClass(safe, 'select', 'single-chapter-select');
  const current = regions(list, 'option', () => true).filter(option => /\sselected(?:\s|=|>)/i.test(option.opening));
  const entry = one(current, '当前目录章节');
  const selected = klLocation(new URL(text(entry.attrs['data-redirect']), origin));
  if (!selected?.chapter || chapterKey(selected) !== chapterKey(loc) || entry.attrs.value !== loc.chapter)
    throw Error('KLManga 当前章节身份无效。');
  const chapterTitle = text(textContent(entry.body));
  if (text(textContent(byClass(breadcrumb, 'li', 'active'))) !== chapterTitle)
    throw Error('KLManga 当前章节标题不一致。');
  const settings = one(regions(html, 'script', a => a.id === 'custom.js-js-extra'), '公开读取设置').body;
  const match = /\bvar\s+zing\s*=\s*(\{[^;]*\})\s*;/.exec(settings);
  let config: {home_url?: unknown; ajax_url?: unknown};
  try {config = JSON.parse(match?.[1] ?? '');} catch {throw Error('KLManga 读取设置无效。');}
  if (!config || config.home_url !== origin || config.ajax_url !== origin + '/wp-admin/admin-ajax.php')
    throw Error('KLManga 读取协议已变化。');
  const scripts = regions(html, 'script', a => !a.src).filter(s => /_action\s*:\s*['"]decode_images['"]/.test(s.body));
  const chapterId = /\breading_chapter\s*:\s*([1-9]\d{0,12})\s*,/.exec(one(scripts, '正文读取参数').body)?.[1];
  if (!chapterId) throw Error('KLManga 章节读取身份缺失。');
  return {slug: loc.slug, chapter: loc.chapter, chapterId, chapterTitle,
    catalogUrl: catalogUrl(loc.slug), sourceUrl: chapterUrl(loc)};
}
