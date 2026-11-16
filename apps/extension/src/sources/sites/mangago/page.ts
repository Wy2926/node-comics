import type {CreateSourcePage, PageImage} from '../../contracts/page';
import type {SourceSnapshot} from '../../contracts/source';
import {imageSession} from '../../shared/session';
import {catalogKey, catalogUrl, mangagoLocation} from './definition';
import {parsePages} from './network';
import {imageUrl} from './protocol';

export const createPage: CreateSourcePage = context => {
  const loc = mangagoLocation(new URL(context.location.url)), doc = context.document;
  let disposed = false;
  let snapshot: SourceSnapshot = {url: context.location.url, adapter: 'mangago', title: doc.title,
    direction: 'ltr', note: '', discoveryComplete: false, items: []};
  const ready = loc?.chapter ? parsePages(doc.documentElement.outerHTML, context.location.url, context.signal)
    .then(value => {snapshot = value;}).catch(() => {}) : Promise.resolve();
  const session = imageSession(context, {
    containers: '#pic_container, #series, #chapter_table, h1', attributes: ['id', 'class'],
    snapshot: () => snapshot,
    read: async () => {await ready; return snapshot;},
    targets: () => {
      if (!loc?.chapter || !snapshot.discoveryComplete) return [];
      return [...doc.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('#pic_container img, #pic_container span.wsp canvas')].flatMap((element): PageImage[] => {
        const slot = /^page([1-9]\d*)$/.exec(element.tagName === 'CANVAS' ? element.parentElement?.id ?? '' : element.id);
        const item = slot && snapshot.items[Number(slot[1]) - 1];
        if (!item || item.resource.kind !== 'http') return [];
        let url = item.resource.url;
        if (element.tagName === 'IMG') {
          const img = element as HTMLImageElement;
          if (!img.complete || !img.naturalWidth || !img.naturalHeight) return [];
          try {url = imageUrl(img.currentSrc || img.src, loc.work);} catch {return [];}
          if (url.replace(/\?1$/, '') !== item.resource.url.replace(/\?1$/, '')) return [];
        } else if (!(element as HTMLCanvasElement).width || !(element as HTMLCanvasElement).height) return [];
        return [{element, url, key: `${context.location.pageKey}:${item.id}:${url}`}];
      });
    },
  });
  return {...session, direction: 'ltr',
    observe(changed) {
      const cleanup = session.observe!(changed); let active = true;
      void ready.then(() => {if (active && !disposed && !context.signal.aborted) changed();});
      return () => {active = false; cleanup();};
    },
    dispose() {disposed = true; session.dispose();},
    describeWork() {
      session.snapshot();
      const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
      if (!loc) return unavailable;
      try {
        const canonical = doc.querySelectorAll('link[rel="canonical"]');
        const actual = canonical.length === 1 && mangagoLocation(new URL(canonical[0].getAttribute('href')!, context.location.url));
        if (!actual || actual.work !== loc.work || actual.chapter !== loc.chapter) return unavailable;
        const headings = doc.querySelectorAll(loc.chapter ? 'a#series' : 'h1'), heading = headings[0];
        if (headings.length !== 1) return unavailable;
        if (loc.chapter) {
          const owner = mangagoLocation(new URL(heading.getAttribute('href')!, context.location.url));
          if (!owner || owner.chapter || owner.work !== loc.work) return unavailable;
        }
        const title = heading.textContent?.replace(/\s+/g, ' ').trim();
        if (!title || title.length > 2048) return unavailable;
        return {status: 'ready', value: {title, catalogId: catalogKey(loc.work), catalogUrl: catalogUrl(loc.work)}};
      } catch {return unavailable;}
    },
    importAnchor() {
      session.snapshot();
      return loc ? doc.querySelector(loc.chapter ? '#series' : 'h1')?.parentElement ?? null : null;
    },
  };
};
