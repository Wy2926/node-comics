import type {Entry, ComicSource, SourceConnection} from '../domain';
import type {ComicFormat, RandomAccessSource} from '../formats/contracts';

export interface SelectedSourceFile {
  id: string; name: string; format: ComicFormat;
  locator: Record<string, unknown>; snapshot: Record<string, unknown>;
}
export interface SourceSelection {
  connection: Pick<SourceConnection, 'id' | 'provider' | 'accountId' | 'displayName' | 'accountMetadata'>;
  files: SelectedSourceFile[];
}
export interface OpenFileSourceContext {
  connection: SourceConnection; source: ComicSource; entryId: string; contentId: string;
  sourceSnapshot?: Record<string, unknown>; format: Entry['format']; containerId?: string; signal?: AbortSignal;
}
export interface SourceAccessChange {connectionId: string; itemId?: string}
/** Plain text supplied by a registered provider; presentation never interprets provider metadata. */
export interface SourceAccountField {id: string; label: string; value: string}
/** Display snapshot, independent of imported comics and their access generations. */
export type SourceAccount = Pick<SourceConnection,'id'|'provider'|'accountId'|'displayName'|'accountMetadata'|'status'>;
export interface FileSourceDriver {
  id: string; label: string; cachePages: boolean; cacheRanges: boolean;
  isConfigured?(): boolean;
  listAccounts?(): Promise<SourceAccount[]>;
  subscribeAccounts?(listener: () => void): () => void;
  describeAccount?(connection: SourceAccount): SourceAccountField[];
  select?(connection?: SourceAccount, signal?: AbortSignal): Promise<SourceSelection>;
  open(context: OpenFileSourceContext): Promise<RandomAccessSource>;
  disconnect?(connection: SourceAccount): Promise<void>;
  subscribe?(listener: (change: SourceAccessChange) => Promise<void>): () => void;
}
