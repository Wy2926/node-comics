import {catalog} from '../repositories';
import type {Entry} from '../domain';
import {downloadStore} from '../../storage/downloads';
import {bookDownloadId,downloadTaskId,isEntryFullyCached} from '../acquisition/book-model';

/** Retained originals, independent of the current book plan or selected languages. */
export async function cachedEntryIds(entryIds:readonly string[]):Promise<Set<string>>{
  const entries=(await Promise.all([...new Set(entryIds)].map(id=>catalog.get('entries',id))))
    .filter((entry):entry is Entry=>!!entry&&isEntryFullyCached(entry,entry.pageCount??0));
  const saved=await downloadStore.inventory(entries.map(entry=>entry.id),true),counts=new Map<string,number>();
  const contents=new Map(entries.map(entry=>[entry.id,entry.contentId]));
  for(const page of saved)if(page.owner&&page.contentId===contents.get(page.owner))counts.set(page.owner,(counts.get(page.owner)??0)+1);
  return new Set(entries.filter(entry=>isEntryFullyCached(entry,counts.get(entry.id)??0)).map(entry=>entry.id));
}

/** Narrow per-page progress invalidations to the affected entry instead of rereading the directory. */
export function subscribeCachedEntries(comicId:string|undefined,entryIds:readonly string[],changed:(ids:string[])=>void){
  const ids=new Set(entryIds),tasks=new Map(entryIds.map(id=>[downloadTaskId(id),id]));
  return catalog.subscribe(change=>{
    const affected=comicId&&change.table==='metadata'&&change.ids.includes(bookDownloadId(comicId))?[...ids]:
      change.table==='entries'?change.ids.filter((id):id is string=>typeof id==='string'&&ids.has(id)):
      change.table==='tasks'?change.ids.flatMap(id=>typeof id==='string'&&tasks.has(id)?[tasks.get(id)!]:[]):[];
    if(affected.length)changed(affected);
  });
}
