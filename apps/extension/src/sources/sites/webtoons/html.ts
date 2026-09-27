import {attributes, hasClass, tags, textContent} from '../../shared/html';
import {location} from './definition';

export const unavailable = () => Error('WEBTOON 页面不完整或不可访问，请在源站确认登录、年龄验证、付费或 App 阅读限制。');
export function requireLocation(url: string) {
  const loc = location(new URL(url));
  if (!loc) throw unavailable();
  return loc;
}
export function meta(html: string, key: string) {
  return tags(html, 'meta').find(a => a.property === key)?.content;
}
export function ownership(html: string, url: string) {
  const expected = requireLocation(url), actual = requireLocation(meta(html, 'og:url') ?? 'about:blank');
  if (actual.key !== expected.key || actual.episode !== expected.episode) throw unavailable();
  return expected;
}
/** Only bounded server-rendered collections prove completeness; nested containers fail closed. */
export function block(html: string, tag: string, attribute: string, value: string) {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))]
    .filter(m => attribute === 'class' ? hasClass(attributes(' ' + m[1]), value) : attributes(' ' + m[1])[attribute] === value);
  if (matches.length !== 1) throw unavailable();
  const tail = html.slice(matches[0].index! + matches[0][0].length), end = new RegExp(`<\\/${tag}\\s*>`, 'i').exec(tail);
  if (!end || new RegExp(`<${tag}\\b`, 'i').test(tail.slice(0, end.index))) throw unavailable();
  return tail.slice(0, end.index);
}
export function label(html: string, name: string) {
  const match = [...html.matchAll(/<(span|strong|div|p)\b([^>]*)>/gi)]
    .find(m => hasClass(attributes(' ' + m[2]), name));
  if (!match) return '';
  const tail = html.slice(match.index! + match[0].length), end = tail.search(new RegExp(`<\\/${match[1]}\\s*>`, 'i'));
  return end < 0 ? '' : textContent(tail.slice(0, end));
}
export function imageUrl(raw: string | undefined) {
  if (!raw) throw unavailable();
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !['webtoon-phinf.pstatic.net', 'swebtoon-phinf.pstatic.net'].includes(url.hostname)) throw unavailable();
  return url.href;
}
