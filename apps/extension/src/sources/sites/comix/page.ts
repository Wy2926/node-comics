import type {ComicElement,CreateSourcePage,PageImage} from '../../contracts/page';
import {canvasImage} from '../../shared/canvas';
import {renderedImages} from '../../shared/dom-images';
import {MAX_COMIC_IMAGES} from '../../shared/geometry';
import {imageSession} from '../../shared/session';

const catalogAnchor = '.mpage__actions';
const readerAnchor = '.rpage-floatctl';
// Long strips and paginated spreads have different inner wrappers, but share rpage-main.
const pageSelector = '.rpage-main .rpage-page[data-page]';
/** DOM supplies displayed originals for inline translation; full chapter acquisition stays on HTTP. */
export const createPage: CreateSourcePage = context => {
  const versions = new WeakMap<ComicElement,string>();
  let observer: MutationObserver | undefined;
  const revisions = (records: MutationRecord[]) => {
    let changed = false;
    for (const record of records) {
      const target = record.target as Element;
      if ((record.attributeName === 'class' || record.attributeName === 'data-page') && target.matches('.rpage-page')) {
        // A canvas can finish loading or redraw without changing element/URL/dimensions.
        const before = /(?:^|\s)is-(?:loading|errored)(?:\s|$)/.test(record.oldValue ?? '');
        const after = target.matches('.is-loading, .is-errored');
        if (record.attributeName === 'class' && before === after) continue;
        const element = target.querySelector<ComicElement>(':scope > .rpage-page__img');
        if (element) versions.delete(element);
        changed = true;
      } else if (record.attributeName === 'width' || record.attributeName === 'height') {
        versions.delete(target as ComicElement);
        changed = true;
      }
    }
    return changed;
  };
  function images(): PageImage[] {
    revisions(observer?.takeRecords() ?? []);
    const doc = context.document;
    const ordinary = new Map(renderedImages(doc, context.location.url,
      `${pageSelector} > img.rpage-page__img`).map(image => [image.element, image]));
    return [...doc.querySelectorAll<HTMLElement>(pageSelector)]
      .filter(page => /^[1-9]\d*$/.test(page.dataset.page ?? ''))
      .sort((a,b) => Number(a.dataset.page) - Number(b.dataset.page))
      .slice(0,MAX_COMIC_IMAGES).flatMap(page => {
        if (page.matches('.is-loading, .is-errored')) return [];
        const element = page.querySelector<ComicElement>(':scope > .rpage-page__img');
        if (!element) return [];
        if ('naturalWidth' in element) {
          const image = ordinary.get(element);
          return image && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
            ? [{...image, key: `${page.dataset.page}:${image.key}`}] : [];
        }
        if (element.tagName !== 'CANVAS' || element.width <= 0 || element.height <= 0) return [];
        let version = versions.get(element);
        if (!version) { version = crypto.randomUUID(); versions.set(element,version); }
        const url = 'page-image:' + version;
        const key = `${page.dataset.page}:${element.width}:${element.height}`;
        return [{element, key, url, read: async () => {
          const current = () => {
            context.signal.throwIfAborted();
            const target = session.inlineTargets().find(image => image.element === element);
            if (!element.isConnected || target?.url !== url || target.key !== key) throw Error('SOURCE_RESOURCE_EXPIRED');
          };
          current();
          const blob = await canvasImage(element,context.signal);
          current();
          return blob;
        }}];
      });
  }
  const session = imageSession(context, {
    containers: `${catalogAnchor}, ${readerAnchor}, .rpage-page`,
    snapshot: () => ({url: context.location.url, adapter: 'comix', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: images,
  });
  return {
    ...session,
    direction: 'ltr',
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    observe(changed) {
      const cleanup = session.observe!(changed);
      observer = new MutationObserver(records => { if (revisions(records)) changed(); });
      observer.observe(context.document.documentElement, {subtree: true, attributes: true,
        attributeOldValue: true, attributeFilter: ['class','width','height','data-page']});
      return () => { cleanup(); observer?.disconnect(); observer = undefined; };
    },
    dispose() { observer?.disconnect(); observer = undefined; session.dispose(); },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'catalog') return context.document.querySelector(catalogAnchor);
      return context.location.kind === 'reader' ? context.document.querySelector(readerAnchor) : null;
    },
  };
};
