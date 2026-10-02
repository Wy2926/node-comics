import {prepareCatalogImport,sourceFor,type SourceSearchResult} from '../../sources';
import {catalog} from '../repositories';
import {importWebsiteLink,resumeWebsiteCatalog,type WebsiteImportOptions} from './website-import';
import {continueEntry} from './library-service';
import {msg} from '../../i18n/runtime';

export async function importSearchResult(hit:SourceSearchResult,readingLanguage?:string,options:WebsiteImportOptions={}) {
  options.signal?.throwIfAborted();
  const resolved=sourceFor(hit.catalogUrl);
  if(resolved.definition.id!==hit.sourceId||resolved.location.kind!=='catalog'||resolved.location.catalog?.key!==hit.catalogId)
    throw Error(msg('搜索结果来源已失效，请重新搜索。'));
  await prepareCatalogImport(hit.catalogUrl);
  const sourceKey=JSON.stringify(['website:'+hit.sourceId,hit.catalogId]);
  const [existing]=await catalog.list('comics',{index:'sourceKey',range:sourceKey,limit:1});
  // Existing books resume without changing their source preference or chapter choice.
  const saved=existing&&await catalog.get('catalogs',hit.catalogId);
  const incomplete=existing&&saved?.complete===false;
  const comic=incomplete?await resumeWebsiteCatalog(existing.id,{...options,readingLanguage})
    :existing??await importWebsiteLink(hit.catalogUrl,{...options,readingLanguage});
  // Name translation does not select a chapter language or change this book's preferences.
  const entry=await continueEntry(comic.id,readingLanguage);
  if(!entry)throw Error(msg('无法打开来源。'));
  options.signal?.throwIfAborted();
  if(existing&&!incomplete)await options.onReady?.({comic,entry});
  return {comic,entry};
}
