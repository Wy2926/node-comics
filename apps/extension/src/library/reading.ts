import type {LibraryState} from './types';
import type {ReadingCopy} from '../types';
export function readingSequence(state:LibraryState,copies:ReadingCopy[],current:ReadingCopy):ReadingCopy[]{
 const coverage=state.coverage.find(c=>c.copyId===current.id);if(!coverage||!['chapter','publication'].includes(coverage.target.kind))return [current];
 const catalog=state.catalogs.find(c=>c.entries.some(e=>e.id===current.sourceEntryId));const entry=catalog?.entries.find(e=>e.id===current.sourceEntryId);
 const book=state.publications.find(p=>p.id===coverage.target.id);
 const ordered=coverage.target.kind==='chapter'?state.chapters.filter(c=>c.workId===coverage.workId).sort((a,b)=>a.order-b.order):state.publications.filter(p=>p.workIds.includes(coverage.workId)&&p.seriesId===book?.seriesId).sort((a,b)=>a.order-b.order);
 const orderedCopies=ordered.map(item=>{
  const options=copies.filter(c=>c.source===current.source&&c.versionId===current.versionId&&state.coverage.some(x=>x.copyId===c.id&&x.target.kind===coverage.target.kind&&x.target.id===item.id)&&(!entry||catalog?.entries.some(e=>e.id===c.sourceEntryId&&e.groupIds.some(id=>entry.groupIds.includes(id)))));
  return options.find(c=>c.id===current.id)??options.find(c=>c.manifestRevision===current.manifestRevision)??options[0];
 });
 // A missing chapter or incompatible edition is a boundary, never a reason to skip ahead.
 const at=orderedCopies.findIndex(c=>c?.id===current.id);if(at<0)return [current];
 let start=at,end=at+1;
 while(start>0&&orderedCopies[start-1])start--;
 while(end<orderedCopies.length&&orderedCopies[end])end++;
 return orderedCopies.slice(start,end).filter((c):c is ReadingCopy=>!!c);
}
