import {attributes, hasClass, tags} from '../../shared/html';
import {jfLocation, origin, type JfLocation} from './definition';

export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`漫画猫${label}缺失或重复。`);
  return values[0];
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw Error('漫画猫页面数据无效。');
  return value.trim();
}
export function location(url: string): JfLocation {
  const value = jfLocation(new URL(url));
  if (!value) throw Error('漫画猫来源地址无效。');
  return value;
}
// Reader SEO links omit the scheme; this exact prefix is present in source markup.
export function sourceUrl(value: string) {
  return new URL(value.startsWith('www.00jf.com/') ? 'https://' + value : value, origin).href;
}
export function canonical(html: string, expected: JfLocation) {
  const link = one(tags(html, 'link').filter(a => a.rel === 'canonical'), '页面身份');
  const actual = location(sourceUrl(text(link.href)));
  if (actual.comic !== expected.comic || actual.chapter !== expected.chapter) throw Error('漫画猫页面归属已变化。');
}
/** Source-specific nested div extraction; accepts only a single closed matching region. */
export function div(html: string, name: string, byId = false): string {
  const tokens = [...html.matchAll(/<\/?div\b[^>]*>/gi)];
  const selected = tokens.map((token, index) => ({token, index})).filter(({token}) =>
    !/^<\//.test(token[0]) && (byId ? attributes(token[0]).id === name : hasClass(attributes(token[0]), name)));
  const {token, index} = one(selected, name);
  let depth = 1;
  for (let i = index + 1; i < tokens.length; i++) {
    depth += /^<\//.test(tokens[i][0]) ? -1 : 1;
    if (depth === 0) return html.slice(token.index! + token[0].length, tokens[i].index);
  }
  throw Error('漫画猫页面结构不完整。');
}
export function coverUrl(value: unknown): {url: string} | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !(url.hostname === 'comic.5um.net' && /^\/comic\/cover\/[^/]+\.(?:webp|jpe?g|png)$/i.test(url.pathname) ||
        url.hostname === 'manga.5um.net' && /^\/prod\/\d+\/\d+\/[^/]+\.(?:webp|jpe?g|png)$/i.test(url.pathname))) return;
    return {url: url.href};
  } catch {return;}
}
export function imageUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !(url.hostname === 'manhua.5um.net' && /^\/colatj\/[^/]+\/[^/]+\/[^/]+\.(?:webp|jpe?g|png)$/i.test(url.pathname) ||
      url.hostname === 'manga.5um.net' && /^\/prod\/\d+\/\d+\/\d+\/[^/]+\.(?:webp|jpe?g|png)$/i.test(url.pathname)))
    throw Error('漫画猫正文图片地址无效。');
  return url.href;
}
export function readerWork(html: string, expected: JfLocation) {
  const structured = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => attributes(' ' + m[1]).type === 'application/ld+json').map(m => JSON.parse(m[2]) as Record<string, unknown>);
  const breadcrumb = one(structured.filter(row => row['@type'] === 'BreadcrumbList'), '章节作品信息');
  const rows = breadcrumb.itemListElement;
  if (!Array.isArray(rows) || rows.length !== 3) throw Error('漫画猫章节作品信息无效。');
  const owner = rows[1] as Record<string, unknown>, entry = rows[2] as Record<string, unknown>;
  if (!owner || !entry || owner.position !== 2 || entry.position !== 3 || owner['@type'] !== 'ListItem' || entry['@type'] !== 'ListItem')
    throw Error('漫画猫章节作品信息无效。');
  const a = location(sourceUrl(text(owner.item))), b = location(sourceUrl(text(entry.item)));
  if (a.comic !== expected.comic || a.chapter || b.comic !== expected.comic || b.chapter !== expected.chapter)
    throw Error('漫画猫章节不属于当前作品。');
  return {title: text(owner.name), chapterTitle: text(entry.name)};
}
