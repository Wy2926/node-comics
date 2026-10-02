import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {atsuLocation, catalogUrl, origin} from './definition';
import {assetUrl} from './protocol';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: '[data-reader-page]', attributes: ['data-page-number'],
    snapshot: () => ({url: context.location.url, adapter: 'atsu', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => {
      const loc = atsuLocation(new URL(context.location.url));
      if (!loc?.chapterId) return [];
      return renderedImages(context.document, context.location.url, '[data-reader-page][data-page-number] img').flatMap(image => {
        const element = image.element as HTMLImageElement, position = element.closest('[data-reader-page]')?.getAttribute('data-page-number');
        if (!position || !/^\d{1,4}$/.test(position) || !element.complete || !element.naturalWidth || !element.naturalHeight) return [];
        try {
          const blob = image.url.startsWith('blob:') && new URL(image.url).origin === origin;
          if (!blob && assetUrl(image.url, 'page', undefined, loc.chapterId) !== image.url) return [];
          return [{...image, key: `${loc.chapterId}:${position}:${image.url}`}];
        } catch {return [];}
      });
    },
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = atsuLocation(new URL(context.location.url));
      if (!loc || loc.chapterId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const url = context.document.querySelector('meta[property="og:url"]')?.getAttribute('content');
      const title = context.document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
      if (url !== catalogUrl(loc.mangaId) || !title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: 'atsu:' + loc.mangaId, catalogUrl: url}};
    },
  };
};
