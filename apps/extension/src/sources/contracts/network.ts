import type {SourceSnapshot, SourceCatalogSnapshot} from './source';

export interface SourceNetworkContext {
  signal?: AbortSignal;
  previous?: SourceCatalogSnapshot;
  /** Optional same-origin Referer, applied by the runtime to this exact request only. */
  request(url:string, options?:{referer:string}):Promise<string>;
}
/** Packaged parsers only; adapters never execute downloaded site scripts. */
export interface SourceNetwork {
  catalog?(url:string, context:SourceNetworkContext):Promise<SourceCatalogSnapshot>;
  pages?(url:string, context:SourceNetworkContext):Promise<SourceSnapshot>;
}
