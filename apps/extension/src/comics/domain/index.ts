/** Persistent metadata. Bytes, credentials and live browser handles have separate owners. */
export type EntryFormat = 'zip' | 'cbz' | 'rar' | 'cbr' | 'pdf' | 'mobi' | 'website';
export interface ComicSource {
  connectionId: string; providerItemId: string; locator: Record<string, unknown>;
  generation: number; status: 'active' | 'revoked' | 'disconnected';
}
/** One shelf item binds exactly one source resource, never a collection of editions. */
export interface Comic {
  id: string; sourceKey: string; source: ComicSource; title: string;
  createdAt: number; updatedAt: number; lastReadAt?: number; lastEntryId?: string;
  startEntryId?: string; sourceName: string; sourceUrl?: string;
  lastPage?: number; lastPageCount?: number;
  cover?: { entryId: string; contentId: string; pageId: string };
  catalogSync?: { nextCheckAt: number; lastAttemptAt?: number; lastSuccessAt?: number; lease?: string };
  catalogUpdates?: { revision: number; seenRevision: number; count: number };
}
/** Source-owned navigation destination; a file has one implicit entry. */
export interface Entry {
  id: string; comicId: string; title: string; order: number; sequenceId?: string;
  format: EntryFormat; contentId: string; generation: number;
  indexState: 'pending' | 'indexing' | 'ready' | 'failed';
  createdAt: number; updatedAt: number; readAt?: number;
  sourceUrl?: string; sourceEntryId?: string; discoveryComplete?: boolean;
  knownTotal?: number; pageCount?: number; error?: string; coverPageId?: string;
  /** Current content only. There is no revision history or alternative document relation. */
  containerId?: string; sourceSnapshot?: Record<string, unknown>;
  /** Retain reading data when the source removes a destination, but hide it from navigation. */
  sourceRemoved?: boolean;
}
export interface SourceConnection {
  id: string; provider: string; accountId?: string; displayName: string;
  /** Provider-owned display metadata only. Never store credentials or signed URLs here. */
  accountMetadata?: Record<string, string>;
  status: 'connected' | 'offline' | 'reauth-required' | 'disconnected' | 'revoked';
  generation: number; createdAt: number; updatedAt: number;
}
export interface PageDescriptor {
  pageId: string; contentId: string; ordinal: number; name: string;
  formatLocator: string; locator: Record<string, unknown>; width?: number; height?: number;
}
export interface PageMaterialization {
  id: string; pageId: string; contentId: string; renderProfileId: string; imageSha256: string;
  width: number; height: number; byteSize: number; mime: string; updatedAt: number;
}
export interface ReadingPosition {
  id: string; comicId: string; entryId: string; contentId: string; pageId: string;
  relativeOffset: number; updatedAt: number;
}
export interface TranslationBinding {
  id: string; apiOrigin: string; userId: string; imageSha256: string;
  mode?: 'classic' | 'redraw'; language?: string; configVersion?: string; resultVersion?: string;
  operationKey?: string; jobId?: string; payload: unknown; updatedAt: number;
}
export interface CatalogRecord { id: string; [key: string]: unknown }
export interface CatalogTables {
  comics: Comic; entries: Entry; connections: SourceConnection;
  pageDescriptors: PageDescriptor; materializations: PageMaterialization;
  positions: ReadingPosition; translationBindings: TranslationBinding;
  translationOperations: CatalogRecord; catalogs: CatalogRecord;
  tasks: CatalogRecord; metadata: CatalogRecord; tombstones: CatalogRecord;
}
export type CatalogTable = keyof CatalogTables;
