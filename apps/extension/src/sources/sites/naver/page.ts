import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';

const catalogAnchor = '[class*="EpisodeListInfo__info_area--"]';
const readerAnchor = '#viewerHeader';
/** DOM is used only for the embedded entry. All acquisition uses the network adapter. */
export const createPage: CreateSourcePage = context => {
  let readerEntry: HTMLElement | undefined;
  const session = imageSession(context, {
    containers: `${catalogAnchor}, ${readerAnchor}, [data-nc-naver-entry]`,
    snapshot: () => ({url: context.location.url, adapter: 'naver', title: context.document.title,
      direction: 'ltr', discoveryComplete: false, note: '', items: []}),
    targets: () => [],
  });
  return {
    ...session,
    direction: 'ltr',
    async discoverPages() { session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'}; },
    importAnchor() {
      context.signal.throwIfAborted();
      if (context.location.kind === 'catalog') return context.document.querySelector(catalogAnchor);
      const header = context.location.kind === 'reader' && context.document.querySelector(readerAnchor);
      if (!header) return null;
      if (!readerEntry?.isConnected) {
        readerEntry = context.document.createElement('div');
        readerEntry.dataset.ncNaverEntry = '';
        readerEntry.style.cssText = 'width:1190px;max-width:100%;margin:0 auto';
        header.append(readerEntry);
      }
      return readerEntry;
    },
    dispose() { session.dispose(); readerEntry?.remove(); readerEntry = undefined; },
  };
};
