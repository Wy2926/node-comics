import 'fake-indexeddb/auto';
import {describe,it,expect,vi,beforeAll} from 'vitest';
import {makeChapter,emptyPage} from '../src/reader/model';
import {saveChapter,putBlob,getBlob,readChapters,enforceCacheBudget,saveSession,session,saveSettings,savePosition} from '../src/reader/store';
import {defaults} from '../src/types';
import type {Job} from '../src/types';
beforeAll(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)});});
describe('local resource lifecycle',()=>{
it('keeps newly submitted jobs when an older tab saves its chapter snapshot',async()=>{
  const page=emptyPage('job.png',10,10);page.ownerId='reader';page.apiOrigin='http://127.0.0.1:18088';
  const chapter=makeChapter('job merge',[page]);await saveChapter(chapter);
  const job:Job={id:'new-job',input_asset_id:'asset',output_asset_id:null,mode:'redraw',target_language:'en',status:'queued',phase:'queued',cost:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
  await saveChapter({...chapter,pages:[{...page,jobs:[job]}]});await saveChapter(chapter);
  expect((await readChapters()).find(c=>c.id===chapter.id)!.pages[0].jobs.map(j=>j.id)).toEqual(['new-job']);
});
it('preserves a new reader position when another tab writes an old chapter snapshot',async()=>{
  const first=emptyPage('1.png',100,100);const hundred=emptyPage('100.png',100,100);const chapter=makeChapter('cross-tab',[first,hundred]);
  await saveChapter(chapter);savePosition(chapter.id,{pageId:hundred.id,relativeOffset:.42});
  await saveChapter({...chapter,pageId:first.id,relativeOffset:0});
  const restored=(await readChapters()).find(c=>c.id===chapter.id)!;
  expect(restored.pageId).toBe(hundred.id);expect(restored.relativeOffset).toBe(.42);
});
it('evicts blobs and result mappings together so remote results can be restored',async()=>{
  const p=emptyPage('original.png',100,100);p.blobKey='original:eviction';p.outputBlobs={job:'output:eviction'};
  const old=makeChapter('old',[p]);await saveChapter(old);await putBlob(p.blobKey,new Blob([new Uint8Array(8000)]));await putBlob(p.outputBlobs.job,new Blob([new Uint8Array(8000)]));
  const keep=emptyPage('keep.png',100,100);keep.blobKey='original:protected';const active=makeChapter('active',[keep]);await saveChapter(active);await putBlob(keep.blobKey,new Blob([new Uint8Array(8000)]));
  await enforceCacheBudget([old,active],.009,active.id);
  const restored=await readChapters();const evicted=restored.find(c=>c.id===old.id)!.pages[0];
  expect(evicted.blobKey).toBeUndefined();expect(evicted.outputBlobs).toEqual({});expect(await getBlob(keep.blobKey)).toBeInstanceOf(Blob);
});
it('only restores access tokens for their original service origin',()=>{
  saveSettings({...defaults,apiBase:'http://127.0.0.1:18088'});
  saveSession({token:'isolated-unit-test-value',user:{id:'a',name:'a',role:'reader'},apiOrigin:'http://127.0.0.1:18088'});
  expect(session()?.user.id).toBe('a');
  saveSettings({...defaults,apiBase:'https://other-service.example'});
  expect(session()).toBeNull();
  saveSession(null);
});
});
