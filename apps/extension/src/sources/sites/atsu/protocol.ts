import type {SourceNetworkContext} from '../../contracts/network';
import {cdnOrigin, identifier, origin} from './definition';

export function invalid(): never {throw Error('Atsumaru 返回的数据不完整或格式已变化，请重试。');}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, 64);
  return new RegExp('^' + identifier + '$').test(result) ? result : invalid();
}
export function count(value: unknown, max = 10000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function assetUrl(value: unknown, kind: 'cover' | 'page', mangaId?: string, chapterId?: string, scanlatorId?: string): string {
  const raw = text(value, 8192);
  if (/[\\%]/.test(raw)) return invalid();
  const path = raw.startsWith('https://') ? new URL(raw).pathname : raw.startsWith('/static/') ? raw : '/static/' + raw;
  const url = new URL(raw.startsWith('https://') ? raw : path, cdnOrigin);
  // New uploads use the scanlation namespace; older imported images use the manga namespace.
  // Inline DOM already binds the source chapter, but cannot expose its API-only scanlation ID.
  const owner = mangaId ? scanlatorId ? `(?:${mangaId}|${scanlatorId})` : mangaId : identifier;
  const pattern = kind === 'cover' ? /^\/static\/posters\/[A-Za-z0-9_-]+(?:-(?:small|medium|large))?\.(?:webp|png|jpe?g|avif)$/i :
    new RegExp(`^/static/pages/${owner}/${chapterId}/[A-Za-z0-9_-]+\\.(?:webp|png|jpe?g|avif|gif)$`);
  if (url.origin !== cdnOrigin || url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) return invalid();
  return url.href;
}
export async function request(path: string, referer: string, context: SourceNetworkContext): Promise<unknown> {
  context.signal?.throwIfAborted();
  const body = await context.request(origin + path, {referer});
  context.signal?.throwIfAborted();
  try {return JSON.parse(body);} catch {throw Error('Atsumaru 未返回有效数据，请在源站完成验证后重试。');}
}
