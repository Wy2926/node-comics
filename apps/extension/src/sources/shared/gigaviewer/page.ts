import type {ComicElement, PageImage, SourcePageContext} from '../../contracts/page';
import type {SourceSnapshot} from '../../contracts/source';
import {canvasImage} from '../canvas';
import {imageSession} from '../session';

/** Common GigaViewer DOM protocol, used only after a site has explicitly claimed its URL. */
export function gigaViewerPage(context: SourcePageContext, parsePages: (value: unknown, url: string) => SourceSnapshot) {
  let cached: {raw: string; value?: SourceSnapshot} | undefined;
  function targets(): PageImage[] {
    const raw = context.document.querySelector('#episode-json')?.getAttribute('data-value') ?? '';
    if (cached?.raw !== raw) {
      // Cache invalid metadata as well: a waiting/unsupported page must not be parsed on every scan.
      cached = {raw};
      try {if (raw.length <= 4_000_000) cached.value = parsePages(JSON.parse(raw), context.location.url);} catch { /* Not ready. */ }
    }
    const snapshot = cached.value;
    if (!snapshot) return [];
    const areas = context.document.querySelectorAll('.js-viewer .js-viewer-content > p.js-page-area');
    if (areas.length !== snapshot.items.length) return [];
    return [...areas].flatMap((area, index) => {
      const element = area.querySelector<ComicElement>('canvas.js-page-image, img.js-page-image');
      const item = snapshot.items[index];
      if (!element || !element.isConnected || item.resource.kind !== 'http') return [];
      const width = 'naturalWidth' in element ? element.naturalWidth : element.width;
      const height = 'naturalHeight' in element ? element.naturalHeight : element.height;
      if (width !== item.width || height !== item.height || 'complete' in element && !element.complete) return [];
      const key = `${item.id}:${item.resource.url}:${item.resource.processing ?? ''}`;
      // Exporting the displayed canvas may throw SecurityError. Read/restore the mapped HTTP original instead.
      if (item.resource.processing) return [{element, key, url: item.resource.url}];
      return [{element, key, url: 'page-image:' + item.id, read: async () => {
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
  }
  const session = imageSession(context, {
    attributes: ['data-value', 'data-json-url'], containers: '.js-viewer, #episode-json', targets,
    snapshot: () => ({url: context.location.url, adapter: context.location.sourceId, title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported' as const, code: 'SOURCE_PAGE_UNSUPPORTED'};},
    dispose() {session.dispose(); cached = undefined;},
  };
}
