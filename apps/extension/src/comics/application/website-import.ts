import {prepareCatalogImport,readImportCatalog,sameSourcePage,sourceFor,validateSourceCatalog,type SourceCatalogSnapshot} from '../../sources';
import {catalog} from '../repositories';
import {readWebsiteCatalog} from './website-catalog';
import {importCatalog} from './import-service';
import {selectReadingEntry} from './reading-preferences';
import {continueEntry} from './library-service';
import {applyCatalogImportProgress} from './catalog-service';
import type {Comic,Entry} from '../domain';

export interface WebsiteImportOptions {
  signal?:AbortSignal;
  readingLanguage?:string;
  /** Called once when verified entries have been saved, while the complete read may still be pending. */
  onReady?(result:{comic:Comic;entry:Entry}):Promise<void>|void;
}

async function selectImportedEntry(comic:Comic,sourceEntryId:string) {
  const [entry]=await catalog.list('entries',{index:'sourceEntry',range:[comic.id,sourceEntryId],limit:1});
  if(!entry||entry.sourceRemoved)throw Error('所选章节已从作品目录移除。');
  if(entry.readable===false)throw Error('所选发布条目暂不可读，无法打开指定章节。');
  await selectReadingEntry(entry.id);
}

/** Only an explicit chapter intent overrides where an existing book resumes. */
export async function importWebsiteCatalog(snapshot:SourceCatalogSnapshot, selectedEntryId?:string) {
  const source=validateSourceCatalog(snapshot);
  if(selectedEntryId!==undefined){
    const selected=source.entries.find(entry=>entry.id===selectedEntryId&&!entry.related);
    if(!selected)throw Error('所选章节不在已确认的作品目录中。');
    if(selected.readable===false)throw Error('所选发布条目暂不可读，无法打开指定章节。');
  }
  const comic=await importCatalog(source);
  if(selectedEntryId!==undefined)await selectImportedEntry(comic,selectedEntryId);
  return comic;
}

async function readAndImportWebsite(sourceUrl:string,options:WebsiteImportOptions,existing?:Comic) {
  let comic=existing,ready=false,selected=false;
  const reader=sourceFor(sourceUrl).location.kind==='reader';
  const notify=async()=>{
    if(ready||!comic||!options.onReady)return;
    options.signal?.throwIfAborted();
    const entry=await continueEntry(comic.id,options.readingLanguage);
    if(!entry||entry.readable===false||entry.sourceRemoved)return;
    ready=true;
    await options.onReady({comic,entry});
    options.signal?.throwIfAborted();
  };
  const accept=async(source:SourceCatalogSnapshot)=>{
    options.signal?.throwIfAborted();
    const target=reader?source.entries.find(entry=>!entry.related&&sameSourcePage(entry.url,sourceUrl)):undefined,selectedEntryId=target?.id;
    if(!source.complete&&(reader?!target||target.readable===false:!source.entries.some(entry=>!entry.related&&entry.readable!==false)))return;
    if(!comic) {
      comic=await importWebsiteCatalog(source,selectedEntryId);
      selected=selectedEntryId!==undefined;
    } else {
      comic=await applyCatalogImportProgress(comic.id,comic.source.generation,source);
      if(selectedEntryId!==undefined&&!selected) {
        await selectImportedEntry(comic,selectedEntryId);selected=true;
      }
    }
    options.signal?.throwIfAborted();
    await notify();
  };
  // Resuming an interrupted directory can use its saved entries immediately.
  if(existing&&!reader)await notify();
  const source=await readImportCatalog(sourceUrl,async(url,readOptions)=>{
    if(!comic) {
      const {definition,location}=sourceFor(url);
      const sourceKey=JSON.stringify(['website:'+definition.id,location.catalog!.key]);
      [comic]=await catalog.list('comics',{index:'sourceKey',range:sourceKey,limit:1});
    }
    options.signal?.throwIfAborted();
    return readWebsiteCatalog(url,readOptions?.signal,{onCatalogProgress:readOptions?.onCatalogProgress});
  },
    {signal:options.signal,onCatalogProgress:accept});
  await accept(source);
  if(!comic)throw Error('无法打开来源。');
  return comic;
}

export async function importWebsiteLink(url:string,options:WebsiteImportOptions={}) {
  options.signal?.throwIfAborted();
  const sourceUrl=await prepareCatalogImport(url);
  return readAndImportWebsite(sourceUrl,options);
}

/** Continue a saved partial directory without creating another book or resetting its reading selection. */
export async function resumeWebsiteCatalog(comicId:string,options:WebsiteImportOptions={}) {
  options.signal?.throwIfAborted();
  const comic=await catalog.get('comics',comicId);
  const connection=comic&&await catalog.get('connections',comic.source.connectionId);
  if(!comic?.sourceUrl||comic.source.status!=='active'||!connection||connection.status!=='connected')throw Error('漫画已移除或来源已断开，请重新打开。');
  const sourceUrl=await prepareCatalogImport(comic.sourceUrl);
  return readAndImportWebsite(sourceUrl,options,comic);
}
