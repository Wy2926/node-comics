import type {Entry, ComicSource, SourceConnection, PageDescriptor, SourceArtwork} from '../domain';
import type {ComicFormat, RandomAccessSource, IndexedPage, EpubLocation} from '../formats/contracts';

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
export interface SourceConnectionField {
  id:string; label:string; type:'text'|'url'|'password'|'select'; required?:boolean;
  placeholder?:string; description?:string; options?:readonly {value:string;label:string}[];
  showWhen?:{field:string;values:readonly string[]}; sensitive?:boolean;
}
export interface ConnectionCapability {
  fields?:readonly SourceConnectionField[];
  connect?(values:Record<string,string>, account?:SourceAccount, signal?:AbortSignal):Promise<SourceAccount>;
  reconnect?(account:SourceAccount, signal?:AbortSignal):Promise<SourceAccount>;
  list?():Promise<SourceAccount[]>;
  subscribe?(listener:()=>void):()=>void;
  describe?(account:SourceAccount):SourceAccountField[];
  /** Only editable, non-secret values. Empty sensitive inputs preserve provider-owned credentials. */
  configuration?(account:SourceAccount):Promise<Record<string,string>>;
  disconnect?(account:SourceAccount):Promise<void>;
  remove?(account:SourceAccount):Promise<void>;
}
export interface RemotePublication {
  id:string; title:string; authors?:string[]; summary?:string; artwork?:SourceArtwork;
  formats?:string[]; readable?:boolean; reason?:string;
  /** Catalog hint in bytes for the preferred direct file (the first format), if declared. */
  size?:number;
}
export interface RemoteCatalogRequest {
  connection:SourceConnection; location?:string; cursor?:string; search?:string; signal?:AbortSignal;
}
export interface RemoteCatalogPage {
  title:string; location:string; navigation:{id:string;title:string;location:string}[];
  publications:RemotePublication[]; next?:string; previous?:string; searchable?:boolean;
  breadcrumbs?:{title:string;location:string}[];
  groups?:{title:string;navigation:{id:string;title:string;location:string}[];publications:RemotePublication[]}[];
  facets?:{title:string;links:{id:string;title:string;location:string;active?:boolean}[]}[];
}
/** Only durable provider references. Credentials and signed transport URLs stay with the provider. */
export interface RemoteReadingPlan {
  publication:RemotePublication; kind:'pages'|'range-file'|'download-file'; representationId:string;
  format:ComicFormat|'image-sequence'; locator:Record<string,unknown>; snapshot:Record<string,unknown>; size?:number;
}
export interface CatalogCapability {
  browse(request:RemoteCatalogRequest):Promise<RemoteCatalogPage>;
  resolve(connection:SourceConnection, publicationId:string, options?:{purpose?:'read'|'download';signal?:AbortSignal}):Promise<RemoteReadingPlan>;
}
export interface FileTransfer {stream:ReadableStream<Uint8Array>;name:string;size?:number;}
export interface FileCapability {
  select?(connection?:SourceAccount,signal?:AbortSignal):Promise<SourceSelection>;
  open(context:OpenFileSourceContext):Promise<RandomAccessSource>;
  download?(context:OpenFileSourceContext):Promise<FileTransfer>;
}
export interface PageSourceContext extends OpenFileSourceContext {entry?:Entry;}
export interface PageSourceIndex {pages:IndexedPage[];complete:boolean;total?:number;}
export interface PageCapability {
  index(context:PageSourceContext):Promise<PageSourceIndex>;
  read(context:PageSourceContext,page:PageDescriptor):Promise<Blob>;
}
export interface ArtworkCapability {
  read(connection:SourceConnection,artwork:SourceArtwork,signal?:AbortSignal):Promise<Blob>;
}
/** Provider-owned synchronization of the actual reading location, never a prefetched page. */
export interface SourceReadingProgress {
  pageIndex?:number;documentLocation?:EpubLocation;updatedAt?:number;
  /** A read-only catalog snapshot, not a writable reading-position endpoint. */
  snapshot?:boolean;
}
export interface ProgressCapability {
  /** null means synchronization is unavailable; undefined means a writable endpoint has no position yet. */
  read(context:OpenFileSourceContext):Promise<SourceReadingProgress|undefined|null>;
  write(context:OpenFileSourceContext,progress:SourceReadingProgress):Promise<void>;
}
export interface SourceProvider {
  id:string;label:string;cachePages:boolean;cacheRanges:boolean;isConfigured?():boolean;
  connection?:ConnectionCapability;catalog?:CatalogCapability;files?:FileCapability;pages?:PageCapability;artwork?:ArtworkCapability;progress?:ProgressCapability;
  subscribe?(listener:(change:SourceAccessChange)=>Promise<void>):()=>void;
}
/** File-only registration input; the registry adapts it into the same capability record. */
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
