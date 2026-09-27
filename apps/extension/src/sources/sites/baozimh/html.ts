import {attributes, hasClass, tags, textContent} from '../../shared/html';
import {baoLocation} from './definition';

export const changed = () => Error('包子漫画页面不完整或结构已变化，请在源站确认作品和章节可访问后重试。');
export function one<T>(values: T[]): T {if (values.length !== 1) throw changed(); return values[0];}
export function text(value: string | undefined) {
  const result = value?.trim();
  if (!result || result.length > 2048) throw changed();
  return result;
}
export function location(url: string) {
  const value = baoLocation(new URL(url));
  if (!value) throw changed();
  return value;
}
/** Extract bounded, balanced server-rendered containers, including hidden catalog rows. */
export function blocks(html: string, tag: string, attribute: 'id' | 'class', value: string) {
  const tokens = [...html.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'))];
  return tokens.flatMap((open, i) => {
    if (open[1]) return [];
    const attrs = attributes(open[0]);
    if (!(attribute === 'id' ? attrs.id === value : hasClass(attrs, value))) return [];
    let depth = 1;
    for (let j = i + 1; j < tokens.length; j++) {
      depth += tokens[j][1] ? -1 : 1;
      if (!depth) return [html.slice(open.index! + open[0].length, tokens[j].index)];
    }
    throw changed();
  });
}
export const label = (html: string, tag: string, name: string) => text(textContent(one(blocks(html, tag, 'class', name))));
export function ownership(html: string, url: string) {
  const expected = location(url), canonical = one(tags(html, 'link').filter(a => a.rel === 'canonical'));
  const actual = location(text(canonical.href));
  if (expected.comic !== actual.comic || expected.chapter !== actual.chapter || expected.section !== actual.section || expected.part !== actual.part) throw changed();
  if (expected.chapter !== undefined) {
    const parent = one(tags(html, 'a').filter(a => hasClass(a, 'goto')));
    const owner = location(text(parent.href));
    if (owner.comic !== expected.comic || owner.chapter !== undefined) throw changed();
  }
  return expected;
}
export function imageUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9-]+\.bzcdn\.net$/.test(url.hostname) || !/^\/scomic\/[a-z0-9_-]+\/\d+\/[^/]+\/[^/]+\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname)) throw changed();
  return url.href;
}
export function coverUrl(raw: string | undefined, comic: string) {
  if (!raw?.trim()) return;
  const url = new URL(raw);
  if (url.origin !== 'https://static-tw.baozimh.com' || url.username || url.password) throw changed();
  if (['/cover/unknown', '/cover/default_cover.png'].includes(url.pathname)) return;
  if (url.pathname !== `/cover/${comic}.jpg`) throw changed();
  return {url: url.href};
}
