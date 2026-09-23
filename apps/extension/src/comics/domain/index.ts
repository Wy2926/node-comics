/** Persistent catalog values. No Blob, browser handle, access token or runtime parser belongs here. */
export type DocumentFormat = 'zip' | 'cbz' | 'rar' | 'cbr' | 'pdf' | 'mobi' | 'image' | 'images' | 'website';
export interface Work {
  id: string; title: string; aliases?: string[]; createdAt: number; updatedAt: number;
  description?: string; creators?: string[];
  cover?: { documentId: string; revisionId: string; pageId: string };
  documentCount?: number; lastReadAt?: number;
}
export interface ReadingUnit {
  id: string; workId: string; title: string; order: number;
  kind: 'chapter' | 'volume' | 'book' | 'unclassified'; role: 'main' | 'extra' | 'unknown';
  preferredDocumentId?: string; readAt?: number; createdAt: number; updatedAt: number;
}
export interface Document {
  id: string; unitId: string; sourceBindingId: string; format: DocumentFormat; revisionId: string;
  title: string; generation: number; indexState: 'pending' | 'indexing' | 'ready' | 'failed';
  createdAt: number; updatedAt: number; language?: string; versionLabel?: string;
  sourceKey?: string; sourceUrl?: string; sourceEntryId?: string; discoveryComplete?: boolean;
  knownTotal?: number; pageCount?: number; error?: string; coverPageId?: string;
}
export interface SourceConnection {
  id: string; provider: string; accountId?: string; displayName: string;
  status: 'connected' | 'offline' | 'reauth-required' | 'disconnected' | 'revoked';
  generation: number; createdAt: number; updatedAt: number;
}
export interface SourceBinding {
  id: string; connectionId: string; providerItemId: string; locator: Record<string, unknown>;
  generation: number; createdAt: number; updatedAt: number; status?: 'active' | 'revoked' | 'disconnected';
}
export interface DocumentRevision {
  id: string; documentId: string; containerId?: string; sourceVersion?: string;
  sourceSnapshot?: Record<string, unknown>; parserVersion: string; indexVersion: number;
  generation: number; status: 'indexing' | 'ready' | 'failed' | 'superseded'; createdAt: number;
  pageCount?: number; error?: string;
}
export interface PageDescriptor {
  /** Unique within a revision, stable through repeated indexing; ordinal is never identity. */
  pageId: string; revisionId: string; ordinal: number; name: string;
  formatLocator: string; locator: Record<string, unknown>; width?: number; height?: number;
}
export interface PageMaterialization {
  id: string; pageId: string; revisionId: string; renderProfileId: string; imageSha256: string;
  width: number; height: number; byteSize: number; mime: string; updatedAt: number;
}
export interface ReadingPosition {
  /** One independently saved position per document. */
  id: string; workId: string; documentId: string; revisionId: string; pageId: string;
  relativeOffset: number; updatedAt: number;
}
export interface TranslationBinding {
  id: string; apiOrigin: string; userId: string; imageSha256: string;
  mode?: 'classic' | 'redraw'; language?: string; configVersion?: string; resultVersion?: string;
  operationKey?: string; jobId?: string; payload: unknown; updatedAt: number;
}
export interface CatalogRecord { id: string; [key: string]: unknown }
export interface CatalogTables {
  works: Work; units: ReadingUnit; documents: Document; connections: SourceConnection;
  bindings: SourceBinding; revisions: DocumentRevision; pageDescriptors: PageDescriptor;
  materializations: PageMaterialization; positions: ReadingPosition; translationBindings: TranslationBinding;
  acquisitionTasks: CatalogRecord; translationOperations: CatalogRecord; catalogs: CatalogRecord;
  tasks: CatalogRecord; metadata: CatalogRecord; tombstones: CatalogRecord;
}
export type CatalogTable = keyof CatalogTables;
