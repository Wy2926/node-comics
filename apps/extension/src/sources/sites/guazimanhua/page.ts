import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';
import {describeWork} from './work';

/** DOM only hosts the import action; catalog and image discovery use HTTP. */
export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: '.cinema-info .hero-actions, .reader-finish-actions',
    snapshot: () => ({url: context.location.url, adapter: 'guazimanhua', title: context.document.title,
      direction: 'ltr', note: '', discoveryComplete: false, items: []}),
    targets: () => [],
  });
  return {...session, direction: 'ltr',
    describeWork() {session.snapshot(); return describeWork(context.document, context.location.url);},
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() {
      session.snapshot();
      return context.document.querySelector(context.location.kind === 'catalog' ? '.cinema-info .hero-actions' : '.reader-finish-actions');
    },
  };
};
