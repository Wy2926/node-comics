import {API_ORIGIN} from '../src/service';
import 'fake-indexeddb/auto';
import {describe,it,expect,vi,beforeAll} from 'vitest';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';
import {saveCopy,commitCopies,putBlob,getBlob,readCopies,enforceCacheBudget,saveSession,session,saveSettings,savePosition,settings,clearLocalImages,clearTranslations,readLibrary} from '../src/library/store';
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
it('ignores and stops saving the removed transfer concurrency preference',()=>{
  localStorage.setItem('nc-settings',JSON.stringify({requestConcurrency:1}));
  expect(settings()).not.toHaveProperty('requestConcurrency');
  saveSettings(settings());
  expect(JSON.parse(localStorage.getItem('nc-settings')!)).not.toHaveProperty('requestConcurrency');
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
it('evicts only translated blobs and preserves original files even above the budget',async()=>{
  const p=emptyPage('original.png',100,100);p.blobKey='original:eviction';p.outputBlobs={job:'output:eviction'};
  const old={...makeCopy('old',[p]),retention:'cache' as const};await commitCopies([old],[{title:old.title,kind:'unclassified'}]);await putBlob(p.blobKey,new Blob([new Uint8Array(8000)]));await putBlob(p.outputBlobs.job,new Blob([new Uint8Array(8000)]));
  const keep=emptyPage('keep.png',100,100);keep.blobKey='original:protected';const active=makeCopy('active',[keep]);await commitCopies([active],[{title:active.title,kind:'unclassified'}]);await putBlob(keep.blobKey,new Blob([new Uint8Array(8000)]));
  await enforceCacheBudget([old,active],.009,active.id);
  const restored=await readCopies();const evicted=restored.find(c=>c.id===old.id)!.pages[0];
  expect(evicted.blobKey).toBe(p.blobKey);expect(await getBlob(p.blobKey!)).toBeInstanceOf(Blob);expect(evicted.outputBlobs).toEqual({});expect(await getBlob(keep.blobKey)).toBeInstanceOf(Blob);
});
it('only restores access tokens for their original service origin',()=>{
  saveSettings(defaults);
  saveSession({token:'isolated-unit-test-value',user:{id:'a',name:'a',role:'reader'},apiOrigin:API_ORIGIN});
  expect(session()?.user.id).toBe('a');
  saveSession({token:'other',user:{id:'b',name:'b',role:'reader'},apiOrigin:'https://other-service.example'});
  expect(session()).toBeNull();
  saveSession(null);
});
});

it('ignores persisted backend address preferences',()=>{
 localStorage.setItem('nc-settings',JSON.stringify({apiBase:'https://other-service.example',language:'en'}));
 expect(settings()).not.toHaveProperty('apiBase');expect(settings().language).toBe('en');
 saveSettings(settings());expect(JSON.parse(localStorage.getItem('nc-settings')!)).not.toHaveProperty('apiBase');
});
it('clears translations without originals, preserves position, and rejects stale saves',async()=>{
 const page={...emptyPage('clear.png',100,100),blobKey:'original:clear',outputBlobs:{job:'result:clear'}};
 const copy=makeCopy('clear',[page]);await commitCopies([copy],[{title:'clear',kind:'work'}]);
 await putBlob(page.blobKey,new Blob(['original']));await putBlob(page.outputBlobs.job,new Blob(['translation']));
 savePosition(copy.id,copy.manifestRevision,{pageId:page.id,relativeOffset:.42});
 await clearTranslations();await saveCopy(copy);
 const restored=(await readCopies()).find(c=>c.id===copy.id)!;
 expect(restored.pages[0].blobKey).toBe(page.blobKey);expect(restored.pages[0].outputBlobs).toEqual({});
 expect(restored.relativeOffset).toBe(.42);expect(await getBlob(page.blobKey)).toBeInstanceOf(Blob);expect(await getBlob(page.outputBlobs.job)).toBeUndefined();
});
it('bulk deletion preserves shared files until the last selected reference is removed',async()=>{
 const page={...emptyPage('shared.png',100,100),blobKey:'original:bulk',outputBlobs:{job:'result:bulk'}};
 const a=makeCopy('bulk a',[page]),b=makeCopy('bulk b',[{...page,id:'shared-b'}]);
 await commitCopies([a,b],[{title:'bulk a',kind:'work'},{title:'bulk b',kind:'work'}]);
 await putBlob(page.blobKey,new Blob(['original']));await putBlob(page.outputBlobs.job,new Blob(['translation']));
 await clearLocalImages([a.id],'originals');
 let copies=await readCopies();expect(copies.find(c=>c.id===a.id)!.pages[0]).toMatchObject({blobKey:undefined,outputBlobs:page.outputBlobs});
 expect(await getBlob(page.blobKey)).toBeInstanceOf(Blob);expect(copies.find(c=>c.id===b.id)!.pages[0].blobKey).toBe(page.blobKey);
 await clearLocalImages([a.id,b.id],'all');await saveCopy(a);
 copies=await readCopies();for(const id of [a.id,b.id]){expect(copies.find(c=>c.id===id)!.pages[0]).toMatchObject({blobKey:undefined,outputBlobs:{}});}
 expect(await getBlob(page.blobKey)).toBeUndefined();expect(await getBlob(page.outputBlobs.job)).toBeUndefined();
 expect((await readLibrary()).coverage.some(c=>c.copyId===a.id)).toBe(true);
});

it('defaults to 10 GB and persists unlimited without turning it into zero',async()=>{
 localStorage.removeItem('nc-settings');expect(settings().cacheLimitMb).toBe(10240);
 saveSettings({...defaults,cacheLimitMb:-1});expect(settings().cacheLimitMb).toBe(-1);
 await putBlob('result:unlimited-test',new Blob(['retained']));
 await enforceCacheBudget([],settings().cacheLimitMb);
 expect(await getBlob('result:unlimited-test')).toBeTruthy();
 await enforceCacheBudget([],0);expect(await getBlob('result:unlimited-test')).toBeUndefined();
 saveSettings({...defaults,cacheLimitMb:512});expect(settings().cacheLimitMb).toBe(512);
 localStorage.setItem('nc-settings',JSON.stringify({cacheLimitMb:-999}));expect(settings().cacheLimitMb).toBe(10240);
});
