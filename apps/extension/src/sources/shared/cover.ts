import {safeImageUrl} from './urls';

/** Missing/invalid optional artwork must not prevent reading the source catalog. */
export function sourceCover(value: unknown, base: string): {url: string} | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  const url = safeImageUrl(value, base);
  return url ? {url} : undefined;
}
