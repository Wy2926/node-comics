import {catalog} from '../repositories';
import {discoverCatalog,sourceCatalogReference,validateSourceCatalog,type SourceCatalogSnapshot} from '../../sources';

/** Only the library's accepted snapshot can pin adapter choices. Discovery does not commit it. */
export async function readWebsiteCatalog(url:string,signal?:AbortSignal,options:{onCatalogProgress?:(snapshot:SourceCatalogSnapshot)=>Promise<void>}={}) {
  const reference=sourceCatalogReference(url);
  const previous=reference?await catalog.get('catalogs',reference.key):undefined;
  return discoverCatalog(url,{previous:previous?validateSourceCatalog(previous):undefined,signal,onCatalogProgress:options.onCatalogProgress});
}
