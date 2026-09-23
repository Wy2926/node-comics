export interface SourceLocation {
  sourceId: string;
  pageKey: string;
  kind: 'reader' | 'catalog' | 'other';
  url: string;
  catalog?: { key: string; url: string };
}
export interface SourceSite {
  id: string;
  name: string;
  url: string;
  /** Packaged icon URL; no third-party image requests when opening the directory. */
  icon: string;
}
/** Pure metadata: safe in build tools, UI and the service worker. */
export interface SourceDefinition {
  id: string;
  name: string;
  sites?: readonly SourceSite[];
  identify(url: URL): SourceLocation | null;
  capabilities: { pages: boolean; inline: boolean; catalog: boolean; completePageList: boolean; importable?: boolean };
  /** Explicit opt-in: only adapters with a verified complete directory may refresh it automatically. */
  catalogSync?: { intervalMinutes: number };
  installation: {
    requiredOrigins: readonly string[];
    autoContentMatches: readonly string[];
    optionalOrigins?: readonly string[];
    /** Register embedded entries only after the matching host permission is granted. */
    optionalContentMatches?: readonly string[];
  };
}
