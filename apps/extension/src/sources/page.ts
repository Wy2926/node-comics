import type { SourceDefinition } from './contracts/definition';
import type { CreateSourcePage } from './contracts/page';
import { SourceDocument } from './core/document';
import { SourceNavigation } from './core/navigation';
import { definitions } from './registry/definitions';
import { pageFactories } from './registry/pages';
export type * from './contracts/page';
export type * from './contracts/source';
export { PageImageRegistry } from './core/resources';
export { canvasImage } from './shared/canvas';
export { comicImageRect, MAX_COMIC_IMAGES } from './shared/geometry';
export const createSourceNavigation = (
  doc: Document,
  invalidated?: () => void,
  registry: {
    definitions: readonly SourceDefinition[];
    pages: Readonly<Record<string, CreateSourcePage>>;
  } = { definitions, pages: pageFactories },
) => new SourceNavigation(doc, registry.definitions, registry.pages, invalidated);
/** The document expando is shared even when content and inline are separate bundles. */
export function sourceDocument(doc: Document) {
  const state = doc as Document & { __nodeComicsSource?: SourceDocument };
  if (!doc.defaultView) throw Error('SOURCE_SESSION_EXPIRED');
  return (state.__nodeComicsSource ??= new SourceDocument(doc.defaultView, (invalidate) =>
    createSourceNavigation(doc, invalidate),
  ));
}
export function discoverDocument(doc: Document, url: string) {
  const navigation = createSourceNavigation(doc);
  try {
    return navigation.get(url).session.snapshot();
  } finally {
    navigation.dispose();
  }
}
