import {attributes} from '../../shared/html';
import {location, validId} from './definition';
import {invalid} from '../../shared/protobuf';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function label(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value.trim();
}
export function id(value: unknown): string {
  if (!(typeof value === 'string' || typeof value === 'number') || !validId(String(value))) throw invalid();
  return String(value);
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
export function sourceLocation(url: string) {
  const loc = location(new URL(url));
  if (!loc) throw invalid();
  return loc;
}
export function nextData(html: string, manga: string) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => attributes(' ' + match[1]).id === '__NEXT_DATA__');
  if (scripts.length !== 1) throw invalid();
  let data: Record<string, unknown>;
  try {data = object(JSON.parse(scripts[0][2]));} catch {throw invalid();}
  if (data.page !== '/manga/[mangaId]' || object(data.query).mangaId !== manga) throw invalid();
  return object(object(data.props).pageProps);
}
// The image service encodes uint32 source IDs using its own URL-safe base-64 alphabet.
export function imageId(id: string): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';
  let value = Number(id), result = '';
  do {result = alphabet[value % 64] + result; value = Math.floor(value / 64);} while (value);
  return result;
}
export function imageUrl(value: unknown, pattern: RegExp): URL {
  const raw = label(value, 8192), url = new URL(raw, 'https://img.comic-fuz.com');
  if (url.origin !== 'https://img.comic-fuz.com' || url.username || url.password || url.hash || !pattern.test(url.pathname)) throw invalid();
  return url;
}
export function cover(value: unknown) {
  // Cover asset IDs are independent of manga IDs; only the validated manga record supplies this field.
  return {url: imageUrl(value, /^\/c\/[\w-]+\/[\w-]+\.(?:webp|jpe?g|png)$/).href};
}
