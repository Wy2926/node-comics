export interface SourceItem {
  id: string;
  url: string;
  width: number;
  height: number;
  order: number;
  kind?: 'page';
  preview?: string;
}
export interface PageManifest {
  id: string;
  sourceTabId: number;
  navigationId: string;
  revision: number;
  title: string;
  url: string;
  adapter: string;
  direction: 'ltr' | 'rtl';
  discoveryComplete: boolean;
  knownTotal?: number;
  note: string;
  items: SourceItem[];
  selectionConfirmed?: boolean;
}
export type ImageResource = { kind: 'http'; url: string } | { kind: 'page'; resourceKey: string };
export interface DiscoveredPage {
  id: string;
  width: number;
  height: number;
  order: number;
  resource: ImageResource;
}
export type PageSnapshot = Omit<PageManifest, 'id' | 'sourceTabId' | 'navigationId' | 'revision'>;
export type SourceSnapshot = Omit<PageSnapshot, 'items'> & { items: DiscoveredPage[] };
export type SourceKind = 'chapter' | 'extra' | 'publication' | 'work' | 'unclassified';
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
  suggestedKind?: SourceKind;
}
export interface SourceGroup {
  id: string;
  title: string;
  entryIds: string[];
  complete: boolean;
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
}
