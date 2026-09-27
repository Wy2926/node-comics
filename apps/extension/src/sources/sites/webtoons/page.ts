import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {location} from './definition';
import {imageUrl} from './html';

export const createPage: CreateSourcePage = context => {
  const keys = new WeakMap<Element, number>(); let nextKey = 0;
  const session = imageSession(context, {
    containers: '#_imageList, .detail_header, #toolbar', attributes: ['data-url'],
    snapshot: () => ({url: context.location.url, adapter: 'webtoons', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => context.location.kind !== 'reader' ? [] : renderedImages(context.document, context.location.url, '#_imageList img._images')
      .map(item => {
        if (!keys.has(item.element)) keys.set(item.element, nextKey++);
        return {...item, key: `${keys.get(item.element)}:${item.url}`};
      })
      .filter(({element, url}) => {
        try {return element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0 &&
          imageUrl(url) === imageUrl(element.dataset.url);} catch {return false;}
      }),
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    importAnchor() {
      context.signal.throwIfAborted();
      return context.location.kind === 'catalog' ? context.document.querySelector('.detail_header .info')
        : context.location.kind === 'reader' ? context.document.querySelector('#toolbar .subj_info') : null;
    },
    describeWork() {
      const catalog = context.location.catalog, doc = context.document;
      const raw = doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
      const title = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim();
      let loc; try {loc = raw ? location(new URL(raw)) : null;} catch {loc = null;}
      if (context.location.kind !== 'catalog' || !catalog || !title || !loc || loc.episode || loc.key !== catalog.key)
        return {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: catalog.key, catalogUrl: catalog.url}};
    },
  };
};
