import type {ComicTitleTranslation} from '../../../api';
import type {SourceSearchOptions,SourceSearchRequest,SourceSearchResult,SourceSearchResults,SourceSearchSite} from '../../../sources';

export interface SearchSeed {
  title:string;
  origin?:{sourceId:string;catalogId:string;url:string};
  cover?:{url:string};
  coverKey?:string;
  sourceName?:string;
  comicId?:string;
}
export type SearchPhase='idle'|'resolving-name'|'needs-query'|'searching'|'settled'|'stopped';
export type SearchSiteStatus='idle'|'queued'|'running'|'ready'|'empty'|'error'|'stopped';
export type SearchFailureKind='login'|'rate-limit'|'verification'|'permission'|'timeout'|'invalid'|'unavailable';
export interface SearchFailure {kind:SearchFailureKind;message:string;retryAt?:number}
export interface SearchCandidate extends SourceSearchResult {
  /** Original runtime-issued hit when a verified mirror fills a missing cover. */
  coverHit?:SourceSearchResult;
}
export interface SearchSiteState {
  site:SourceSearchSite;
  selected:boolean;
  status:SearchSiteStatus;
  resultCount:number;
  resultKeys:readonly string[];
  nextCursor?:string;
  /** Cursor of the failed page, so retry does not repeat the first page. */
  requestCursor?:string;
  error?:SearchFailure;
}
export interface ComicSearchSnapshot {
  sourceTitle:string;
  requestedTitleLanguage:string;
  resolvedTitleLanguage?:string;
  query:string;
  phase:SearchPhase;
  titleState:'idle'|'resolving'|'resolved'|'missing'|'manual'|'error';
  titleError?:SearchFailure;
  titleRetryAt?:number;
  sites:readonly SearchSiteState[];
  results:readonly SearchCandidate[];
  searchedAt?:number;
  revision:number;
}
export interface ComicSearchDependencies {
  translateTitle:(name:string,targetLanguage:string,signal?:AbortSignal)=>Promise<ComicTitleTranslation>;
  listSites:()=>SourceSearchSite[];
  search:(sourceId:string,request:SourceSearchRequest,options:SourceSearchOptions)=>Promise<SourceSearchResults>;
  release:(sessionId:string)=>void;
  now?:()=>number;
}
