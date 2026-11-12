import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {catalogKey, catalogUrl} from './definition';
import {catalogInfo, readerInfo} from './protocol';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: '#app_placeholder, #__NEXT_DATA__, #app_init', attributes: ['data-index', 'alt'],
    snapshot: () => ({url: context.location.url, adapter: 'ridi', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => context.location.kind !== 'reader' ? [] : renderedImages(context.document, context.location.url,
      '#app_placeholder img[data-index][alt^="image-"]', context.signal)
      .filter(({element, url}) => {
        const img = element as HTMLImageElement, index = img.dataset.index;
        // The viewer recycles offscreen slots to an SVG placeholder and revokes loaded Blob URLs.
        return !!index && /^(?:0|[1-9]\d*)$/.test(index) && img.alt === 'image-' + index &&
          img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && url.startsWith('blob:');
      })
      .sort((a, b) => Number(a.element.dataset.index) - Number(b.element.dataset.index))
      .map(item => ({...item, key: `${item.element.dataset.index}:${item.url}`})),
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      context.signal.throwIfAborted();
      try {
        if (context.location.kind === 'reader') {
          const info = readerInfo(context.document.querySelector('#app_init')?.textContent ?? '', context.location.url);
          return {status: 'ready', value: {title: info.seriesTitle, catalogId: catalogKey(info.seriesId), catalogUrl: catalogUrl(info.seriesId)}};
        }
        if (context.location.kind === 'catalog') {
          const info = catalogInfo(context.document.querySelector('#__NEXT_DATA__')?.textContent ?? '', context.location.url);
          return {status: 'ready', value: {title: info.title, catalogId: info.catalogId, catalogUrl: info.catalogUrl}};
        }
      } catch {context.signal.throwIfAborted();}
      return {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};
    },
  };
};
