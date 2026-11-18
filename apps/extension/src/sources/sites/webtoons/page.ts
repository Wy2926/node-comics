import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {location} from './definition';
import {imageUrl} from './html';

const mobileImages = '#_viewer > ._imageWrap > img._checkVisible';
export const createPage: CreateSourcePage = context => {
  const keys = new WeakMap<Element, number>(); let nextKey = 0;
  const session = imageSession(context, {
    containers: '#_imageList, #_viewer, .detail_header, .detail_info_wrap, #toolbar, #header', attributes: ['data-url'],
    snapshot: () => ({url: context.location.url, adapter: 'webtoons', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => context.location.kind !== 'reader' ? [] : renderedImages(context.document, context.location.url, '#_imageList img._images, ' + mobileImages)
      .map(item => {
        if (!keys.has(item.element)) keys.set(item.element, nextKey++);
        return {...item, key: `${keys.get(item.element)}:${item.url}`};
      })
      .filter(({element, url}) => {
        try {
          if (!(element instanceof HTMLImageElement) || !element.complete || element.naturalWidth <= 0) return false;
          const source = imageUrl(url);
          // Mobile panels keep lazy URLs in jQuery data and may select a smaller srcset image.
          return element.matches(mobileImages) || source === imageUrl(element.dataset.url);
        } catch {return false;}
      }),
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    importAnchor() {
      context.signal.throwIfAborted();
      return context.location.kind === 'catalog' ? context.document.querySelector('.detail_header .info, .detail_info_wrap .info_area')
        : context.location.kind === 'reader' ? context.document.querySelector('#toolbar .subj_info, #header .h1_viewer') : null;
    },
    describeWork() {
      const catalog = context.location.catalog, doc = context.document;
      const mobileTitle = doc.querySelector('.detail_info_wrap .info_area .subject');
      const raw = mobileTitle ? doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href
        : doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
      const title = mobileTitle ? mobileTitle.textContent?.trim() : doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim();
      let loc; try {loc = raw ? location(new URL(raw)) : null;} catch {loc = null;}
      if (context.location.kind !== 'catalog' || !catalog || !title || !loc || loc.episode || loc.key !== catalog.key)
        return {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: catalog.key, catalogUrl: catalog.url}};
    },
  };
};
