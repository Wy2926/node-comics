import { msg } from '../../../i18n/runtime';
import type { CreateSourcePage, PageImage } from '../../contracts/page';
import { canvasImage } from '../../shared/canvas';
import { MAX_COMIC_IMAGES } from '../../shared/geometry';
import { imageSession } from '../../shared/session';

const pageSelector = '#comici-viewer #xCVPages > .-cv-page:not(.mode-empty)';
const pageElements = (doc: Document) =>
  [...doc.querySelectorAll<HTMLElement>(pageSelector)].filter((page) =>
    page.querySelector('.-cv-page-canvas'),
  );
export const createPage: CreateSourcePage = (context) => {
  const ids = new WeakMap<HTMLCanvasElement, string>();
  let versionObserver: MutationObserver | undefined;
  const revisions = (records: MutationRecord[]) => {
    let changed = false;
    for (const record of records) {
      const target = record.target as Element;
      if (
        record.attributeName === 'class' &&
        target.matches('.-cv-page') &&
        !!record.oldValue?.split(/\s+/).includes('mode-rendered') !==
          target.classList.contains('mode-rendered')
      ) {
        const canvas = target.querySelector<HTMLCanvasElement>('.-cv-page-canvas > canvas');
        if (canvas) {
          ids.delete(canvas);
          changed = true;
        }
      }
    }
    return changed;
  };
  function images(doc: Document): PageImage[] {
    revisions(versionObserver?.takeRecords() ?? []);
    const viewer = doc.querySelector('#comici-viewer'),
      episode = viewer?.getAttribute('data-comici-viewer-id');
    if (!episode) return [];
    return pageElements(doc)
      .slice(0, MAX_COMIC_IMAGES)
      .flatMap((page, order) => {
        const canvas = page.querySelector<HTMLCanvasElement>('.-cv-page-canvas > canvas');
        if (!page.classList.contains('mode-rendered') || !canvas || canvas.width < 80 || canvas.height < 80)
          return [];
        let id = ids.get(canvas);
        if (!id) {
          id = crypto.randomUUID();
          ids.set(canvas, id);
        }
        return [
          {
            element: canvas,
            key: `${episode}:${order}:${canvas.width}:${canvas.height}`,
            url: 'page-image:' + id,
            read: () => canvasImage(canvas, context.signal),
          },
        ];
      });
  }
  const session = imageSession(context, {
    attributes: ['data-comici-viewer-id'],
    containers: '#comici-viewer, .-cv-page',
    targets: () => images(context.document),
    snapshot() {
      const doc = context.document,
        url = context.location.url;
      const pages = pageElements(doc),
        rendered = images(doc);
      const items = rendered.map((image) => ({
        id: image.key.split(':').slice(0, 2).join(':'),
        resource: { kind: 'page' as const, resourceKey: image.url },
        width: image.element.width,
        height: image.element.height,
        order: pages.findIndex((page) => page.contains(image.element)),
      }));
      const knownTotal = pages.length || undefined,
        discoveryComplete = false;
      return {
        title: doc.title.slice(0, 160),
        url,
        adapter: 'comicpash',
        direction: 'rtl',
        items,
        knownTotal,
        discoveryComplete,
        note: msg(
          '已识别阅读器加载的 {0} / {1} 页；翻页后可刷新发现。导入前请保持来源页打开，图片清晰度以网站当前渲染为准。',
          { '0': items.length, '1': knownTotal ?? msg('未知') },
        ),
      };
    },
  });
  return {
    ...session,
    observe(changed) {
      const cleanup = session.observe!(changed);
      versionObserver = new MutationObserver((records) => {
        if (revisions(records)) changed();
      });
      versionObserver.observe(context.document.documentElement, {
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class'],
      });
      return () => {
        cleanup();
        versionObserver?.disconnect();
        versionObserver = undefined;
      };
    },
    dispose() {
      versionObserver?.disconnect();
      versionObserver = undefined;
      session.dispose();
    },
  };
};
