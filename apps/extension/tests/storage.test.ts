import 'fake-indexeddb/auto';
import {describe,it,expect,vi,beforeAll} from 'vitest';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';
import {saveCopy,commitCopies,putBlob,getBlob,readCopies,enforceCacheBudget,saveSession,session,saveSettings,savePosition,settings} from '../src/library/store';
import {defaults} from '../src/types';
import type {Job} from '../src/types';
beforeAll(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)});});
describe('local resource lifecycle',()=>{
it('persists file identities independently of visible ordering and deletion',async()=>{
  const pages=[0,1,2].map(pageIndex=>({...emptyPage(`${pageIndex}.png`,10,10),fileHash:'a'.repeat(64),pageIndex}));
  const copy=makeCopy('stable ordinals',pages);await commitCopies([copy],[{title:copy.title,kind:'unclassified'}]);
  await saveCopy({...copy,manifestRevision:2,pages:[pages[2],pages[0]],pageId:pages[2].id});
  const restored=(await readCopies()).find(c=>c.id===copy.id)!;
  expect(restored.pages.map(p=>[p.fileHash,p.pageIndex])).toEqual([['a'.repeat(64),2],['a'.repeat(64),0]]);
});
it('persists only the local request concurrency, clamping malformed saved settings',()=>{
  saveSettings({...defaults,requestConcurrency:10});expect(settings().requestConcurrency).toBe(10);
  localStorage.setItem('nc-settings',JSON.stringify({requestConcurrency:100}));expect(settings().requestConcurrency).toBe(10);
  localStorage.setItem('nc-settings',JSON.stringify({requestConcurrency:null}));expect(settings().requestConcurrency).toBe(2);
  saveSettings(defaults);
});
it('keeps newly submitted jobs when an older tab saves its copy snapshot',async()=>{
  const page=emptyPage('job.png',10,10);page.ownerId='reader';page.apiOrigin='http://127.0.0.1:18088';
  const copy=makeCopy('job merge',[page]);await commitCopies([copy],[{title:copy.title,kind:'unclassified'}]);
  const job:Job={id:'new-job',input_asset_id:'asset',output_asset_id:null,mode:'redraw',target_language:'en',status:'queued',phase:'queued',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
  await saveCopy({...copy,pages:[{...page,jobs:[job]}]});await saveCopy(copy);
  expect((await readCopies()).find(c=>c.id===copy.id)!.pages[0].jobs.map(j=>j.id)).toEqual(['new-job']);
});
it('does not resurrect a removed result when another tab saves an older successful job',async()=>{
  const page={...emptyPage('removed.png',10,10),ownerId:'reader',apiOrigin:'http://127.0.0.1:18088'};
  const job:Job={id:'removed-result',input_asset_id:'original',output_asset_id:'result',mode:'classic',target_language:'en',status:'succeeded',phase:'completed',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
  const stale=makeCopy('removed result',[{...page,jobs:[job]}]);await commitCopies([stale],[{title:stale.title,kind:'unclassified'}]);
  await saveCopy({...stale,pages:[{...page,jobs:[{...job,output_asset_id:null}]}]});
  await saveCopy(stale);
  expect((await readCopies()).find(c=>c.id===stale.id)!.pages[0].jobs[0]).toMatchObject({output_asset_id:null,result_available:false,result_expired:true});
});
it('only saves current preference fields, keeping upload authorization in durable manifests',()=>{
  saveSettings({...defaults,...{autoTranslate:true,autoLimit:50}});
  const stored=JSON.parse(localStorage.getItem('nc-settings')!);
  expect(stored).not.toHaveProperty('autoTranslate');expect(stored).not.toHaveProperty('autoLimit');
  expect(stored.language).toBe(defaults.language);
});
it('stores no-expiry assets and accepts a later explicit retention policy',async()=>{
  const p={...emptyPage('retained.png',10,10),ownerId:'reader',apiOrigin:'https://api.example',assetId:'permanent',assetExpiresAt:null};
  const copy=makeCopy('long-term source',[p]);await commitCopies([copy],[{title:copy.title,kind:'unclassified'}]);
  await saveCopy({...copy,pages:[{...p,assetExpiresAt:undefined}]});
  expect((await readCopies()).find(c=>c.id===copy.id)!.pages[0].assetExpiresAt).toBeNull();
  await saveCopy({...copy,pages:[{...p,assetExpiresAt:'2026-09-16T00:00:00Z'}]});
  expect((await readCopies()).find(c=>c.id===copy.id)!.pages[0].assetExpiresAt).toBe('2026-09-16T00:00:00Z');
});
it('preserves a new reader position when another tab writes an old copy snapshot',async()=>{
  const first=emptyPage('1.png',100,100);const hundred=emptyPage('100.png',100,100);const copy=makeCopy('cross-tab',[first,hundred]);
  await commitCopies([copy],[{title:copy.title,kind:'unclassified'}]);savePosition(copy.id,copy.manifestRevision,{pageId:hundred.id,relativeOffset:.42});
  await saveCopy({...copy,pageId:first.id,relativeOffset:0});
  const restored=(await readCopies()).find(c=>c.id===copy.id)!;
  expect(restored.pageId).toBe(hundred.id);expect(restored.relativeOffset).toBe(.42);
});
it('evicts blobs and result mappings together so remote results can be restored',async()=>{
  const p=emptyPage('original.png',100,100);p.blobKey='original:eviction';p.outputBlobs={job:'output:eviction'};
  const old={...makeCopy('old',[p]),retention:'cache' as const};await commitCopies([old],[{title:old.title,kind:'unclassified'}]);await putBlob(p.blobKey,new Blob([new Uint8Array(8000)]));await putBlob(p.outputBlobs.job,new Blob([new Uint8Array(8000)]));
  const keep=emptyPage('keep.png',100,100);keep.blobKey='original:protected';const active=makeCopy('active',[keep]);await commitCopies([active],[{title:active.title,kind:'unclassified'}]);await putBlob(keep.blobKey,new Blob([new Uint8Array(8000)]));
  await enforceCacheBudget([old,active],.009,active.id);
  const restored=await readCopies();const evicted=restored.find(c=>c.id===old.id)!.pages[0];
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
