import type {SourceNetworkContext} from '../../contracts/network';
import {attributes} from '../../shared/html';
import {location, validSlug} from './definition';

export type Row = Record<string, unknown>;
export function invalid(): never {throw Error('ComicK 数据不完整或归属不一致，请在源站确认后重试。');}
export function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Row;
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.trim();
}
export function count(value: unknown, max = 10000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function hid(value: unknown): string {
  const result = text(value, 64);
  return /^[a-zA-Z0-9_-]+$/.test(result) ? result : invalid();
}
export function slug(value: unknown): string {
  const result = text(value);
  return validSlug(result) ? result : invalid();
}
export function numberLabel(value: unknown): string | null {
  if (value === null) return null;
  const result = typeof value === 'number' ? String(value) : text(value, 40);
  return /^-?\d+(?:\.\d+)?$/.test(result) ? result : invalid();
}
export function language(value: unknown): string {
  const code = text(value, 40);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) return invalid();
  try {return Intl.getCanonicalLocales(code)[0] || invalid();} catch {return invalid();}
}
export function sourceLocation(url: string) {return location(new URL(url)) ?? invalid();}
export function json(body: string): Row {
  try {return object(JSON.parse(body));} catch {return invalid();}
}
export function embedded(html: string, id: string): Row {
  const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => {const a = attributes(' ' + match[1]); return a.id === id && a.type === 'application/json';});
  return scripts.length === 1 ? json(scripts[0][2]) : invalid();
}
export async function request(url: string, context: SourceNetworkContext): Promise<string> {
  context.signal?.throwIfAborted();
  const body = await context.request(url);
  context.signal?.throwIfAborted();
  return body;
}
export function asset(value: unknown, work: string, directory: string): string {
  const raw = text(value, 8192), url = new URL(raw);
  if (!['https://cdn1.comicknew.pictures', 'https://cdn2.comicknew.pictures'].includes(url.origin) || url.username || url.password || url.search || url.hash || /[%\\]/.test(raw)) return invalid();
  const prefix = `/${work}/`, parts = url.pathname.slice(prefix.length).split('/');
  if (!url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9_-]+\.(?:webp|png|jpe?g|avif)$/i.test(parts.at(-1) ?? '')) return invalid();
  if (directory === 'covers') {
    if (parts.length !== 2 || parts[0] !== 'covers') return invalid();
  } else {
    const [numbers, lang] = directory.split('/'), expected = numbers.split('_');
    const actual = /^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(parts[0]);
    // Migrated image paths retain decimal suffixes (1.0) omitted from catalog labels (1).
    if (parts.length !== 4 || !actual || parts[1] !== lang || !/^[a-zA-Z0-9_-]+$/.test(parts[2]) ||
        actual.slice(1).some((value, i) => !Number.isFinite(Number(value)) || Number(value) !== Number(expected[i]))) return invalid();
  }
  return url.href;
}
export function cover(value: unknown, work: string) {return value == null ? undefined : {url: asset(value, work, 'covers')};}
