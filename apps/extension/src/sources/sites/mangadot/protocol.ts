import type {SourceNetworkContext} from '../../contracts/network';
import {origin} from './definition';

export type JsonObject = Record<string, unknown>;
export function invalid(): never {throw Error('MangaDot 返回的数据不完整或格式已变化，请重试。');}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as JsonObject;
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value.trim();
}
export function count(value: unknown, max = 10000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function id(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 9999999999999) return invalid();
  return String(value);
}
export function number(value: unknown): number {
  if ((typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) && typeof value !== 'number') return invalid();
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 1000000) return invalid();
  return result;
}
export function language(value: unknown): string | undefined {
  if (value == null || value === '') return;
  const code = text(value, 80).toLowerCase();
  // MangaDot explicitly labels zh with the Chinese flag and zh-hk separately.
  try {return Intl.getCanonicalLocales(code === 'zh' ? 'zh-Hans' : code)[0] || invalid();} catch {return invalid();}
}
export function assetUrl(value: unknown, kind: 'cover' | 'page', mangaId?: string): string {
  const raw = text(value, 8192), url = new URL(raw, origin);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || /[%\\]/.test(raw) ||
      !(kind === 'cover' ? /^\/uploads\/[\w.-]+\.(?:webp|png|jpe?g|avif)$/i : new RegExp(`^/chapters/manga_${mangaId}/[\\w.-]+/[\\w.-]+\\.(?:webp|png|jpe?g|gif|avif)$`, 'i')).test(url.pathname)) return invalid();
  return url.href;
}
export async function request(path: string, referer: string, context: SourceNetworkContext): Promise<unknown> {
  context.signal?.throwIfAborted();
  const body = await context.request(origin + path, {referer});
  context.signal?.throwIfAborted();
  try {return JSON.parse(body);} catch {throw Error('MangaDot 未返回有效数据，请在源站完成验证后重试。');}
}
