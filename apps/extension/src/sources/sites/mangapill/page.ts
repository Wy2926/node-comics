import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {catalogKey, catalogUrl, mangapillLocation} from './definition';
import {coverUrl, imageUrl} from './html';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: 'chapter-page, #js-chapter-selector-modal, #chapters, h1',
    attributes: ['alt', 'data-src', 'data-summary'],
    snapshot: () => ({url: context.location.url, adapter: 'mangapill', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => {
      const loc = mangapillLocation(new URL(context.location.url));
      if (!loc?.chapter) return [];
      const title = context.document.querySelector('h1#top')?.textContent?.trim();
      if (!title) return [];
      return renderedImages(context.document, context.location.url, 'chapter-page img.js-page').flatMap(item => {
        const img = item.element as HTMLImageElement;
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) return [];
        const summary = img.closest('chapter-page')?.querySelector('[data-summary]')?.textContent?.trim();
        const slot = /^page\s+([1-9]\d*)\/([1-9]\d*)$/i.exec(summary ?? '');
        if (!slot || Number(slot[1]) > Number(slot[2]) || Number(slot[2]) > 1500 || img.alt !== `${title} Page ${slot[1]}`) return [];
        try {
          if (imageUrl(item.url, loc) !== item.url ||
              imageUrl(img.getAttribute('data-src') || '', loc) !== item.url) return [];
          return [{...item, key: `${context.location.pageKey}:page:${slot[1]}:${item.url}`}];
        } catch {return [];}
      });
    },
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = mangapillLocation(new URL(context.location.url));
      if (!loc) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const doc = context.document;
      let title: string | undefined;
      if (loc.chapter) {
        const links = [...doc.querySelectorAll('a[data-hotkey="m"]')];
        const owner = links.length === 1 ? links[0].getAttribute('href') : null;
        let parent = null;
        try {parent = owner ? mangapillLocation(new URL(owner, context.location.url)) : null;} catch { /* Untrusted source link. */ }
        if (!parent || parent.work !== loc.work || parent.chapter) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
        const label = doc.querySelector('#chapter-selector-modal-title')?.textContent?.trim();
        title = label?.endsWith(' Chapters') ? label.slice(0, -' Chapters'.length).trim() : undefined;
      } else {
        // The dedicated cover identifies the work; recommendations have different IDs.
        const covers = [...doc.querySelectorAll<HTMLImageElement>('img[data-src]')].filter(img => {
          return !!coverUrl(img.getAttribute('data-src'), loc.work);
        });
        if (covers.length !== 1) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
        title = doc.querySelector('h1')?.textContent?.trim();
        if (covers[0].alt !== title) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      }
      if (!title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: catalogKey(loc.work),
        catalogUrl: catalogUrl(loc.work, loc.chapter ? loc.catalogSlug : loc.slug)}};
    },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other') return null;
      return context.document.querySelector(context.location.kind === 'catalog' ? 'h1' : 'h1#top')?.parentElement ?? null;
    },
  };
};
