import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {catalogKey, catalogUrl, route} from './definition';

export const createPage: CreateSourcePage = context => {
  const {document, location, signal} = context;
  const session = imageSession(context, {
    containers: '.zao', snapshot: () => ({url: location.url, adapter: 'mangaplus', title: document.title,
      direction: 'rtl', items: [], discoveryComplete: false, note: ''}),
    targets: () => location.kind !== 'reader' ? [] : renderedImages(document, location.url,
      '.zao .zao-page > .zao-image-container > img.zao-image', signal).filter(target => {
        const img = target.element as HTMLImageElement;
        return !!target.read && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
      }),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      signal.throwIfAborted();
      const heading = document.querySelector(location.kind === 'reader' ? 'a[href^="/titles/"] h1' : 'main h1');
      const href = location.kind === 'reader' ? heading?.closest('a')?.href : location.url;
      const work = href && route(new URL(href));
      if (!work || work.reader || !work.title || !heading?.textContent?.trim()) return {status:'not-ready', code:'WORK_METADATA_UNAVAILABLE'};
      return {status:'ready', value:{title:heading.textContent.trim(), catalogId:catalogKey(work.title), catalogUrl:catalogUrl(work.title)}};
    },
  };
};
