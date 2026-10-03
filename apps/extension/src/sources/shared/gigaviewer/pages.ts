import type {DiscoveredPage} from '../../contracts/source';

export const protocolChanged = () => Error('GigaViewer 阅读协议已变化，请回源确认后重试。');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolChanged();
  return value as Record<string, unknown>;
}

/** The caller owns URL/host identity; the engine only validates the common episode schema. */
export function gigaViewerProduct(value: unknown, episode: string, identify: (url: URL) => string | undefined) {
  const product = object(object(value).readableProduct);
  if (product.typeName !== 'episode' || product.id !== episode ||
      typeof product.permalink !== 'string' || product.permalink.length > 8192 ||
      identify(new URL(product.permalink)) !== episode) throw protocolChanged();
  return product;
}

/** Keep source row IDs (including gaps) and duplicate URLs. No host discovery or fetching. */
export function gigaViewerPages(value: unknown, pageUrl: (value: unknown) => string, processingPrefix = 'gigaviewer-baku') {
  const structure = object(value), rows = structure.pages;
  if (!Array.isArray(rows) || !rows.length || rows.length > 1600 ||
      !['rtl', 'ltr', 'ttb'].includes(String(structure.readingDirection)) ||
      ![undefined, null, '', 'usagi', 'baku'].includes(structure.choJuGiga as string)) throw protocolChanged();
  const items: DiscoveredPage[] = [];
  for (const [index, value] of rows.entries()) {
    const row = object(value);
    if (row.type !== 'main') {
      if (!['link', 'other', 'backMatter'].includes(String(row.type))) throw protocolChanged();
      continue;
    }
    const width = row.width as number, height = row.height as number;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || items.length >= 1500)
      throw protocolChanged();
    items.push({id: 'page-' + index, order: items.length, width, height,
      resource: {kind: 'http', url: pageUrl(row.src),
        ...(structure.choJuGiga === 'baku' ? {processing: `${processingPrefix}:${width}:${height}`} : {})}});
  }
  if (!items.length) throw protocolChanged();
  return {items, direction: structure.readingDirection === 'rtl' ? 'rtl' as const : 'ltr' as const};
}
