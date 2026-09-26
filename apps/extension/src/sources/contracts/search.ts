import type {SourceSite} from './definition';

export interface SourceSearchCapability {
  /** Search requests must stay within these declared installation origins. */
  requestOrigins: readonly string[];
}
export interface SourceSearchRequest {
  siteId: string;
  query: string;
  /** Adapter-owned cursor; the public runtime instead accepts only its issued bound tokens. */
  cursor?: string;
}
export interface SourceSearchHit {
  catalogId: string;
  catalogUrl: string;
  title: string;
  authors?: readonly string[];
  /** Optional content languages explicitly returned by this result; never inferred from the query/site. */
  contentLanguages?: readonly string[];
  cover?: {url: string};
  latestLabel?: string;
}
export interface SourceSearchPage {
  items: readonly SourceSearchHit[];
  nextCursor?: string;
}
export interface SourceSearchResult extends SourceSearchHit {
  sourceId: string;
  siteId: string;
  key: string;
}
export interface SourceSearchResults {
  items: readonly SourceSearchResult[];
  /** Opaque runtime token bound to this session, source, site and query. */
  nextCursor?: string;
}
export interface SourceSearchSite extends SourceSite {
  adapterId: string;
  key: string;
  search: SourceSearchCapability;
}
export interface SourceSearchOptions {
  /** A new value for every submitted query revision; never reuse across sessions. */
  sessionId: string;
  signal?: AbortSignal;
}
export type SourceSearchErrorCode =
  | 'SOURCE_SEARCH_UNSUPPORTED' | 'SOURCE_SEARCH_INVALID' | 'SOURCE_SEARCH_CURSOR_EXPIRED'
  | 'SOURCE_SEARCH_PERMISSION_REQUIRED'
  | 'SOURCE_SEARCH_REQUEST_DENIED' | 'SOURCE_SEARCH_TIMEOUT' | 'SOURCE_SEARCH_HTTP_ERROR'
  | 'SOURCE_SEARCH_RATE_LIMITED' | 'SOURCE_SEARCH_VERIFICATION_REQUIRED';
export class SourceSearchError extends Error {
  constructor(readonly code: SourceSearchErrorCode, readonly retryAfter?: number) {
    super(code);
    this.name = 'SourceSearchError';
  }
}
