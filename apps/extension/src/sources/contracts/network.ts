import type {SourceSnapshot, SourceCatalogSnapshot} from './source';
import type {SourceSearchPage, SourceSearchRequest} from './search';

export interface SourceNetworkContext {
  signal?: AbortSignal;
  previous?: SourceCatalogSnapshot;
  /** Optional, validated partial observations; completion still comes from catalog's final result. */
  onCatalogProgress?(snapshot: SourceCatalogSnapshot): Promise<void>;
  /** Same-origin Referer, parseable error statuses and optional bounded form POST apply only to this request. */
  request(url:string, options?:{referer:string; acceptStatuses?:readonly number[]; form?:Readonly<Record<string,string>>}):Promise<string>;
}
/** Packaged parsers only; adapters never execute downloaded site scripts. */
export interface SourceNetwork {
  search?(request: SourceSearchRequest, context: SourceNetworkContext): Promise<SourceSearchPage>;
  /** Resolve missing parent identity from HTTP data; catalog/page transports remain independent. */
  resolveCatalog?(url:string, context:SourceNetworkContext):Promise<string>;
  catalog?(url:string, context:SourceNetworkContext):Promise<SourceCatalogSnapshot>;
  pages?(url:string, context:SourceNetworkContext):Promise<SourceSnapshot>;
}
