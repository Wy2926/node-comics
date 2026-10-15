import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogUrl, origin, welomaLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`WeLoMa ${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value.trim()))
    throw Error('WeLoMa 页面数据无效。');
  return value.trim();
}
export function location(value: string) {
  const loc = welomaLocation(new URL(text(value), origin));
  if (!loc) throw Error('WeLoMa 来源地址无效。');
  return loc;
}
/** Balance selected containers only; unrelated malformed site markup is not parsed. */
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
  if (selected) throw Error('WeLoMa 页面结构不完整。');
  return result;
}
export const byClass = (html: string, tag: string, name: string) => one(regions(html, tag, a => !!hasClass(a, name)), name).body;
export const byId = (html: string, tag: string, id: string) => one(regions(html, tag, a => a.id === id), id).body;
export function decodeBase64(value: string) {
  if (!value || value.length > 12000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw Error('WeLoMa 编码数据无效。');
  try {return text(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))));}
  catch {throw Error('WeLoMa 编码数据无效。');}
}
export function label(row: {attrs: Record<string, string>; body: string}) {
  return row.attrs['data-enc'] === undefined ? text(textContent(row.body)) : decodeBase64(row.attrs['data-enc']);
}
export function imageUrl(value: string) {
  const url = new URL(text(value), origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('WeLoMa 图片地址无效。');
  return url.href;
}
/** The source emits its current URL in login-return literals, but no canonical link.
 * Read only those literals, never execute downloaded scripts or authentication actions. */
export function responseLocation(html: string, url: string) {
  const expected = location(url), scripts = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  const returns = [...scripts].flatMap(script => [...script[1].matchAll(/window\.location\.href\s*=\s*['"]([^'"<>]+)['"]/g)]);
  if (!returns.length || returns.some(match => {
    const actual = location(match[1]); return actual.chapter !== expected.chapter || actual.work !== (expected.chapter ? undefined : expected.work);
  })) throw Error('WeLoMa 页面归属错误。');
  return expected;
}
export function readerInfo(html: string, url: string) {
  const loc = responseLocation(html, url), safe = inertHtml(html);
  if (!loc.chapter) throw Error('WeLoMa 章节地址无效。');
  const links = tags(byClass(safe, 'ol', 'breadcrumb'), 'a').map(a => {
    const target = new URL(text(a.href), origin); return {attrs: a, loc: welomaLocation(target)};
  });
  const owner = one(links.filter(a => a.loc?.work && !a.loc.chapter), '所属作品').loc!;
  const current = one(links.filter(a => a.loc?.chapter), '当前章节').loc!;
  if (current.chapter !== loc.chapter || current.work && current.work !== owner.work || loc.work && loc.work !== owner.work)
    throw Error('WeLoMa 章节或作品归属错误。');
  return {safe, catalogUrl: catalogUrl(owner.work!), title: label(one(regions(safe, 'h1', () => true), '章节标题'))};
}
