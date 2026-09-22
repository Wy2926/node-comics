import type { CreateSourcePage } from '../contracts/page';
import { imageDiscovery, renderedImages } from '../shared/dom-images';
import { imageSession } from '../shared/session';
export const createPage: CreateSourcePage = (context) =>
  imageSession(context, {
    snapshot: imageDiscovery(context.document, context.location.url),
    targets: () => renderedImages(context.document, context.location.url),
  });
