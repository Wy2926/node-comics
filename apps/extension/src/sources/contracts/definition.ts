export interface SourceLocation {
  sourceId: string;
  pageKey: string;
  kind: 'reader' | 'catalog' | 'other';
  url: string;
  catalog?: { key: string; url: string };
}
/** Pure metadata: safe in build tools, UI and the service worker. */
export interface SourceDefinition {
  id: string;
  name: string;
  identify(url: URL): SourceLocation | null;
  capabilities: { pages: boolean; inline: boolean; catalog: boolean; completePageList: boolean; importable?: boolean };
  installation: { requiredOrigins: readonly string[]; autoContentMatches: readonly string[] };
}
