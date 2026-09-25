import {authorizeCatalogImport,readImportCatalog} from '../../sources';
import {readWebsiteCatalog} from './website-catalog';
import {importCatalog} from './import-service';

export async function importWebsiteLink(url:string) {
  const sourceUrl=await authorizeCatalogImport(url);
  return importCatalog(await readImportCatalog(sourceUrl,readWebsiteCatalog));
}
