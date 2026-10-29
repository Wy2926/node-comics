import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {emptyPage} from '../../../../reader/model';
import {ShinobuRuntime} from './runtime';
import {parseConfig} from './config';
import {entryOperations,saveOperation} from './operations';
import {openTranslationBindings} from '../../../../comics/repositories/translation-bindings';
import type {Job} from '../../../../types';
import {localHostRequest} from '../../host-client';
vi.mock('../../host-client',()=>({localHostRequest:vi.fn(async()=>{})}));

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});
it.each(['zh-Hans','zh-Hant','ja','ko'])('admits %s without persisting the task token',async language=>{
  vi.stubGlobal('navigator',{locks:{query:async()=>({held:[],pending:[]}),request:async(_name:string,options:unknown,callback?:(lock:unknown)=>Promise<unknown>)=>typeof options==='function'?options():callback!({})}});
  const header=new Uint8Array(33);header.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const view=new DataView(header.buffer);view.setUint32(16,1000);view.setUint32(20,13000);
  const runtime=new ShinobuRuntime({key:crypto.randomUUID()},{language,getBlob:async()=>new Blob([header],{type:'image/png'}),onJobs:async()=>{},onChange:()=>{},isCurrent:()=>true},parseConfig({}),'noto-sans-cjk','task-fixture-token');
  const target={entryId:crypto.randomUUID(),mode:'classic' as const,page:{...emptyPage('long.png',1000,13000),blobKey:'fixture-long-image'}};
  await runtime.manual(target);
  const [record]=await entryOperations(target.entryId);
  expect(record.job.status).toBe('running');
  expect(localHostRequest).toHaveBeenCalledExactlyOnceWith('shinobu',{action:'start',id:record.id,token:'task-fixture-token'});
  expect(JSON.stringify(record)).not.toContain('task-fixture-token');runtime.dispose();
});
it('does not read images, create operations or dispatch automatic/manual work for pending languages',async()=>{
  const getBlob=vi.fn(async()=>undefined),onJobs=vi.fn(async()=>{});
  for(const language of ['en','fr','ar','unknown']){
    const runtime=new ShinobuRuntime({key:crypto.randomUUID()},{language,getBlob,onJobs,onChange:()=>{},isCurrent:()=>true},parseConfig({}),'noto-sans-cjk');
    const target={entryId:crypto.randomUUID(),mode:'classic' as const,page:{...emptyPage('fixture.png',900,1200),blobKey:'must-not-read'}};
    await runtime.submit([target]);await runtime.refresh();
    await expect(runtime.manual(target)).rejects.toThrow('此语言待支持');
    expect(runtime.hasPending).toBe(false);expect(runtime.waitingIds).toEqual([]);
    expect(runtime.stateFor(target,true)).toMatchObject({kind:'error',retryable:false,message:'此语言待支持，未启动本地翻译。'});
    expect(await entryOperations(target.entryId)).toEqual([]);runtime.dispose();
  }
  expect(getBlob).not.toHaveBeenCalled();expect(onJobs).not.toHaveBeenCalled();expect(localHostRequest).not.toHaveBeenCalled();
});
it('publishes only status changes and polls through the caller wait, without its own timer',async()=>{
  vi.stubGlobal('navigator',{locks:{query:async()=>({held:[],pending:[]}),request:async(_name:string,options:unknown,callback?:(lock:unknown)=>Promise<unknown>)=>typeof options==='function'?options():callback!(null)}});
  const onJobs=vi.fn(async()=>{}),onChange=vi.fn(),getBlob=vi.fn(async()=>undefined);
  const runtime=new ShinobuRuntime({key:crypto.randomUUID()},{language:'zh-Hans',getBlob,onJobs,onChange,isCurrent:()=>true},parseConfig({}),'noto-sans-cjk');
  const target={entryId:crypto.randomUUID(),mode:'classic' as const,page:{...emptyPage('fixture.png',900,1200),blobKey:'unavailable'}};
  await runtime.manual(target);
  expect(onJobs).toHaveBeenCalledTimes(1);expect(onChange).toHaveBeenCalledTimes(1);
  for(let i=0;i<5;i++)await runtime.restore([target]);
  expect(onJobs).toHaveBeenCalledTimes(1);expect(onChange).toHaveBeenCalledTimes(1);expect(getBlob).toHaveBeenCalledTimes(1);
  const [record]=await entryOperations(target.entryId);
  await saveOperation({...record,job:{...record.job,status:'running'}},true);
  await runtime.submit([target]);expect(runtime.hasPending).toBe(true);
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  await saveOperation({...record,job:{...record.job,status:'no_text',updated_at:new Date().toISOString()}});
  await vi.advanceTimersByTimeAsync(2000);
  expect(runtime.hasPending).toBe(true);expect(onJobs).toHaveBeenCalledTimes(2);
  const waiting=runtime.wait(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(750);expect(await waiting).toBe(false);
  expect(onJobs).toHaveBeenCalledTimes(3);expect(getBlob).toHaveBeenCalledTimes(1);
  runtime.dispose();
});
it('restores a shared image binding before admission while the reader still holds another channel',async()=>{
  const scope={key:crypto.randomUUID()},hash='a'.repeat(64),job:Job={id:crypto.randomUUID(),image_sha256:hash,mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'succeeded',created_at:new Date().toISOString(),version:1,quota_pages:0,cache_hit:false,result:{key:'cached',recoverable:false}};
  const database=await openTranslationBindings();
  await new Promise<void>((resolve,reject)=>{const tx=database.transaction('translationBindings','readwrite');tx.objectStore('translationBindings').put({id:JSON.stringify([scope.key,hash]),scope:scope.key,imageSha256:hash,payload:{jobs:[job]},updatedAt:Date.now()});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  const onJobs=vi.fn(async()=>{}),onChange=vi.fn(),getBlob=vi.fn(async()=>undefined);
  const runtime=new ShinobuRuntime(scope,{language:'zh-Hans',getBlob,onJobs,onChange,isCurrent:()=>true},parseConfig({}),'noto-sans-cjk');
  const target={entryId:crypto.randomUUID(),mode:'classic' as const,page:{...emptyPage('same-image.png',900,1200),imageSha256:hash,translationScope:'another-channel',jobs:[]}};
  await runtime.submit([target]);expect(onJobs).toHaveBeenCalledExactlyOnceWith([job]);expect(runtime.hasPending).toBe(false);
  await runtime.submit([target]);expect(onJobs).toHaveBeenCalledTimes(1);expect(getBlob).not.toHaveBeenCalled();runtime.dispose();
  const other=new ShinobuRuntime({key:crypto.randomUUID()},{language:'zh-Hans',getBlob,onJobs,onChange,isCurrent:()=>true},parseConfig({}),'noto-sans-cjk');
  await other.restore([target]);expect(onJobs).toHaveBeenCalledTimes(1);other.dispose();
});
