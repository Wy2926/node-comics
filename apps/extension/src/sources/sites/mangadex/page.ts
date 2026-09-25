import type {CreateSourcePage} from '../../contracts/page';
import {imageSession} from '../../shared/session';

/** The page hosts only the import action. Public API responses supply every catalog and reading page. */
export const createPage: CreateSourcePage = context => {
  let anchor: HTMLDivElement | undefined;
  const session = imageSession(context, {
    containers: 'body',
    snapshot: () => ({url: context.location.url, adapter: 'mangadex', title: context.document.title,
      direction: 'rtl', note: '', discoveryComplete: false, items: []}),
    targets: () => [],
  });
  return {...session,
    async discoverPages() {session.snapshot(); return {status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'};},
    importAnchor() {
      session.snapshot();
      if (context.location.kind === 'other' || !context.document.body) return null;
      if (!anchor?.isConnected) {
        anchor?.remove();
        anchor = context.document.createElement('div');
        anchor.dataset.nodelaneMangadexImport = '';
        anchor.style.cssText = 'position:fixed;inset:auto 16px 16px auto;max-width:calc(100vw - 32px);z-index:2147483000;';
        context.document.body.append(anchor);
      }
      return anchor;
    },
    dispose() {session.dispose(); anchor?.remove(); anchor = undefined;},
  };
};
