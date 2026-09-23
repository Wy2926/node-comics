export interface SourceItem {
  id: string;
  url: string;
  width: number;
  height: number;
  order: number;
  kind?: 'page';
  preview?: string;
  /** Adapter-owned, durable image decoding recipe. */
  processing?: string;
}
export interface PageManifest {
  id: string;
  /** Only page-bound resources require a live document authorization. */
  pageContext?: {tabId:number; navigationId:string};
  revision: number;
  title: string;
  url: string;
  adapter: string;
  direction: 'ltr' | 'rtl';
  discoveryComplete: boolean;
  knownTotal?: number;
  note: string;
  items: SourceItem[];
}
export type ImageResource = { kind: 'http'; url: string; processing?:string } | { kind: 'page'; resourceKey: string };
export interface DiscoveredPage {
  id: string;
  width: number;
  height: number;
  order: number;
  resource: ImageResource;
}
export type PageSnapshot = Omit<PageManifest, 'id' | 'pageContext' | 'revision'>;
export type DocumentSnapshot = PageSnapshot & {navigationId:string; revision:number};
export type SourceSnapshot = Omit<PageSnapshot, 'items'> & { items: DiscoveredPage[] };
export interface SourceEntry {
  id: string;
  catalogId: string;
  remoteId: string;
  url: string;
  title: string;
  groupIds: string[];
  rawTypes: string[];
  order: number;
  related: boolean;
  /** Only the adapter defines a safe continuous reading sequence. */
  sequenceId?: string;
}
export interface SourceGroup {
  id: string;
  title: string;
  entryIds: string[];
  complete: boolean;
  parentId?: string;
}
export interface SourceCatalogSnapshot {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  observedAt: number;
  complete: boolean;
  note: string;
  groups: SourceGroup[];
  entries: SourceEntry[];
  defaultEntryId?: string;
}
