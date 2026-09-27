import type {ComicElement, CreateSourcePage, PageImage} from '../../contracts/page';
import {canvasImage} from '../../shared/canvas';
import {imageSession} from '../../shared/session';
import {catalogUrl, seriesKey} from './definition';
import {json, parseEpisode} from './protocol';
import {parsePages} from './pages';

export const createPage: CreateSourcePage = context => {
  let anchor: HTMLDivElement | undefined;
  let cached: {raw: string; value: ReturnType<typeof parsePages>} | undefined;
  const data = () => json(context.document.querySelector('#episode-json')?.getAttribute('data-value') ?? '');
  function targets(): PageImage[] {
    try {
      const raw = context.document.querySelector('#episode-json')?.getAttribute('data-value') ?? '';
      if (cached?.raw !== raw) cached = {raw, value: parsePages(json(raw), context.location.url)};
      const snapshot = cached.value;
      const areas = [...context.document.querySelectorAll('.js-viewer .js-viewer-content > p.js-page-area')];
      if (areas.length !== snapshot.items.length) return [];
      return areas.flatMap((area, index) => {
        const element = area.querySelector<ComicElement>('canvas.js-page-image, img.js-page-image');
        const item = snapshot.items[index];
        if (!element || item.resource.kind !== 'http') return [];
        const width = 'naturalWidth' in element ? element.naturalWidth : element.width;
        const height = 'naturalHeight' in element ? element.naturalHeight : element.height;
        if (width !== item.width || height !== item.height || 'complete' in element && !element.complete) return [];
        const key = `${item.id}:${item.resource.url}:${item.resource.processing ?? ''}`;
        // Public HTTP originals avoid the site's deliberately tainted display canvas.
        if (item.resource.processing) return [{element, key, url: item.resource.url}];
        const url = 'page-image:' + item.id;
        return [{element, key, url, read: async () => {
          const current = () => {
            context.signal.throwIfAborted();
            if (!element.isConnected || !session.inlineTargets().some(target => target.element === element && target.key === key))
              throw Error('SOURCE_RESOURCE_EXPIRED');
          };
          current();
          let canvas: HTMLCanvasElement;
          if ('naturalWidth' in element) {
            canvas = context.document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d'); if (!ctx) throw Error('SOURCE_RESOURCE_EXPIRED');
            ctx.drawImage(element, 0, 0);
          } else canvas = element;
          const blob = await canvasImage(canvas, context.signal); current(); return blob;
        }}];
      });
    } catch {return [];}
  }
  const session = imageSession(context, {
    attributes: ['data-value', 'data-json-url'], containers: '.js-viewer, #episode-json, .series-header', targets,
    snapshot: () => ({url: context.location.url, adapter: 'sundaywebry', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      try {
        const reader = parseEpisode(data(), context.location.url);
        return {status: 'ready', value: {title: reader.title, catalogId: seriesKey(reader.series), catalogUrl: catalogUrl(reader.series, reader.episode)}};
      } catch {return {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};}
    },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other' || !context.document.body) return null;
      if (!anchor?.isConnected) {
        anchor?.remove(); anchor = context.document.createElement('div');
        anchor.dataset.nodelaneWebryImport = '';
        anchor.style.cssText = 'position:fixed;inset:auto 16px 60px auto;max-width:calc(100vw - 32px);z-index:2147483000;';
        context.document.body.append(anchor);
      }
      return anchor;
    },
    dispose() {session.dispose(); anchor?.remove(); anchor = undefined; cached = undefined;},
  };
};
