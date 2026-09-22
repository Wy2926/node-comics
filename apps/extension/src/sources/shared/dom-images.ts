import { msg } from '../../i18n/runtime';
import type { PageImage } from '../contracts/page';
import type { DiscoveredPage, SourceSnapshot } from '../contracts/source';
import { comicImageRect, MAX_COMIC_IMAGES } from './geometry';
import { safeImageUrl } from './urls';
export function imageDiscovery(
  doc: Document,
  pageUrl: string,
  options = { id: 'generic', selector: 'img', singlePage: false },
) {
  let previous: Array<{ element: HTMLImageElement; id: string; url: string }> = [];
  return (): SourceSnapshot => {
    const { id, selector, singlePage } = options,
      generic = !singlePage;
    const found: Array<{ element: HTMLImageElement; url: string; width: number; height: number }> = [];
    for (const img of doc.querySelectorAll<HTMLImageElement>(selector)) {
      if (generic && !comicImageRect(img)) continue;
      const url = (
        generic
          ? [img.currentSrc || img.src]
          : [img.dataset.src, img.dataset.original, img.currentSrc, img.src]
      )
        .map((src) => safeImageUrl(src ?? '', pageUrl))
        .find(Boolean);
      if (!url) continue;
      const loaded = safeImageUrl(img.currentSrc || img.src || '', pageUrl) === url;
      const width = loaded ? img.naturalWidth || Number(img.width) || 0 : 0,
        height = loaded ? img.naturalHeight || Number(img.height) || 0 : 0;
      found.push({ element: img, url, width, height });
      if (found.length >= MAX_COMIC_IMAGES) break;
    }
    // Reserve surviving elements first, so newly mounted duplicates cannot steal
    // their identity. Reconcile replaced elements by URL and occurrence order.
    const byElement = new Map(previous.map((slot) => [slot.element, slot]));
    const retained = new Map(
      found.flatMap((item) => {
        const slot = byElement.get(item.element);
        return slot?.url === item.url ? [[item.element, slot] as const] : [];
      }),
    );
    const used = new Set([...retained.values()].map((slot) => slot.id));
    const reusable = new Map<string, typeof previous>();
    for (const slot of [...previous].reverse()) {
      if (used.has(slot.id)) continue;
      const group = reusable.get(slot.url) ?? [];
      group.push(slot);
      reusable.set(slot.url, group);
    }
    previous = [];
    const items: DiscoveredPage[] = found.map(({ element, url, width, height }, order) => {
      const slot = retained.get(element) ?? reusable.get(url)?.pop();
      const id = slot?.id ?? crypto.randomUUID();
      previous.push({ element, url, id });
      return { id, resource: { kind: 'http', url }, width, height, order };
    });
    return {
      title: doc.title.slice(0, 160) || msg('未命名漫画'),
      url: pageUrl,
      adapter: id,
      direction: singlePage ? 'ltr' : 'rtl',
      discoveryComplete: singlePage && items.length === 1,
      knownTotal: singlePage && items.length === 1 ? 1 : undefined,
      note: singlePage
        ? msg('仅当前一期／当前漫画页，不包括前后章节。')
        : msg('按标签页翻译规则发现已加载的网页大图；滚动原网页后可刷新补充，仅支持 HTTP(S) 原图导入。{0}', {
            '0': items.length >= MAX_COMIC_IMAGES ? msg('已达到单次 1500 张上限。') : '',
          }),
      items,
    };
  };
}
/** Enumeration only; discovery and inline use the same site-selected elements. */
export function renderedImages(doc: Document, url: string, selector = 'img'): PageImage[] {
  return [...doc.querySelectorAll<HTMLImageElement>(selector)].flatMap((element) => {
    const raw = element.currentSrc || element.src;
    const source =
      (raw.startsWith('blob:') && new URL(raw).origin === new URL(url).origin) ||
      /^data:image\/(?:png|jpeg|webp|gif|avif);/i.test(raw)
        ? raw
        : safeImageUrl(raw, url);
    return source ? [{ element, key: source, url: source }] : [];
  });
}
