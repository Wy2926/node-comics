import { msg } from '../../../i18n/runtime';
import type { CreateSourcePage, PageImage } from '../../contracts/page';
import { canvasImage } from '../../shared/canvas';
import { MAX_COMIC_IMAGES } from '../../shared/geometry';
import { imageSession } from '../../shared/session';
import {comicpashLocation} from './definition';

const pageSelector = '#comici-viewer #xCVPages > .-cv-page:not(.mode-empty)';
const pageElements = (doc: Document) =>
  [...doc.querySelectorAll<HTMLElement>(pageSelector)].filter((page) =>
    page.querySelector('.-cv-page-canvas'),
  );
export const createPage: CreateSourcePage = (context) => {
  let ids = new WeakMap<HTMLCanvasElement, string>();
  let versionObserver: MutationObserver | undefined;
  const revisions = (records: MutationRecord[]) => {
    let changed = false;
    for (const record of records) {
      const target = record.target as Element;
      if (record.attributeName === 'data-comici-viewer-id') {
        ids = new WeakMap();
        changed = true;
      }
      if (record.attributeName === 'width' || record.attributeName === 'height') {
        ids.delete(target as HTMLCanvasElement);
        changed = true;
      }
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
        const key = `${episode}:${order}:${canvas.width}:${canvas.height}`;
        return [
          {
            element: canvas,
            key,
            url: 'page-image:' + id,
            read: async () => {
              const current = () => {
                context.signal.throwIfAborted();
                const target = session.inlineTargets().find(image => image.element === canvas);
                if (!canvas.isConnected || target?.url !== 'page-image:' + id ||
                  target.key !== key) throw Error('SOURCE_RESOURCE_EXPIRED');
              };
              current();
              const blob = await canvasImage(canvas, context.signal);
              current();
              return blob;
            },
          },
        ];
      });
  }
  const session = imageSession(context, {
    attributes: ['data-comici-viewer-id'],
    containers: '#comici-viewer, .-cv-page, .series-act, .episode-header',
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
    describeWork() {
      const catalog=context.location.catalog,doc=context.document;
      if(context.location.kind!=='catalog'||!catalog)return {status:'not-ready',code:'WORK_METADATA_UNAVAILABLE'};
      const canonical=doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
      const title=doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim();
      if(!canonical||comicpashLocation(new URL(canonical))?.seriesId!==comicpashLocation(new URL(catalog.url))?.seriesId||!title)
        return {status:'not-ready',code:'WORK_METADATA_UNAVAILABLE'};
      return {status:'ready',value:{title,catalogId:catalog.key,catalogUrl:catalog.url}};
    },
    // Full import uses HTTP; the snapshot above describes only the currently rendered inline window.
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() {
      session.snapshot();
      return context.location.kind === 'catalog' ? context.document.querySelector('.series-act') : null;
    },
    observe(changed) {
      const cleanup = session.observe!(changed);
      versionObserver = new MutationObserver((records) => {
        if (revisions(records)) changed();
      });
      versionObserver.observe(context.document.documentElement, {
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'width', 'height', 'data-comici-viewer-id'],
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
