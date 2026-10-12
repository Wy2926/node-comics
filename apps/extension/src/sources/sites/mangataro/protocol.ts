import type {SourceNetworkContext} from '../../contracts/network';
import {hasClass, inertHtml, tags} from '../../shared/html';
import {safeImageUrl} from '../../shared/urls';
import {catalogUrl, location, origin} from './definition';

export const invalid = (): never => {throw Error('MangaTaro 数据不完整、归属不符或结构已变化。');};
export function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.trim();
}
export function count(value: unknown, max = 10000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function remoteId(value: unknown): string {
  const id = typeof value === 'number' ? String(count(value, Number.MAX_SAFE_INTEGER)) : text(value, 16);
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) return invalid();
  return id;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function list(value: unknown, max = 500): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export const one = <T>(values: T[]): T => values.length === 1 ? values[0] : invalid();
export function sourceLocation(url: string) {return location(new URL(url)) ?? invalid();}
export function asset(value: unknown): string {
  const url = safeImageUrl(text(value, 8192), origin);
  return url ?? invalid();
}
export function parseDocument(html: string, url: string) {
  const loc = sourceLocation(url), safe = inertHtml(html), body = one(tags(safe, 'body'));
  const canonical = sourceLocation(text(one(tags(safe, 'link').filter(a => a.rel === 'canonical')).href, 2048));
  if (canonical.slug !== loc.slug || canonical.id !== loc.id || canonical.chapter !== loc.chapter) return invalid();
  return {loc, safe, body, mangaId: remoteId(body['data-manga-id'])};
}
export function parseWork(html: string, url: string) {
  const {loc, safe, mangaId} = parseDocument(html, url);
  if (loc.id) return invalid();
  const box = one(tags(safe, 'div').filter(a => hasClass(a, 'chapter-list')));
  if (remoteId(box['data-manga-id']) !== mangaId) return invalid();
  const info = one(tags(safe, 'button').filter(a => hasClass(a, 'add-to-library-btn')));
  if (remoteId(info['data-manga-id']) !== mangaId || info['data-manga-url'] !== catalogUrl(loc.slug)) return invalid();
  return {slug: loc.slug, mangaId, title: text(info['data-manga-title']), cover: {url: asset(info['data-manga-cover'])}};
}
export function parseReader(html: string, url: string) {
  const {loc, safe, body} = parseDocument(html, url);
  if (!loc.id || remoteId(body['data-chapter-id']) !== loc.id || body['data-chapter-number'] !== loc.chapter) return invalid();
  const owner = sourceLocation(text(one(tags(safe, 'a').filter(a => a.id === 'manga-info-link')).href, 2048));
  if (owner.id || owner.slug !== loc.slug) return invalid();
  const reader = one(tags(safe, 'div').filter(a => a.id === 'reader-media'));
  return {title: text(reader['data-chapter-title']), id: loc.id};
}
export async function request(url: string, context: SourceNetworkContext, referer: string, form?: Readonly<Record<string, string>>) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, {referer, ...(form ? {form} : {})});
  context.signal?.throwIfAborted();
  return body;
}
