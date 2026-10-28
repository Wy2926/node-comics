import type {SourceSnapshot, SourceCatalogSnapshot} from './source';
import type {SourceSearchPage, SourceSearchRequest} from './search';

/** Protocol-wide failure: stop source acquisition rather than retrying every chapter. */
export class SourceProtocolError extends Error {
  readonly kind = 'protocol-changed';
  constructor(message: string) { super(message); this.name = 'SourceProtocolError'; }
}

export interface SourceRequestOptions {
  referer?:string;
  acceptStatuses?:readonly number[];
  form?:Readonly<Record<string,string>>;
  /** This parser consumes desktop HTML even on iPhone Safari. */
  desktop?:boolean;
  /** Verified public GET only; Safari native requests do not carry source cookies. */
  safariTransport?:'public-native';
}

export interface SourceNetworkContext {
  signal?: AbortSignal;
  previous?: SourceCatalogSnapshot;
  /** Optional, validated partial observations; completion still comes from catalog's final result. */
  onCatalogProgress?(snapshot: SourceCatalogSnapshot): Promise<void>;
  /** Adapter-selected Referer, parseable error statuses and bounded form POST apply only to this request. */
  request(url:string, options?:SourceRequestOptions):Promise<string>;
  /** Direct HTTP only: binary response to GET, binary POST or form POST; never replayed or sent through a page session. */
  requestBytes?(url:string, options:{referer:string; body?:Uint8Array; form?:Readonly<Record<string,string>>}):Promise<Uint8Array>;
}
/** Packaged parsers only; adapters never execute downloaded site scripts. */
export interface SourceNetwork {
  /** Operations that need a real source-page session; omitted operations retain direct HTTP. */
  pageTransport?: readonly ('catalog'|'pages')[];
  search?(request: SourceSearchRequest, context: SourceNetworkContext): Promise<SourceSearchPage>;
  /** Resolve missing parent identity from HTTP data; catalog/page transports remain independent. */
  resolveCatalog?(url:string, context:SourceNetworkContext):Promise<string>;
  catalog?(url:string, context:SourceNetworkContext):Promise<SourceCatalogSnapshot>;
  pages?(url:string, context:SourceNetworkContext):Promise<SourceSnapshot>;
}
