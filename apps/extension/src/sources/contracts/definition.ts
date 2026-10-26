export interface SourceLocation {
  sourceId: string;
  pageKey: string;
  kind: 'reader' | 'catalog' | 'other';
  url: string;
  catalog?: { key: string; url: string };
}
export type SourceSiteContentTag = 'western' | 'manga' | 'manhwa' | 'manhua' | 'webtoon' | 'doujin' | 'illustration';
export type SourceSiteAccessTag = 'login-required' | 'partial-web';
export type SourceSitePricing = 'free' | 'freemium' | 'unknown';
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
  /** Reading charges, independent of optional account extras; unknown is not free. */
  pricing: SourceSitePricing;
  /** Primarily untranslated Japanese/Korean originals, not inferred from the UI language. */
  isRaw: boolean;
  /** Confirmed reading conditions affecting at least part of the site's comics; not account extras. */
  accessTags?: readonly SourceSiteAccessTag[];
  /** Confirmed main content types; independent of pricing, language and reading conditions. */
  contentTags: readonly SourceSiteContentTag[];
  search?: true;
  /** Verified source page size when it exceeds the default search result budget; hard capped by the runtime. */
  searchPageSize?: number;
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
  /** Reuse generic recognition on every claimed page, independently of its import kind; HTTP catalog/pages remain authoritative. */
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
