import type {CreateSourcePage} from '../../contracts/page';
import {renderedImages} from '../../shared/dom-images';
import {observeImages} from '../../shared/observe';
import {imageSession} from '../../shared/session';
import {origin} from './definition';

const readers = [
  {id: 'iframe_page', path: '/wpage.htm', selector: '#div_onepic img#img_full, #div_twopic img#img_left, #div_twopic img#img_right'},
  {id: 'iframe_line', path: '/wline.htm', selector: '#precont img[id^="epub_img_"], #nowcont img[id^="epub_img_"]'},
] as const;
type Reader = typeof readers[number];
function readerUrl(value: string, reader: Reader) {
  const url = new URL(value);
  return url.origin === origin && url.pathname === reader.path && !url.username && !url.password;
}

export const createPage: CreateSourcePage = context => {
  const lifetime = new AbortController(), signal = AbortSignal.any([context.signal, lifetime.signal]);
  const cleanups = new Set<() => void>();
  function frameDocument(frame: HTMLIFrameElement, reader: Reader) {
    try {
      const doc = frame.contentDocument;
      if (frame.isConnected && doc?.defaultView?.frameElement === frame && readerUrl(frame.src, reader) && readerUrl(doc.URL, reader))
        return doc;
    } catch {return;}
  }
  function frames() {
    if (context.location.kind !== 'reader') return [];
    return readers.flatMap(reader => {
      const frame = context.document.querySelector<HTMLIFrameElement>('iframe#' + reader.id);
      const doc = frame && frameDocument(frame, reader);
      return frame && doc ? [{frame, doc, reader}] : [];
    });
  }
  const session = imageSession(context, {
    containers: '#view_page, #view_line, iframe',
    snapshot: () => ({url: context.location.url, adapter: 'koobone', title: context.document.title,
      direction: 'rtl', discoveryComplete: false, note: '', items: []}),
    targets: () => frames().flatMap(({frame, doc, reader}) => {
      const visible = () => {
        if (!frame.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return false;
        const rect = frame.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      if (!visible()) return [];
      return renderedImages(doc, doc.URL, reader.selector, signal).flatMap(target => {
        const image = target.element as HTMLImageElement;
        const read = target.read;
        // KOOBONE unpacks the user's EPUB locally. Covers, preload nodes and HTTP placeholders are not pages.
        if (!read || !image.complete || !image.naturalWidth || !image.naturalHeight ||
            reader.id === 'iframe_line' && !/^epub_img_[1-9]\d*$/.test(image.id)) return [];
        const current = () => {
          signal.throwIfAborted();
          if (frameDocument(frame, reader) !== doc || !visible() || !image.matches(reader.selector))
            throw Error('SOURCE_RESOURCE_EXPIRED');
        };
        return [{...target, key: `${reader.id}:${image.id}:${target.url}`, read: async (requestSignal?: AbortSignal) => {
          current();
          const blob = await read(requestSignal);
          current();
          return blob;
        }}];
      });
    }),
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'};},
    observe(changed) {
      const observed = new Map<Document, () => void>();
      const sync = () => {
        const present = new Set(frames().map(({doc}) => doc));
        for (const [doc, stop] of observed) if (!present.has(doc)) {stop(); observed.delete(doc);}
        for (const doc of present) if (!observed.has(doc)) {
          const stop = observeImages(doc, changed, [], '#div_onepic, #div_twopic, #precont, #nowcont');
          doc.addEventListener('scroll', changed, {capture: true, passive: true});
          doc.defaultView?.addEventListener('resize', changed);
          doc.defaultView?.addEventListener('pagehide', changed);
          observed.set(doc, () => {
            stop(); doc.removeEventListener('scroll', changed, true);
            doc.defaultView?.removeEventListener('resize', changed);
            doc.defaultView?.removeEventListener('pagehide', changed);
          });
        }
      };
      const stopMain = session.observe!(() => {sync(); changed();});
      sync();
      const stop = () => {stopMain(); for (const cleanup of observed.values()) cleanup(); observed.clear(); cleanups.delete(stop);};
      cleanups.add(stop);
      return stop;
    },
    dispose() {lifetime.abort(); for (const stop of [...cleanups]) stop(); session.dispose();},
  };
};
