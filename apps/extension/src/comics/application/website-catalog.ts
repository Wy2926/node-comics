import {catalog} from '../repositories';
import {discoverCatalog,sourceCatalogReference,validateSourceCatalog,type SourceCatalogSnapshot} from '../../sources';

/** Only the library's accepted snapshot can pin adapter choices. Discovery does not commit it. */
export async function readWebsiteCatalog(url:string,signal?:AbortSignal,options:{onCatalogProgress?:(snapshot:SourceCatalogSnapshot)=>Promise<void>}={}) {
  const reference=sourceCatalogReference(url);
  const saved=reference?await catalog.get('catalogs',reference.key):undefined;
  let previous:SourceCatalogSnapshot|undefined;
  if(saved)try {previous=validateSourceCatalog(saved);} catch(error) {
    if(!(error instanceof Error)||error.message!=='INVALID_SOURCE_CATALOG')throw error;
  }
  // Obsolete snapshots cannot pin discovery; keep them until a complete replacement is verified.
  return discoverCatalog(url,{previous,signal,onCatalogProgress:saved&&!previous?undefined:options.onCatalogProgress});
}
