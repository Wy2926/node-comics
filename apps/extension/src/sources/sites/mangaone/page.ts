import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {mangaOneChapter, origin} from './definition';

// The viewer mounts only a small window of already decoded Blob images. Neither
// the mounted count nor DOM order proves a complete chapter. CSS module hashes
// vary; browser translation can also rewrite alt="page_N", so alt is not identity.
const viewer = '[class*="_viewer_wrapper"]';
export const bodySelector = viewer + ' [data-testid="placeholder"] > img';
export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: viewer + ', [data-testid="placeholder"]', attributes: ['data-testid'],
    snapshot: () => ({adapter: 'mangaone', url: context.location.url, title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => {
      if (!mangaOneChapter(new URL(context.location.url))) return [];
      return renderedImages(context.document, context.location.url, bodySelector, context.signal).flatMap(target => {
        const image = target.element as HTMLImageElement;
        if (!/(?:^|\s)[^\s]+_page(?:\s|$)/.test(image.className) || !image.complete ||
            image.naturalWidth <= 0 || image.naturalHeight <= 0 ||
            !target.url.startsWith('blob:') || new URL(target.url).origin !== origin) return [];
        // The common inline session tracks elements separately, including duplicate
        // Blob URLs. Recycling with new content invalidates the old Blob identity.
        return [{...target, key: `${context.location.pageKey}:${target.url}`}];
      });
    },
  });
  return {...session,
    async discoverPages() {
      session.snapshot();
      return {status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'};
    },
  };
};
