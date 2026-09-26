import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {catalogUrl, mangaDotLocation, origin} from './definition';

export const createPage: CreateSourcePage = context => {
  let anchor: HTMLDivElement | undefined;
  const session = imageSession(context, {
    containers: '#root', attributes: ['alt'],
    snapshot: () => ({url: context.location.url, adapter: 'mangadot', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => renderedImages(context.document, context.location.url, '#root img[alt^="Page "]')
      .filter(({element, url}) => 'alt' in element && /^Page [1-9]\d*$/.test(element.alt) && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0 &&
        new URL(url).origin === origin && /^\/chapters\/manga_\d+\//.test(new URL(url).pathname))
      .map(image => ({...image, key: `${image.element.getAttribute('alt')}:${image.url}`})),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = mangaDotLocation(new URL(context.location.url));
      if (!loc?.mangaId || loc.release) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const canonical = context.document.querySelector('meta[property="og:url"]')?.getAttribute('content');
      const title = context.document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
      if (canonical !== catalogUrl(loc.mangaId) || !title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: 'mangadot:' + loc.mangaId, catalogUrl: canonical}};
    },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other' || !context.document.body) return null;
      if (!anchor?.isConnected) {
        anchor?.remove();
        anchor = context.document.createElement('div');
        anchor.dataset.nodelaneMangadotImport = '';
        anchor.style.cssText = 'position:fixed;inset:auto 16px 60px auto;max-width:calc(100vw - 32px);z-index:2147483000;';
        context.document.body.append(anchor);
      }
      return anchor;
    },
    dispose() {session.dispose(); anchor?.remove(); anchor = undefined;},
  };
};
