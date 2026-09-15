import type {ReadingCopy} from '../types';
import type {LibraryState} from './types';

/** Catalog/group order is stable across clicks, image events and copy updates. */
export function acquisitionCopies(state:LibraryState,copies:ReadingCopy[]):ReadingCopy[]{
 const ranks=new Map<string,number>();
 const add=(id:string)=>{if(!ranks.has(id))ranks.set(id,ranks.size);};
 for(const catalog of state.catalogs){
  for(const group of catalog.groups)for(const id of group.entryIds)add(id);
  for(const entry of [...catalog.entries].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)))add(entry.id);
 }
 return copies.filter(c=>!!c.sourceEntryId).sort((a,b)=>
  (ranks.get(a.sourceEntryId!)??Number.MAX_SAFE_INTEGER)-(ranks.get(b.sourceEntryId!)??Number.MAX_SAFE_INTEGER)
  ||a.manifestRevision-b.manifestRevision||a.id.localeCompare(b.id));
}

export function orderAcquisitionTasks(state:LibraryState,copies:ReadingCopy[]){
 const ranks=new Map(acquisitionCopies(state,copies).map((copy,n)=>[copy.id,n]));
 state.tasks.sort((a,b)=>(ranks.get(a.copyId)??Number.MAX_SAFE_INTEGER)-(ranks.get(b.copyId)??Number.MAX_SAFE_INTEGER)||a.copyId.localeCompare(b.copyId));
}
