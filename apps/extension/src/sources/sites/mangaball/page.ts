import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {catalogUrl, mangaBallLocation} from './definition';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    attributes: ['alt'],
    snapshot: () => ({url: context.location.url, adapter: 'mangaball', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => {
      const loc = mangaBallLocation(new URL(context.location.url));
      if (!loc?.chapterId) return [];
      return renderedImages(context.document, context.location.url, 'img[alt*=" Page "]')
        .filter(({element}) => {
          if (!('alt' in element) || !element.complete || !element.naturalWidth || !element.naturalHeight) return false;
          return /^.+ Chapter \d+(?:\.\d+)? Page [1-9]\d* - .+$/.test(element.alt);
        }).map(image => ({...image, key: image.element.getAttribute('alt') + ':' + image.url}));
    },
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = mangaBallLocation(new URL(context.location.url));
      if (!loc?.titleId || loc.chapterId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const canonical = context.document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const raw = context.document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      const title = /^Read (.+) Online Free - MangaBall$/.exec(raw ?? '')?.[1];
      let owner;
      try {owner = canonical ? mangaBallLocation(new URL(canonical)) : null;} catch {return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};}
      if (!title || title.length > 2048 || owner?.chapterId || owner?.titleId !== loc.titleId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: 'mangaball:' + loc.titleId, catalogUrl: catalogUrl(loc.titleId)}};
    },
  };
};
