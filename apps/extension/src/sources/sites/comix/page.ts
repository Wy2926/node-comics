import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';

const catalogAnchor = '.mpage__actions';
const readerAnchor = '.rpage-floatctl';
/** DOM integration supplies the entry only; catalog and page discovery stay on HTTP. */
export const createPage: CreateSourcePage = context => {
  const session = imageSession(context, {
    containers: `${catalogAnchor}, ${readerAnchor}`,
    snapshot: () => ({url: context.location.url, adapter: 'comix', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => [],
  });
  return {
    ...session,
    direction: 'ltr',
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'catalog') return context.document.querySelector(catalogAnchor);
      return context.location.kind === 'reader' ? context.document.querySelector(readerAnchor) : null;
    },
  };
};
