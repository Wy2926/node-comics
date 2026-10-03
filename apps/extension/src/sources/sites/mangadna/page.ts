import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {imageSession} from '../../shared/session';
import {catalogKey, catalogUrl, mangaDnaLocation} from './definition';
import {chapterNumber, imageSource, imageUrl, pageNumber, text} from './html';

export const createPage: CreateSourcePage = context => {
  const loc = mangaDnaLocation(new URL(context.location.url)), doc = context.document;
  const work = () => {
    try {
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const actual = canonical ? mangaDnaLocation(new URL(canonical, context.location.url)) : null;
      if (!loc || !actual || loc.slug !== actual.slug || loc.chapter !== actual.chapter) return;
      const parents = loc.chapter ? [...doc.querySelectorAll<HTMLAnchorElement>('.breadcrumb a')].filter(link => {
        const owner = mangaDnaLocation(new URL(link.href, context.location.url));
        return owner?.slug === loc.slug && !owner.chapter;
      }) : [...doc.querySelectorAll('.post-title h1')];
      const title = text(parents.length === 1 ? parents[0].textContent?.replace(/\s+/g, ' ') : '');
      const reference = {title, catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug)};
      if (!loc.chapter) return {reference};
      const selected = [...doc.querySelectorAll('.navi-change-chapter option:checked')];
      if (!selected.length) return;
      const label = text(selected[0].textContent?.replace(/\s+/g, ' ')), heading = title + ' - ' + label;
      if (doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() !== heading || selected.some(option =>
        option.getAttribute('data-c') !== loc.chapter || option.textContent?.replace(/\s+/g, ' ').trim() !== label)) return;
      return {reference, heading, chapter: chapterNumber(label)};
    } catch {return;}
  };
  const session = imageSession(context, {
    containers: '.read-content, .post-title, .breadcrumb a, .navi-change-chapter option, h1, link[rel="canonical"]',
    attributes: ['alt', 'data-src', 'href', 'data-c', 'selected'],
    snapshot: () => ({url: context.location.url, adapter: 'mangadna', title: context.document.title,
      direction: 'ltr', note: '', discoveryComplete: false, items: []}),
    targets: () => {
      const owner = work();
      if (!owner?.heading) return [];
      const {heading, chapter} = owner;
      return renderedImages(context.document, context.location.url, '.read-content > img.loading').flatMap(image => {
        const img = image.element as HTMLImageElement;
        if (!img.complete || !img.naturalWidth || !img.naturalHeight || !pageNumber(img.alt, heading)) return [];
        try {
          const source = imageSource(image.url), original = img.getAttribute('data-src');
          if (source.href !== image.url || original && original !== image.url && imageUrl(original) !== image.url) return [];
          if (chapter && source.pathname.split('/').at(-2) !== chapter) return [];
          return [{...image, key: `${context.location.pageKey}:${img.alt}:${image.url}`}];
        } catch {return [];}
      });
    },
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const value = work()?.reference;
      return value ? {status: 'ready', value} : {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
    },
    importAnchor() {
      session.snapshot();
      return context.location.kind === 'other' ? null : context.document.querySelector(
        context.location.kind === 'catalog' ? '.post-title' : '.c-breadcrumb');
    },
  };
};
