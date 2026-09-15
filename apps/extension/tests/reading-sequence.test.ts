import 'fake-indexeddb/auto';
import {describe,expect,it} from 'vitest';
import {emptyLibrary,makeCopy,attachCopy} from '../src/library/model';
import {readingSequence} from '../src/library/reading';
import {emptyPage} from '../src/reader/model';
import {completeManifest,pageKey} from '../src/reader/useChapterStream';
import {commitCopies,markCopyRead,readLibrary,saveCopy} from '../src/library/store';

function series(){
 const state=emptyLibrary(),copies=[0,1,2].map(n=>makeCopy(`第 ${n+1} 话`,[{...emptyPage('page',800,1200),id:'same-page-id',blobKey:'original'}]));
 let workId:string|undefined;
 copies.forEach(c=>{workId=attachCopy(state,c,{title:c.title,kind:'chapter',workId});});
 return {state,copies};
}
describe('chapter continuation boundaries',()=>{
 it('keeps ordered adjacent chapters even when input copies are sorted by recent reading',()=>{const {state,copies}=series();expect(readingSequence(state,[...copies].reverse(),copies[1])).toEqual(copies);});
 it('does not skip an unimported chapter',()=>{const {state,copies}=series();expect(readingSequence(state,[copies[0],copies[2]],copies[0])).toEqual([copies[0]]);});
 it('does not skip a chapter available only in another version or source',()=>{const {state,copies}=series();copies[1].versionId='other';expect(readingSequence(state,copies,copies[0])).toEqual([copies[0]]);copies[1].versionId=undefined;copies[1].source='other';expect(readingSequence(state,copies,copies[2])).toEqual([copies[2]]);});
 it('retains an empty next chapter so its acquisition state can be shown',()=>{const {state,copies}=series();copies[1].pages=[];expect(readingSequence(state,copies,copies[0])[1]).toBe(copies[1]);});
 it('does not treat an empty, partial or inconsistent manifest as the end of a chapter',()=>{const c=series().copies[0];expect(completeManifest(c)).toBe(true);expect(completeManifest({...c,pages:[]})).toBe(false);expect(completeManifest({...c,sourceEntryId:'source',discoveryComplete:false})).toBe(false);expect(completeManifest({...c,sourceEntryId:'source',knownTotal:2})).toBe(false);});
 it('isolates identical page IDs in different chapters',()=>{const {copies}=series();expect(pageKey(copies[0],'same-page-id')).not.toBe(pageKey(copies[1],'same-page-id'));});
});
describe('automatic read persistence',()=>{
 it('preserves the first read timestamp through repeated completion and stale position saves',async()=>{
  const c=series().copies[0];await commitCopies([c],[{title:'已读验收',kind:'chapter'}]);
  await markCopyRead(c.id);const state=await readLibrary(),chapterId=state.coverage.find(x=>x.copyId===c.id)!.target.id;const first=state.chapters.find(ch=>ch.id===chapterId)!.readAt;expect(first).toBeTruthy();
  await Promise.all([markCopyRead(c.id),markCopyRead(c.id),saveCopy(c)]);
  expect((await readLibrary()).chapters.find(ch=>ch.id===chapterId)!.readAt).toBe(first);
 });
});
