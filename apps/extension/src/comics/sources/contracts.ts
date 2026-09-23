import type {Document, DocumentRevision, SourceBinding, SourceConnection} from '../domain';
import type {ComicFormat, RandomAccessSource} from '../formats/contracts';

/** Provider-owned identifiers and snapshots are opaque to catalog, reading and UI code. */
export interface SelectedSourceFile {
  id: string;
  name: string;
  format: ComicFormat;
  sourceKey: string;
  locator: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}
export interface SourceSelection {
  connection: Pick<SourceConnection, 'id' | 'provider' | 'accountId' | 'displayName'>;
  files: SelectedSourceFile[];
}
export interface OpenFileSourceContext {
  connection: SourceConnection;
  binding: SourceBinding;
  revision: DocumentRevision;
  documentId: string;
  format: Document['format'];
  containerId?: string;
  signal?: AbortSignal;
}
export interface SourceAccessChange {
  connectionId: string;
  /** Stable provider item identity, distinct from a document's version/deduplication key. */
  itemId?: string;
}
export interface FileSourceDriver {
  id: string;
  label: string;
  cachePages: boolean;
  cacheRanges: boolean;
  isConfigured?(): boolean;
  select?(connection?: SourceConnection, signal?: AbortSignal): Promise<SourceSelection>;
  open(context: OpenFileSourceContext): Promise<RandomAccessSource>;
  disconnect?(connection: SourceConnection): Promise<void>;
  subscribe?(listener: (change: SourceAccessChange) => Promise<void>): () => void;
}
