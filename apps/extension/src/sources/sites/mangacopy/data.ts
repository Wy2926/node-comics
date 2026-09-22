import { msg } from '../../../i18n/runtime';
import { SourceError } from '../../contracts/diagnostics';
import type { DiscoveredPage } from '../../contracts/source';
import { safeImageUrl } from '../../shared/urls';
import { discoverMangaCopyDocument as discoverDocument } from './pages';

/** The site's reader decrypts contentKey with cct, then appends that ordered
 * array to the DOM. Read the same inline data without running page-provided code.
 */
export async function readMangaCopyData(doc: Document, pageUrl: string) {
  const before = discoverDocument(doc, pageUrl);
  const scripts = [...doc.querySelectorAll<HTMLScriptElement>('script:not([src])')];
  const data = scripts
    .map((script) => {
      const source = script.textContent ?? '';
      const key = source.match(/\bvar\s+contentKey\s*=\s*(["'])([^"'\\\r\n]*)\1\s*;/)?.[2];
      const secret = source.match(/\bvar\s+cct\s*=\s*(["'])([^"'\\\r\n]*)\1\s*;/)?.[2];
      return key && secret ? { key, secret } : null;
    })
    .filter((value) => value !== null);
  if (!data.length) return before;
  if (data.length !== 1) throw new SourceError('SOURCE_DATA_AMBIGUOUS');
  const { key, secret } = data[0],
    encoder = new TextEncoder(),
    rawKey = encoder.encode(secret),
    iv = encoder.encode(key.slice(0, 16)),
    hex = key.slice(16);
  if (
    ![16, 24, 32].includes(rawKey.length) ||
    iv.length !== 16 ||
    !hex.length ||
    hex.length > 8 * 1024 * 1024 ||
    hex.length % 32 ||
    !/^[a-f\d]+$/i.test(hex)
  )
    throw new SourceError('SOURCE_DATA_FORMAT');
  let decoded: unknown;
  try {
    const aes = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt']);
    const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aes, bytes);
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new SourceError('SOURCE_DATA_DECODE');
  }
  if (!Array.isArray(decoded) || !decoded.length || decoded.length > 10000)
    throw new SourceError('SOURCE_PAGES_INVALID');
  if (before.knownTotal && decoded.length !== before.knownTotal)
    throw new SourceError('SOURCE_TOTAL_MISMATCH');
  const items: DiscoveredPage[] = decoded.map((value: unknown, order) => {
    const raw = value && typeof value === 'object' && 'url' in value ? value.url : undefined;
    const url = typeof raw === 'string' ? safeImageUrl(raw, pageUrl) : null;
    if (!url) throw new SourceError('SOURCE_IMAGE_URL_INVALID');
    return { id: `slot-${order}`, resource: { kind: 'http', url }, order, width: 800, height: 1200 };
  });
  // Cross-check every currently rendered slot before assigning stable page IDs.
  const images = [...doc.querySelectorAll<HTMLImageElement>('.comicContent-list img')];
  if (images.length > items.length) throw new SourceError('SOURCE_PAGE_COUNT_MISMATCH');
  for (const [index, img] of images.entries()) {
    const url = safeImageUrl(img.getAttribute('data-src') ?? '', pageUrl);
    if (url && url !== (items[index].resource as { url: string }).url)
      throw new SourceError('SOURCE_PAGE_ORDER_MISMATCH');
    const known = before.items[index];
    if (
      (known?.resource as { url?: string } | undefined)?.url ===
      (items[index].resource as { url: string }).url
    ) {
      items[index].width = known.width;
      items[index].height = known.height;
    }
  }
  return {
    ...before,
    items,
    knownTotal: items.length,
    discoveryComplete: true,
    note: msg('已读取网页 JS 的完整有序图片清单，并核对已显示图片；原图下载进度单独记录。'),
  };
}
