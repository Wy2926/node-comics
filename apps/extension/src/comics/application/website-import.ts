import {authorizeCatalogImport} from '../../sources';
import {readWebsiteCatalog} from './website-catalog';
import {importCatalog} from './import-service';

export async function importWebsiteLink(url:string) {
  const source=await authorizeCatalogImport(url);
  return importCatalog(await readWebsiteCatalog(source.url));
}
