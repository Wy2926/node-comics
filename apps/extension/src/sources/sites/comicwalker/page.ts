import type {CreateSourcePage} from '../../contracts/page';
import {MAX_COMIC_IMAGES, renderedImageRect} from '../../shared/geometry';
import {imageSession} from '../../shared/session';
import {stableCanvasTargets} from '../../shared/stable-canvases';
import {pageData, record, text} from './data';
import {catalogKey, catalogUrl, location} from './definition';

export const createPage: CreateSourcePage = context => {
  let cached: {raw: string; canonical: string; data?: ReturnType<typeof pageData>} | undefined;
  function boundLocation() {
    try {
      const current = location(new URL(context.location.url));
      const declared = location(new URL(context.document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? ''));
      if (current?.work && declared?.work === current.work && declared.episode === current.episode &&
        (!current.episode || current.episode.slice(3, 9) === current.work.slice(3, 9))) return current;
    } catch { /* The live canonical is not ready during navigation. */ }
  }
  function metadata() {
    const raw = context.document.querySelector('#__NEXT_DATA__')?.textContent ?? '';
    const canonical = context.document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
    if (cached?.raw !== raw || cached.canonical !== canonical) {
      cached = {raw, canonical};
      try {
        const current = boundLocation();
        if (!current?.work) return;
        cached.data = pageData(raw, catalogUrl(current.work));
      } catch { /* Initial SSR data can belong to the homepage or a different work. */ }
    }
    return cached.data;
  }
  const canvases = stableCanvasTargets(context, () => {
    const view = context.document.defaultView;
    if (!boundLocation()?.episode || !view) return [];
    // Inline recognition needs the live reader, not a complete import catalog.
    // __NEXT_DATA__ is stale after client-side entry from the homepage/another work.
    const pages = [...context.document.querySelectorAll<HTMLCanvasElement>(
      '.splide__list [data-type="contents"] > canvas[data-responsive="true"], .splide__list canvas[data-type="contents"][data-responsive="true"]')];
    if (pages.length > MAX_COMIC_IMAGES) return [];
    const visible = pages.map((canvas, index) => ({index, rect: renderedImageRect(canvas)})).filter(({rect}) =>
      rect && rect.right > 0 && rect.left < view.innerWidth && rect.bottom > 0 && rect.top < view.innerHeight);
    if (!visible.length) return [];
    // The source's DOM is in manuscript order in horizontal, spread and vertical modes.
    // Sample a fixed current + lookahead window, not every canvas with data-will-load.
    const start = visible[0].index;
    return pages.slice(start, Math.max(start + 5, visible.at(-1)!.index + 1)).slice(0, 8)
      .filter(canvas => !!renderedImageRect(canvas));
  });
  const session = imageSession(context, {
    attributes: ['data-responsive', 'data-will-load', 'data-type', 'mode', 'href', 'rel'],
    containers: '.splide__list, #__NEXT_DATA__, link[rel="canonical"]',
    targets: () => canvases.targets(),
    snapshot: () => ({adapter: 'comicwalker', url: context.location.url, title: context.document.title,
      direction: 'rtl', discoveryComplete: false, note: '', items: []}),
  });
  return {...session,
    get direction() {
      try {return record(metadata()?.metadata.internal).scrollType === 'ltr' ? 'ltr' : 'rtl';} catch {return 'rtl';}
    },
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    describeWork() {
      session.snapshot(); const data = metadata();
      return data ? {status: 'ready', value: {title: text(data.metadata.title), catalogId: catalogKey(data.work), catalogUrl: catalogUrl(data.work)}} :
        {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};
    },
    observe(changed) {
      const stopImages = session.observe!(changed), stopCanvas = canvases.observe(changed);
      return () => {stopImages(); stopCanvas();};
    },
    dispose() {canvases.dispose(); session.dispose(); cached = undefined;},
  };
};
