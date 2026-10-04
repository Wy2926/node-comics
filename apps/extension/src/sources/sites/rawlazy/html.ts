import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {boundChapterLocation, catalogUrl, chapterUrl, origin, rawLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`RawLazy ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw Error('RawLazy 页面数据无效。');
  return value.trim();
}
export function location(url: string) {
  const loc = rawLocation(new URL(url));
  if (!loc) throw Error('RawLazy 来源地址无效。');
  return loc;
}
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
    if (depth) throw Error('RawLazy 页面结构不完整。');
    result.push({attrs, body: html.slice(token.index! + token[0].length, tokens[end].index)});
  }
  return result;
}
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export function coverUrl(value: unknown): {url: string} | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash || url.search ||
      !/^\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+\.(?:webp|png|jpe?g|avif)$/i.test(url.pathname)) return;
    return {url: url.href};
  } catch {return;}
}
export function imageUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'p1.pubg-img.si' || !['', '183'].includes(url.port) ||
    url.username || url.password || url.hash || url.search || !/^\/d\/[a-z0-9]+\/[^/]+$/i.test(url.pathname))
    throw Error('RawLazy 正文图片地址无效。');
  return url.href;
}
export function catalogIdentity(safe: string, url: string) {
  const loc = location(url);
  if (!loc.catalogSlug || loc.chapterSlug) throw Error('请使用 RawLazy 作品详情页链接。');
  const canonical = one(tags(safe, 'link').filter(a => a.rel === 'canonical'), '作品身份');
  const actual = location(new URL(text(canonical.href), origin).href);
  if (actual.chapterSlug || actual.catalogSlug !== loc.catalogSlug) throw Error('RawLazy 作品归属已变化。');
  return loc.catalogSlug;
}
export function readerInfo(html: string, url: string) {
  const loc = location(url);
  if (!loc.chapterSlug) throw Error('RawLazy 章节地址无效。');
  const safe = inertHtml(html), identity = one(tags(safe, 'meta').filter(a => a.property === 'og:url'), '章节身份');
  const owner = byClass(safe, 'div', 'manga-name'), link = one(tags(owner, 'a'), '所属作品');
  const parent = location(new URL(text(link.href), origin).href);
  if (!parent.catalogSlug || parent.chapterSlug || loc.catalogSlug && loc.catalogSlug !== parent.catalogSlug)
    throw Error('RawLazy 章节作品归属错误。');
  const actual = boundChapterLocation(new URL(text(identity.content), origin), parent.catalogSlug);
  if (actual?.chapterSlug !== loc.chapterSlug) throw Error('RawLazy 章节身份已变化。');
  const chapters = byClass(safe, 'div', 'chapters-list');
  const current = regions(chapters, 'a', a => {
    const item = boundChapterLocation(new URL(a.href || '', origin), parent.catalogSlug!);
    return item?.chapterSlug === loc.chapterSlug;
  });
  const row = one(current, '当前目录章节');
  const chapterTitle = text(textContent(byClass(row.body, 'span', 'font-bold')));
  const title = text(textContent(owner));
  const settings = one(regions(html, 'script', a => a.id === 'custom.js-js-extra'), '公开读取设置').body;
  const match = /\bvar\s+zing\s*=\s*(\{[^;]*\})\s*;/.exec(settings);
  let config: {home_url?: unknown; ajax_url?: unknown; nonce?: unknown};
  try {config = JSON.parse(match?.[1] ?? '');} catch {throw Error('RawLazy 读取设置无效。');}
  if (!config || config.home_url !== origin || config.ajax_url !== origin + '/wp-admin/admin-ajax.php' ||
    typeof config.nonce !== 'string' || !/^[a-f0-9]{10}$/.test(config.nonce)) throw Error('RawLazy 读取协议已变化。');
  const readScripts = regions(html, 'script', a => !a.src).filter(s => /_action\s*:\s*['"]decode_images['"]/.test(s.body));
  const postId = /\bp\s*:\s*([1-9]\d{0,12})\s*,/.exec(one(readScripts, '正文读取参数').body)?.[1];
  if (!postId) throw Error('RawLazy 章节读取身份缺失。');
  return {catalogSlug: parent.catalogSlug, title, chapterTitle, postId, nonce: config.nonce,
    catalogUrl: catalogUrl(parent.catalogSlug), sourceUrl: chapterUrl(loc.chapterSlug)};
}
