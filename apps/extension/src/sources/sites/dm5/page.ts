import type {CreateSourcePage} from '../../contracts/page';
import {observeImages} from '../../shared/observe';

/** DOM integration is only the import entry; all discovery stays on HTTP. */
export const createPage: CreateSourcePage = context => ({
  direction: 'ltr',
  snapshot: () => ({url: context.location.url, adapter: 'dm5', title: context.document.title,
    direction: 'ltr', note: '', discoveryComplete: false, items: []}),
  discoverPages: async () => ({status: 'unsupported', code: 'SOURCE_NETWORK_REQUIRED'}),
  inlineTargets: () => [],
  importAnchor: () => context.signal.aborted || context.location.kind !== 'catalog' ? null : context.document.querySelector('.banner_detail_form .info .bottom'),
  observe: changed => observeImages(context.document, changed, [], '.banner_detail_form .info .bottom'),
  dispose() {},
});
