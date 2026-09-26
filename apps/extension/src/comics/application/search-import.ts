import {prepareCatalogImport,readImportCatalog,sourceFor,type SourceSearchResult} from '../../sources';
import {catalog} from '../repositories';
import {readWebsiteCatalog} from './website-catalog';
import {importWebsiteCatalog} from './website-import';
import {continueEntry} from './library-service';
import {msg} from '../../i18n/runtime';

export async function importSearchResult(hit:SourceSearchResult,readingLanguage?:string) {
  const resolved=sourceFor(hit.catalogUrl);
  if(resolved.definition.id!==hit.sourceId||resolved.location.kind!=='catalog'||resolved.location.catalog?.key!==hit.catalogId)
    throw Error(msg('搜索结果来源已失效，请重新搜索。'));
  await prepareCatalogImport(hit.catalogUrl);
  const sourceKey=JSON.stringify(['website:'+hit.sourceId,hit.catalogId]);
  const [existing]=await catalog.list('comics',{index:'sourceKey',range:sourceKey,limit:1});
  // Existing books resume without changing their source preference or chapter choice.
  const comic=existing??await importWebsiteCatalog(await readImportCatalog(hit.catalogUrl,readWebsiteCatalog));
  // Name translation does not select a chapter language or change this book's preferences.
  const entry=await continueEntry(comic.id,readingLanguage);
  if(!entry)throw Error(msg('无法打开来源。'));
  return {comic,entry};
}
