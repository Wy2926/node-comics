import type {Entry, ComicSource, SourceConnection} from '../domain';
import type {ComicFormat, RandomAccessSource} from '../formats/contracts';

export interface SelectedSourceFile {
  id: string; name: string; format: ComicFormat;
  locator: Record<string, unknown>; snapshot: Record<string, unknown>;
}
export interface SourceSelection {
  connection: Pick<SourceConnection, 'id' | 'provider' | 'accountId' | 'displayName'>;
  files: SelectedSourceFile[];
}
export interface OpenFileSourceContext {
  connection: SourceConnection; source: ComicSource; entryId: string; contentId: string;
  sourceSnapshot?: Record<string, unknown>; format: Entry['format']; containerId?: string; signal?: AbortSignal;
}
export interface SourceAccessChange {connectionId: string; itemId?: string}
export interface FileSourceDriver {
  id: string; label: string; cachePages: boolean; cacheRanges: boolean;
  isConfigured?(): boolean;
  select?(connection?: SourceConnection, signal?: AbortSignal): Promise<SourceSelection>;
  open(context: OpenFileSourceContext): Promise<RandomAccessSource>;
  disconnect?(connection: SourceConnection): Promise<void>;
  subscribe?(listener: (change: SourceAccessChange) => Promise<void>): () => void;
}
