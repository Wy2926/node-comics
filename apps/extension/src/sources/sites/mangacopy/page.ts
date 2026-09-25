import type { CreateSourcePage } from '../../contracts/page';
import { renderedImages } from '../../shared/dom-images';
import { imageSession } from '../../shared/session';
import { readMangaCopyData } from './data';
import { discoverMangaCopyDocument } from './pages';
export const createPage: CreateSourcePage = (context) => ({
  ...imageSession(context, {
    containers: '.comicParticulars-title-right',
    snapshot: () => discoverMangaCopyDocument(context.document, context.location.url),
    read: () => readMangaCopyData(context.document, context.location.url),
    targets: () => renderedImages(context.document, context.location.url, '.comicContent-list img')
      .filter(({element}) => 'naturalWidth' in element && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0),
  }),
  importAnchor: () =>
    context.location.kind === 'catalog'
      ? context.document.querySelector('.comicParticulars-title-right')
      : null,
});
