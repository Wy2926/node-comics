export interface SourceLocation {
  sourceId: string;
  pageKey: string;
  kind: 'reader' | 'catalog' | 'other';
  url: string;
  catalog?: { key: string; url: string };
}
export type SourceSiteContentTag = 'manga' | 'manhwa' | 'manhua' | 'webtoon' | 'doujin';
export type SourceSiteAccessTag = 'login-required' | 'partial-web' | 'paid-content';
export interface SourceSite {
  id: string;
  name: string;
  url: string;
  /** Packaged icon URL; no third-party image requests when opening the directory. */
  icon: string;
  /** Main content languages (BCP 47), in display order; not an exhaustive catalog filter. */
  primaryLanguages: readonly string[];
  /** First supported date, YYYY-MM-DD; independent of later adapter fixes. */
  adaptedOn: string;
  /** True only when all comics on this site can be read for free. */
  isFree?: boolean;
  /** Confirmed reading conditions affecting at least part of the site's comics; not account extras. */
  accessTags?: readonly SourceSiteAccessTag[];
  /** Main comic types, not exhaustive; 1–3 display tags independent of the free status. */
  contentTags: readonly SourceSiteContentTag[];
  search?: true;
}
/** Pure metadata: safe in build tools, UI and the service worker. */
export interface SourceDefinition {
  id: string;
  name: string;
  sites?: readonly SourceSite[];
  identify(url: URL): SourceLocation | null;
  capabilities: { pages: boolean; inline: boolean; catalog: boolean; completePageList: boolean; importable?: boolean; findAlternatives?: boolean };
  /** Use the shared floating import entry when the site has no stable inline anchor. */
  embeddedEntry?: 'floating';
  /** Explicit reuse of loaded-image recognition; HTTP catalog/pages remain authoritative. */
  inlineRecognition?: 'generic';
  /** Explicit opt-in: only adapters with a verified complete directory may refresh it automatically. */
  catalogSync?: { intervalMinutes: number };
  installation: {
    /** Content-script placement only; network access uses the extension's host permissions. */
    autoContentMatches: readonly string[];
    /** Register embedded entries only after the matching host permission is granted. */
    optionalContentMatches?: readonly string[];
  };
}
