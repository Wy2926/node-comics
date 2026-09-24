import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';

const catalogAnchor = '.banner_detail_form .info .bottom';
// Both desktop layouts use cp_image. Exclude loading icons, ads and cp_image2 overlays.
const selector = '#cp_img img#cp_image, #showimage img#cp_image';
/** DOM supplies displayed originals; full chapter discovery stays on HTTP. */
export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: `${catalogAnchor}, #cp_img, #showimage`,
    snapshot: () => ({url: context.location.url, adapter: 'dm5', title: context.document.title,
      direction: 'ltr', note: '', discoveryComplete: false, items: []}),
    targets: () => renderedImages(context.document, context.location.url, selector)
      .filter(({element}) => 'naturalWidth' in element && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0),
  });
  return {...session, direction: 'ltr',
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() { session.snapshot(); return context.location.kind === 'catalog' ? context.document.querySelector(catalogAnchor) : null; },
  };
};
