import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {renderedImages} from '../../shared/dom-images';
import {catalogKey, catalogUrl, jfLocation} from './definition';
import {imageUrl, readerWork, sourceUrl} from './html';

export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: '.comic-content, .comic-actions, .reader-nav',
    attributes: ['alt'],
    snapshot: () => ({url: context.location.url, adapter: 'jf00', title: context.document.title,
      direction: 'ltr', note: '', discoveryComplete: false, items: []}),
    targets: () => renderedImages(context.document, context.location.url, '.comic-content > img.comic-image')
      .filter(({element, url}) => {
        const img = element as HTMLImageElement;
        if (!img.complete || !img.naturalWidth || !img.naturalHeight || !/^.+ - 第[1-9]\d*张图$/.test(img.alt)) return false;
        try {return imageUrl(url) === url;} catch {return false;}
      }).map(item => ({...item, key: `${(item.element as HTMLImageElement).alt}:${item.url}`})),
  });
  return {...session, direction: 'ltr',
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot();
      const loc = jfLocation(new URL(context.location.url));
      if (!loc) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
      try {
        const raw = context.document.querySelector('link[rel="canonical"]')?.getAttribute('href');
        const actual = raw ? jfLocation(new URL(sourceUrl(raw))) : null;
        if (!actual || actual.comic !== loc.comic || actual.chapter !== loc.chapter) throw Error('SOURCE_WORK_UNAVAILABLE');
        const title = loc.chapter ? readerWork([...context.document.querySelectorAll('script[type="application/ld+json"]')]
          .map(script => `<script type="application/ld+json">${script.textContent}</script>`).join(''), loc).title
          : context.document.querySelector('.comic-meta-info h1')?.textContent?.trim();
        if (!title || title.length > 2048) throw Error('SOURCE_WORK_UNAVAILABLE');
        return {status: 'ready', value: {title, catalogId: catalogKey(loc.comic), catalogUrl: catalogUrl(loc.comic)}};
      } catch {return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};}
    },
    importAnchor() {
      session.snapshot();
      return context.location.kind === 'other' ? null : context.document.querySelector(
        context.location.kind === 'catalog' ? '.comic-actions' : '.reader-nav .nav-right');
    },
  };
};
