import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {atsuLocation, catalogUrl, origin} from './definition';
import {assetUrl} from './protocol';

function uniqueTitle(elements: NodeListOf<Element>, titleSelector?: string) {
  if (elements.length > 8) return;
  const titles = new Set([...elements].map(element => {
    const label = titleSelector ? element.querySelector(titleSelector) ?? element : element;
    return label.textContent?.replace(/\s+/g, ' ').trim();
  }).filter(Boolean));
  return titles.size === 1 ? [...titles][0] : undefined;
}

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
      if (!loc) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      const doc = context.document, url = catalogUrl(loc.mangaId);
      let title: string | undefined;
      if (loc.chapterId) {
        // Work links include an empty icon, a pure name, and a labeled navigation card.
        // The card's title span excludes its separate media/Info label; chapter metadata is not a work name.
        const path = new URL(url).pathname;
        const selector = [path, path + '/', url, url + '/'].map(href => `a[href="${href}"]`).join(',');
        title = uniqueTitle(doc.querySelectorAll(selector), 'span.text-ellipsis');
      } else {
        const canonical = doc.querySelector('meta[property="og:url"]')?.getAttribute('content')?.trim();
        const metadata = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.replace(/\s+/g, ' ').trim();
        if (canonical === url) title = metadata;
        else if ((!canonical || canonical === origin || canonical === origin + '/') &&
            uniqueTitle(doc.querySelectorAll('h1')) === metadata) {
          // Hydration replaces og:url with the site root. Bind matching headings to one
          // owned reading link, so stale SPA text cannot identify a newly navigated work.
          const href = doc.querySelector(`a[href^="/read/${loc.mangaId}/"],a[href^="${origin}/read/${loc.mangaId}/"]`)?.getAttribute('href');
          try {
            const owner = href ? atsuLocation(new URL(href, url)) : null;
            if (owner?.mangaId === loc.mangaId && owner.chapterId) title = metadata;
          } catch { /* Untrusted source link. */ }
        }
      }
      if (!title || Array.from(title).length > 2000 || /[\u0000-\u001f\u007f]/u.test(title)) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      return {status: 'ready', value: {title, catalogId: 'atsu:' + loc.mangaId, catalogUrl: url}};
    },
  };
};
