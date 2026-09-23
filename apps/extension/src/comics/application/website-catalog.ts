import {catalog} from '../repositories';
import {discoverCatalog,sourceCatalogReference,validateSourceCatalog} from '../../sources';

/** Only the library's accepted snapshot can pin adapter choices. Discovery does not commit it. */
export async function readWebsiteCatalog(url:string) {
  const reference=sourceCatalogReference(url);
  const previous=reference?await catalog.get('catalogs',reference.key):undefined;
  return discoverCatalog(url,{previous:previous?validateSourceCatalog(previous):undefined});
}
