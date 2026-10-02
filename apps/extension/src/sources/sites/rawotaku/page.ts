import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {catalogKey, catalogUrl, rawLocation} from './definition';
import {imageUrl} from './html';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: '#vertical-content, #horizontal-content, .iv-card, .hr-manga, .manga-buttons', attributes: ['alt', 'data-src'],
    snapshot: () => ({url: context.location.url, adapter: 'rawotaku', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => renderedImages(context.document, context.location.url,
      '#vertical-content > .iv-card > img.image-vertical, #horizontal-content > .iv-card > img.image-vertical').flatMap(image => {
      const img = image.element as HTMLImageElement;
      if (!img.complete || !img.naturalWidth || !img.naturalHeight || !/^\d{1,4}$/.test(img.alt)) return [];
      try {
        if (imageUrl(image.url) !== image.url || imageUrl(img.getAttribute('data-src') || image.url) !== image.url) return [];
        return [{...image, key: `${context.location.pageKey}:${img.alt}:${image.url}`}];
      } catch {return [];}
    }),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = rawLocation(new URL(context.location.url)), doc = context.document;
      if (!loc) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const actual = canonical ? rawLocation(new URL(canonical, context.location.url)) : null;
      if (!actual || actual.slug !== loc.slug || actual.chapter !== loc.chapter || actual.language !== loc.language)
        return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      if (loc.chapter) {
        const parent = doc.querySelector('a.hr-manga')?.getAttribute('href');
        const owner = parent ? rawLocation(new URL(parent, context.location.url)) : null;
        if (!owner || owner.slug !== loc.slug || owner.chapter) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      }
      const title = doc.querySelector(loc.chapter ? 'a.hr-manga h2.manga-name' : '.anis-content h2.manga-name')?.textContent?.trim();
      if (!title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug)}};
    },
    importAnchor() {
      session.snapshot();
      return context.location.kind === 'other' ? null : context.document.querySelector(
        context.location.kind === 'catalog' ? '.manga-buttons' : '.hr-manga');
    },
  };
};
