import { msg } from '../../../i18n/runtime';
import type { DiscoveredPage, SourceSnapshot } from '../../contracts/source';
import { safeImageUrl } from '../../shared/urls';
export function discoverMangaCopyDocument(doc: Document, pageUrl: string): SourceSnapshot {
  const images = [...doc.querySelectorAll<HTMLImageElement>('.comicContent-list img')];
  const count = Number(doc.querySelector('.comicCount')?.textContent?.trim());
  const knownTotal = Number.isInteger(count) && count > 0 && count <= 10000 ? count : undefined;
  const items: DiscoveredPage[] = [];
  for (const [order, img] of images.entries()) {
    const url = safeImageUrl(img.getAttribute('data-src') ?? '', pageUrl);
    // Keep a stable prefix until a missing slot is resolved. Compacting gaps
    // would attach already saved page identities to a different image later.
    if (!url) break;
    const loaded = img.getAttribute('src') === img.getAttribute('data-src');
    items.push({
      id: `slot-${order}`,
      resource: { kind: 'http', url },
      width: loaded ? img.naturalWidth || 800 : 800,
      height: loaded ? img.naturalHeight || 1200 : 1200,
      order,
    });
  }
  const discoveryComplete = !!knownTotal && items.length === knownTotal && images.length === knownTotal;
  return {
    title: doc.title.split(' - ')[0],
    url: pageUrl,
    adapter: 'mangacopy',
    direction: 'rtl',
    knownTotal,
    discoveryComplete,
    note: discoveryComplete
      ? msg('漫画容器原图清单与总页数一致。')
      : msg('已发现 {0} / {1} 页，清单尚未完整。', { '0': items.length, '1': knownTotal ?? msg('未知') }),
    items,
  };
}
