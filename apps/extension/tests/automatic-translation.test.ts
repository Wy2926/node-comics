import 'fake-indexeddb/auto';
import {describe,it,expect,vi} from 'vitest';
import {Api,ApiError} from '../src/api';
import {emptyPage} from '../src/reader/model';
import {ReadingWindow,availableSlots,automaticManifest,needsTranslation} from '../src/translation/automatic';
import {prepareChunk,readManifest,saveManifest} from '../src/translation/store';
import {processManifest} from '../src/translation/processor';
import type {Job,ModeEntitlement,ModeQueue} from '../src/types';

const rights:ModeEntitlement={allowed:true,unlimited:false,quota_kind:'classic_daily',consent_version:'test',quota:null};
const target=(n:number)=>({copyId:'chapter',mode:'classic' as const,page:{...emptyPage(`${n}`,100,200),id:`page-${n}`,imageSha256:String(n).padStart(64,'0'),imageByteSize:1,imageMime:'image/png',blobKey:'original'}});
describe('automatic reading translation',()=>{
 it('debounces fast scrolling and keeps only the current image plus the next two',()=>{
  const window=new ReadingWindow();window.update([0,1,2,3].map(target),0);
  expect(window.ready(449)).toEqual([]);
  window.update([20,21,22].map(target),300);
  expect(window.ready(749)).toEqual([]);
  expect(window.ready(750).map(t=>t.page.id)).toEqual(['page-20','page-21','page-22']);
  expect(window.update([20,21,22].map(target),800)).toBe(false);
  expect(window.ready(800)).toHaveLength(3);
  window.update([],801);expect(window.ready(1300)).toEqual([]);
 });
 it('counts both modes against one account cap, including an expired PLUS backlog',()=>{
  const queues=[{in_flight:2},{in_flight:1}] as ModeQueue[];
  expect(availableSlots(queues,false)).toBe(0);expect(availableSlots(queues,true)).toBe(7);
  expect(availableSlots([{in_flight:10}] as ModeQueue[],false)).toBe(0);
  expect(availableSlots([{in_flight:1}] as ModeQueue[],false)).toBe(2);
 });
 it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('does not resubmit a %s page merely because it reenters the window',status=>{
  const page={...target(0).page,ownerId:'alice',apiOrigin:'https://api.example',jobs:[{status,mode:'classic',target_language:'zh-Hans',created_at:'2026-09-18',id:'job',version:1} as Job]};
  expect(needsTranslation(page,'classic','zh-Hans','alice','https://api.example')).toBe(false);
  expect(needsTranslation(page,'classic','zh-Hans','bob','https://api.example')).toBe(true);
 });
 it('persists a zero-quota reuse request and preserves its key after a lost response',async()=>{
  const value=await automaticManifest(target(1),'alice','zh-Hans',rights,async()=>new Blob(['x']));
  expect(prepareChunk(value,1,[]).pending!.body.max_quota_pages).toBe(0);
  await saveManifest(value);const api=new Api('https://api.example');
  const submit=vi.spyOn(api,'submit').mockRejectedValue(new ApiError('offline'));
  const options={api,manifest:value,available:1,readingPageIds:[],concurrency:1,getBlob:async()=>new Blob(),onJobs:async()=>{},onChange:()=>{}};
  await processManifest(options);const saved=(await readManifest(value.id))!;
  saved.retryAt=undefined;await saveManifest(saved);await processManifest(options);
  expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
  submit.mockRejectedValue(new ApiError('upgrade','DAILY_QUOTA_EXHAUSTED',409));
  saved.retryAt=undefined;await saveManifest(saved);await processManifest(options);
  expect(await readManifest(value.id)).toMatchObject({paused:true,errorCode:'DAILY_QUOTA_EXHAUSTED',pending:undefined});
 });
 it('separates copy, mode, language and account identities',async()=>{
  const a=await automaticManifest(target(2),'alice','zh-Hans',rights,async()=>new Blob(['x']));
  const b=await automaticManifest({...target(2),copyId:'other'},'alice','zh-Hans',rights,async()=>new Blob(['x']));
  const c=await automaticManifest(target(2),'bob','zh-Hans',rights,async()=>new Blob(['x']));
  expect(new Set([a.id,b.id,c.id]).size).toBe(3);
 });
});
