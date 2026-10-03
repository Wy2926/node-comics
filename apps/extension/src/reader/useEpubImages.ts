import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type Rendition from 'epubjs/types/rendition';
import {loadEpubImagePages} from '../comics/application/epub-service';
import {epubImageId} from '../comics/domain/epub-images';
import type {Mode, Page, ReadingEntry} from '../types';
import type {ReadingTarget} from '../translation/automatic';
import {EpubImageWindow} from './epub-images';

export function useEpubImages({copy, update, translated, mode, language, scope, onReadingWindow}: {
  copy: ReadingEntry;
  update(value: ReadingEntry): void;
  translated: boolean;
  mode: Mode;
  language: string;
  scope?: string;
  onReadingWindow(targets: ReadingTarget[], visible: Page[], immediate?: boolean): void;
}) {
  const [hrefs, setHrefs] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});
  const [retry, setRetry] = useState(0);
  const manager = useRef<EpubImageWindow | undefined>(undefined);
  const latest = useRef({copy, update, translated, mode, language, scope});
  latest.current = {copy, update, translated, mode, language, scope};

  function connect(view: Rendition, signal: AbortSignal) {
    manager.current?.close();
    setHrefs([]);
    setFailures({});
    const current = new EpubImageWindow(setHrefs, (href, error) => setFailures(values => values[href] === error ? values : {...values, [href]: error}));
    manager.current = current;
    current.connect(view);
    signal.addEventListener('abort', () => {
      current.close();
      if (manager.current === current) manager.current = undefined;
    }, {once: true});
  }

  useEffect(() => {
    const controller = new AbortController();
    if (!copy.contentId) return;
    void loadEpubImagePages(copy.id, copy.contentId, hrefs, scope, controller.signal).then(pages => {
      if (controller.signal.aborted) return;
      const current = latest.current;
      const existing = new Map(current.copy.pages.map(page => [page.id, page]));
      const next = {...current.copy, pages: pages.map(page => {
        const previous = existing.get(page.id);
        return previous && previous.translationScope === scope ? previous : page;
      })};
      current.copy = next;
      current.update(next);
      setFailures({});
    }).catch(error => {
      if (!controller.signal.aborted && hrefs[0]) setFailures(values => ({...values, [hrefs[0]]: (error as Error).message}));
    });
    return () => controller.abort();
  }, [copy.id, copy.contentId, hrefs, scope, retry]);

  // Revoke a different account/language's result before the next paint.
  useLayoutEffect(() => {
    manager.current?.show(copy.pages, translated, mode, language, scope);
  }, [copy.pages, translated, mode, language, scope]);

  const pages = hrefs.flatMap(href => {
    const page = copy.pages.find(value => value.id === epubImageId(href));
    return page ? [page] : [];
  });
  useEffect(() => {
    onReadingWindow(translated ? pages.map(page => ({entryId: copy.id, page, mode})) : [], pages);
  }, [copy.id, copy.pages, hrefs, mode, translated, onReadingWindow]);
  useEffect(() => () => {manager.current?.close(); onReadingWindow([], []);}, [onReadingWindow]);

  return {connect, page: pages[0], error: failures[hrefs[0]], retry() {
    if (hrefs[0]) manager.current?.retry(hrefs[0]);
    setRetry(value => value + 1);
  }};
}
