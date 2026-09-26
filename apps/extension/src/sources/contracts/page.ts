export type ComicElement = HTMLImageElement | HTMLCanvasElement;
export interface PageImage {
  element: ComicElement;
  key: string;
  url: string;
  read?: () => Promise<Blob>;
}

import type { SourceLocation } from './definition';
import type { SourceCatalogSnapshot, SourceSnapshot } from './source';
import type {SourceWorkReference} from './work';
export type Discovery<T> =
  | { status: 'ready'; value: T }
  | { status: 'not-ready'; code: string; partial?: T }
  | { status: 'unsupported'; code: string }
  | { status: 'error'; code: string };
export interface SourcePageContext {
  document: Document;
  location: SourceLocation;
  signal: AbortSignal;
}
export interface SourcePageSession {
  direction: 'ltr' | 'rtl';
  snapshot(): SourceSnapshot;
  discoverPages(): Promise<Discovery<SourceSnapshot>>;
  discoverCatalog?(): Discovery<SourceCatalogSnapshot>;
  describeWork?(): Discovery<SourceWorkReference>;
  inlineTargets(): PageImage[];
  observe?(changed: () => void): () => void;
  importAnchor?(): Element | null;
  dispose(): void;
}
export type CreateSourcePage = (context: SourcePageContext) => SourcePageSession;
