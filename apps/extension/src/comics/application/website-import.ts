import {authorizeCatalogImport,readImportCatalog,sameSourcePage,sourceFor,validateSourceCatalog,type SourceCatalogSnapshot} from '../../sources';
import {catalog} from '../repositories';
import {readWebsiteCatalog} from './website-catalog';
import {importCatalog} from './import-service';
import {selectReadingEntry} from './reading-preferences';

/** Only an explicit chapter intent overrides where an existing book resumes. */
export async function importWebsiteCatalog(snapshot:SourceCatalogSnapshot, selectedEntryId?:string) {
  const source=validateSourceCatalog(snapshot);
  if(selectedEntryId!==undefined){
    const selected=source.entries.find(entry=>entry.id===selectedEntryId&&!entry.related);
    if(!selected)throw Error('所选章节不在已确认的作品目录中。');
    if(selected.readable===false)throw Error('所选发布条目暂不可读，无法打开指定章节。');
  }
  const comic=await importCatalog(source);
  if(selectedEntryId!==undefined){
    const [entry]=await catalog.list('entries',{index:'sourceEntry',range:[comic.id,selectedEntryId],limit:1});
    if(!entry||entry.sourceRemoved)throw Error('所选章节已从作品目录移除。');
    if(entry.readable===false)throw Error('所选发布条目暂不可读，无法打开指定章节。');
    await selectReadingEntry(entry.id);
  }
  return comic;
}

export async function importWebsiteLink(url:string) {
  const sourceUrl=await authorizeCatalogImport(url);
  const source=await readImportCatalog(sourceUrl,readWebsiteCatalog);
  const selectedEntryId=sourceFor(sourceUrl).location.kind==='reader'
    ?source.entries.find(entry=>!entry.related&&sameSourcePage(entry.url,sourceUrl))?.id:undefined;
  return importWebsiteCatalog(source,selectedEntryId);
}
