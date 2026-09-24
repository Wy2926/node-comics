import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';

const catalogAnchor = '[class*="EpisodeListInfo__info_area--"]';
const readerAnchor = '#viewerHeader';
/** DOM supplies displayed originals and the entry; full acquisition uses HTTP. */
export const createPage: CreateSourcePage = context => {
  let readerEntry: HTMLElement | undefined;
  const session = imageSession(context, {
    containers: `${catalogAnchor}, ${readerAnchor}, .wt_viewer, [data-nc-naver-entry]`,
    snapshot: () => ({url: context.location.url, adapter: 'naver', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => renderedImages(context.document, context.location.url, '.wt_viewer > img[id^="content_image_"]')
      .filter(({element}) => /^content_image_\d+$/.test(element.id) && 'naturalWidth' in element &&
        element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)
      .sort((a, b) => Number(a.element.id.slice(14)) - Number(b.element.id.slice(14)))
      .map(image => ({...image, key: `${image.element.id}:${image.url}`})),
  });
  return {
    ...session,
    direction: 'ltr',
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() {
      context.signal.throwIfAborted();
      if (context.location.kind === 'catalog') return context.document.querySelector(catalogAnchor);
      const header = context.location.kind === 'reader' && context.document.querySelector(readerAnchor);
      if (!header) return null;
      if (!readerEntry?.isConnected) {
        readerEntry = context.document.createElement('div');
        readerEntry.dataset.ncNaverEntry = '';
        readerEntry.style.cssText = 'width:1190px;max-width:100%;margin:0 auto';
        header.append(readerEntry);
      }
      return readerEntry;
    },
    dispose() { session.dispose(); readerEntry?.remove(); readerEntry = undefined; },
  };
};
