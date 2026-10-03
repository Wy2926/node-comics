import type {CreateSourcePage} from '../../contracts/page';
import {gigaViewerPage} from '../../shared/gigaviewer/page';
import {catalogUrl, seriesKey} from './definition';
import {json, parseEpisode} from './protocol';
import {parsePages} from './pages';

export const createPage: CreateSourcePage = context => {
  let anchor: HTMLDivElement | undefined;
  const data = () => json(context.document.querySelector('#episode-json')?.getAttribute('data-value') ?? '');
  const session = gigaViewerPage(context, parsePages);
  return {...session,
    describeWork() {
      session.snapshot();
      try {
        const reader = parseEpisode(data(), context.location.url);
        return {status: 'ready', value: {title: reader.title, catalogId: seriesKey(reader.series), catalogUrl: catalogUrl(reader.series, reader.episode)}};
      } catch {return {status: 'not-ready', code: 'WORK_METADATA_UNAVAILABLE'};}
    },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other' || !context.document.body) return null;
      if (!anchor?.isConnected) {
        anchor?.remove(); anchor = context.document.createElement('div');
        anchor.dataset.nodelaneWebryImport = '';
        anchor.style.cssText = 'position:fixed;inset:auto 16px 60px auto;max-width:calc(100vw - 32px);z-index:2147483000;';
        context.document.body.append(anchor);
      }
      return anchor;
    },
    dispose() {session.dispose(); anchor?.remove(); anchor = undefined;},
  };
};
