import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {baoLocation, catalogKey, catalogUrl, chapterUrl} from './definition';
import {imageUrl} from './html';

export const createPage: CreateSourcePage = context => {
  let anchor: HTMLDivElement | undefined;
  const session = imageSession(context, {
    containers: '.comic-contain, .comics-detail', attributes: ['amp-img-id'],
    snapshot: () => ({url: context.location.url, adapter: 'baozimh', title: context.document.title,
      direction: 'ltr', note: '', discoveryComplete: false, items: []}),
    targets: () => renderedImages(context.document, context.location.url, '.comic-contain amp-img.comic-contain__item > img[amp-img-id]')
      .filter(({element, url}) => {
        const img = element as HTMLImageElement;
        if (!img.complete || !img.naturalWidth || !img.naturalHeight || !/^chapter-img-\d+-\d+$/.test(img.getAttribute('amp-img-id') ?? '')) return false;
        try {return imageUrl(url) === url;} catch {return false;}
      }).map(item => ({...item, key: `${item.element.getAttribute('amp-img-id')}:${item.url}`})),
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = baoLocation(new URL(context.location.url));
      if (!loc) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      let title = context.document.querySelector('.comics-detail__title')?.textContent?.trim();
      const canonical = context.document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const catalog = catalogUrl(loc.comic);
      if (loc.chapter !== undefined) {
        const chapter = context.document.querySelector('.header .title')?.textContent?.trim();
        const alt = context.document.querySelector('amp-img#chapter-img-0-0.comic-contain__item')?.getAttribute('alt');
        const parent = context.document.querySelector('.header a.goto')?.getAttribute('href');
        const suffix = ` - ${chapter} - 1`;
        title = chapter && alt?.endsWith(suffix) && parent === catalog ? alt.slice(0, -suffix.length).trim() : undefined;
      }
      if (!title || title.length > 2048 || canonical !== (loc.chapter === undefined ? catalog : chapterUrl(loc, loc.part)))
        return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: catalogKey(loc.comic), catalogUrl: catalog}};
    },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other' || !context.document.body) return null;
      if (!anchor?.isConnected) {
        anchor?.remove(); anchor = context.document.createElement('div'); anchor.dataset.nodelaneBaozimhImport = '';
        anchor.style.cssText = 'position:fixed;inset:auto 16px 65px auto;max-width:calc(100vw - 32px);z-index:2147483000;';
        context.document.body.append(anchor);
      }
      return anchor;
    },
    dispose() {session.dispose(); anchor?.remove(); anchor = undefined;},
  };
};
