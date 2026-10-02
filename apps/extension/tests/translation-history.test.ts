import {IDBFactory,IDBIndex,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Job} from '../src/types';
import type {LocalOperation} from '../src/translation/channels/adapters/nodelane/store';
import {stubAuthLocks} from './auth-fixture';

const databaseName='node-comics-reading-v2-translation-requests-overlay-v1';
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});
async function legacyDatabase(records:LocalOperation[],states:{id:string;jobs:Job[];imageRetryAt?:number}[]){
  const opening=indexedDB.open(databaseName,1);
  opening.onupgradeneeded=()=>{
    const operations=opening.result.createObjectStore('operations',{keyPath:'id'});operations.createIndex('scope','scope');
    opening.result.createObjectStore('sync',{keyPath:'id'});
  };
  const db=await request(opening),tx=db.transaction(['operations','sync'],'readwrite'),done=completed(tx);
  for(const record of records)tx.objectStore('operations').put(record);
  for(const state of states)tx.objectStore('sync').put(state);
  await done;db.close();
}
async function modules(){
  const [fixture,store,operations,coordinator]=await Promise.all([
    import('./translation-fixture'),import('../src/translation/channels/adapters/nodelane/store'),
    import('../src/translation/channels/adapters/nodelane/operations'),import('../src/translation/channels/adapters/nodelane/coordinator'),
  ]);
  return {...fixture,...store,...operations,...coordinator};
}
beforeEach(()=>{vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);stubAuthLocks();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('translation request database upgrade',()=>{
  it('atomically moves legacy history while preserving UUIDs, frozen inputs, unknown fields and account isolation',async()=>{
    const m=await modules(),f=m.fixture(),other=m.fixture(),t=m.target(0);
    const record=m.makeOperation(t,f.core.scope,'zh-Hans',{...m.originalInput(0),resultFormat:'overlay-tiles-v1'});
    record.state='accepted';record.result=m.snapshot(record.requestId,record.request,{state:'succeeded'});
    const original=m.job(0,{id:record.requestId,status:'succeeded',source_image_sha256:t.page.imageSha256,input_profile:'short-edge-1800-webp90-v1',delivery:{kind:'translated',representation:'overlay-tiles-v1',input_sha256:'a'.repeat(64),normalization_version:1,width:64,height:100000,composite:'source-atop',artifact:{sha256:'b'.repeat(64),byte_size:42,mime:'application/vnd.nodelane.overlay-tiles',path:'/v1/translations/'+record.requestId+'/result'}}});
    const extended={...original,futureMetadata:{preserved:'yes'}},unmapped=m.job(1,{id:'no-image-hash',image_sha256:undefined});
    const otherJob={...original,quality_flags:['other-account']};
    await legacyDatabase([record],[{id:f.core.scope,jobs:[extended,unmapped],imageRetryAt:123},{id:other.core.scope,jobs:[otherJob]}]);
    expect(await m.readSync(f.core.scope)).toEqual({id:f.core.scope,imageRetryAt:123});
    expect(await m.readOperation(record.id)).toEqual(record);
    expect(await m.readJobs(f.core.scope,[t.page.imageSha256!])).toEqual([extended]);
    expect(await m.readJobs(f.core.scope,[],[unmapped.id])).toEqual([unmapped]);
    expect(await m.readJobs(other.core.scope,[],[original.id])).toEqual([otherJob]);
    const db=await request(indexedDB.open(databaseName));expect(db.version).toBe(2);expect([...db.objectStoreNames]).toEqual(['jobs','operations','sync']);db.close();
    vi.resetModules();const reopened=await import('../src/translation/channels/adapters/nodelane/store');
    expect(await reopened.readJobs(f.core.scope,[],[original.id])).toEqual([extended]);
    expect((await reopened.readOperation(record.id))?.requestId).toBe(record.requestId);
  });

  it('leaves every legacy row intact after an interrupted migration and safely repeats it',async()=>{
    const m=await modules(),f=m.fixture(),jobs=[m.job(0),m.job(1)],legacy={id:f.core.scope,jobs,imageRetryAt:456};
    await legacyDatabase([],[legacy]);
    const originalPut=IDBObjectStore.prototype.put;let moved=0;
    const failure=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
      if(this.name==='jobs'&&++moved===2)throw Error('Interrupted migration');
      return originalPut.apply(this,args);
    });
    await expect(m.readSync(f.core.scope)).rejects.toBeDefined();failure.mockRestore();
    const original=await request(indexedDB.open(databaseName,1));
    expect(original.version).toBe(1);expect(original.objectStoreNames.contains('jobs')).toBe(false);
    expect(await request(original.transaction('sync').objectStore('sync').get(f.core.scope))).toEqual(legacy);original.close();
    expect(await m.readSync(f.core.scope)).toEqual({id:f.core.scope,imageRetryAt:456});
    expect(await m.readJobs(f.core.scope,[],jobs.map(job=>job.id))).toEqual(jobs);
  });
});

describe('bounded translation history access',()=>{
  it('restores older successful results beside the latest failed intent without paying again',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0);
    const first=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0));
    first.state='accepted';first.result=m.snapshot(first.requestId,first.request,{state:'succeeded',result:{kind:'translated',representation:'original',normalization_version:1,input_sha256:t.page.imageSha256!,width:800,height:1200}});
    const success=m.translationJob(first.result,first);await m.saveReceipt(first,success);
    const second=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0),{regenerate_of:first.requestId});
    second.state='accepted';second.result=m.snapshot(second.requestId,second.request,{state:'failed'});
    const failure=m.translationJob(second.result,second);await m.saveOperation(second);await m.saveReceipt(second,failure);
    vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:undefined,items:[second.result],missing_ids:[]});
    const core=new m.TranslationCoordinator(f.core.options);await core.submit([t]);
    const restored=f.onJobs.mock.calls.flatMap(([jobs])=>jobs);
    expect(restored).toContainEqual(success);expect(restored).toContainEqual(failure);
    expect(f.submit).not.toHaveBeenCalled();expect((await m.readOperation(second.id))?.requestId).toBe(second.requestId);
  });

  it('shares an in-flight UUID across coordinators and stores one job record',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0),response=Promise.withResolvers<ReturnType<typeof m.snapshot>>();
    f.submit.mockImplementationOnce(()=>response.promise);
    const first=f.core.submit([t]);await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
    const [id,body]=f.submit.mock.calls[0];
    vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:undefined,items:[m.snapshot(id,body)],missing_ids:[]});
    const other=new m.TranslationCoordinator(f.core.options),second=other.submit([t]);
    response.resolve(m.snapshot(id,body));await Promise.all([first,second]);
    expect(f.submit).toHaveBeenCalledOnce();expect(await m.readJobs(f.core.scope,[t.page.imageSha256!])).toHaveLength(1);
    expect((await m.readOperation(m.operationId(f.core.scope,'zh-Hans',t)))?.requestId).toBe(id);
  });

  it('restores the final display state when another coordinator completes an already refreshed UUID',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0);
    await f.core.submit([t]);await f.core.submit([t]);f.core.stopWatching();f.onJobs.mockClear();
    const [id,body]=f.submit.mock.calls[0],finished=m.snapshot(id,body,{state:'succeeded',result:{kind:'no_text',representation:'original',normalization_version:1,input_sha256:t.page.imageSha256!,width:800,height:1200}});
    vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:undefined,items:[finished],missing_ids:[]});
    const other=new m.TranslationCoordinator({...f.core.options,onJobs:vi.fn(async()=>{})});await other.submit([t]);
    expect(f.onJobs).not.toHaveBeenCalled();await f.core.submit([t]);
    expect(f.onJobs.mock.calls.flatMap(([jobs])=>jobs)).toContainEqual(expect.objectContaining({id,status:'no_text'}));
    expect(f.core.hasPending).toBe(false);expect(f.api.translations).toHaveBeenCalledOnce();expect(f.submit).toHaveBeenCalledOnce();
  });

  it('keeps a late receipt in history without replacing a newer request for the same page',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0),previous=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0));
    await m.saveOperation(previous);
    const newer=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0),{regenerate_of:previous.requestId});await m.saveOperation(newer);
    previous.state='accepted';previous.result=m.snapshot(previous.requestId,previous.request,{state:'succeeded'});
    expect(await m.saveReceipt(previous,m.translationJob(previous.result,previous))).toBe(false);
    expect((await m.readOperation(newer.id))?.requestId).toBe(newer.requestId);
    expect((await m.readJobs(f.core.scope,[t.page.imageSha256!])).map(job=>job.id)).toEqual([previous.requestId]);
  });

  it('keeps an obsolete needs_input receipt in history without uploading its old UUID',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0),response=Promise.withResolvers<ReturnType<typeof m.snapshot>>();
    f.submit.mockImplementationOnce(()=>response.promise);
    const submitting=f.core.submit([t]);await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
    const [id,body]=f.submit.mock.calls[0],newer=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0),{regenerate_of:id});
    await m.saveOperation(newer);
    const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async requestId=>m.snapshot(requestId,body));
    response.resolve(m.snapshot(id,body,{state:'needs_input'}));await submitting;await f.core.finishUploads();
    expect(upload).not.toHaveBeenCalled();expect((await m.readOperation(newer.id))?.requestId).toBe(newer.requestId);
    expect((await m.readJobs(f.core.scope,[],[id]))[0].status).toBe('awaiting_upload');
  });

  it('cannot overwrite a newer UUID when an upload error races the stored-request check',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0),response=Promise.withResolvers<ReturnType<typeof m.snapshot>>();
    f.submit.mockImplementationOnce(async(id,body)=>m.snapshot(id,body,{state:'needs_input'}));
    const upload=vi.spyOn(f.api,'translationInput').mockImplementation(()=>response.promise);
    await f.core.submit([t]);await vi.waitFor(()=>expect(upload).toHaveBeenCalledOnce());
    const id=f.submit.mock.calls[0][0],newer=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0),{regenerate_of:id});
    const get=IDBObjectStore.prototype.get;let replacement:Promise<void>|undefined;
    vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
      const result=get.apply(this,args);
      if(this.name==='operations'&&args[0]===newer.id&&!replacement)result.addEventListener('success',()=>{replacement=m.saveOperation(newer);},{once:true});
      return result;
    });
    response.reject(Error('Upload connection lost'));await f.core.finishUploads();
    expect(replacement).toBeDefined();await replacement;
    expect(await m.readOperation(newer.id)).toEqual(newer);
  });

  it('cannot overwrite a newer UUID when a missing snapshot races the stored-request check',async()=>{
    const m=await modules(),f=m.fixture(),t=m.target(0),previous=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0));
    previous.state='uncertain';await m.saveOperation(previous);
    const response=Promise.withResolvers<Awaited<ReturnType<typeof f.api.translations>>>();
    vi.mocked(f.api.translations).mockImplementationOnce(()=>response.promise);
    const recovering=f.core.submit([t]);await vi.waitFor(()=>expect(f.api.translations).toHaveBeenCalledOnce());
    const newer=m.makeOperation(t,f.core.scope,'zh-Hans',m.originalInput(0),{regenerate_of:previous.requestId});newer.state='uncertain';
    const get=IDBObjectStore.prototype.get;let reads=0,replacement:Promise<void>|undefined;
    vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
      const result=get.apply(this,args);
      if(this.name==='operations'&&args[0]===newer.id&&++reads===2)result.addEventListener('success',()=>{replacement=m.saveOperation(newer);},{once:true});
      return result;
    });
    response.resolve({unchanged:false,etag:undefined,items:[],missing_ids:[previous.requestId]});await recovering;
    expect(replacement).toBeDefined();await replacement;
    expect(await m.readOperation(newer.id)).toEqual(newer);expect(f.submit).not.toHaveBeenCalled();
  });

  it('persists a late off-window receipt without expanding the active records or creating another UUID',async()=>{
    const m=await modules(),f=m.fixture(),response=Promise.withResolvers<ReturnType<typeof m.snapshot>>();
    f.submit.mockImplementationOnce(()=>response.promise);
    const leaving=f.core.submit([m.target(0)]);await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
    const [id,body]=f.submit.mock.calls[0];await f.core.submit([m.target(1)]);
    response.resolve(m.snapshot(id,body));await leaving;
    expect(f.core.records.map(record=>record.pageId)).toEqual(['page-1']);
    expect((await m.readJobs(f.core.scope,[m.target(0).page.imageSha256!])).map(job=>job.id)).toEqual([id]);
    vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:undefined,items:[m.snapshot(id,body)],missing_ids:[]});
    await f.core.submit([m.target(0)]);expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.core.records.map(record=>record.requestId)).toEqual([id]);
  });

  it('persists an already requested stream snapshot after its page leaves the window',async()=>{
    const m=await modules(),f=m.fixture(),response=Promise.withResolvers<void>();
    await f.core.submit([m.target(0)]);const [id,body]=f.submit.mock.calls[0];
    vi.mocked(f.api.translationEvents).mockImplementation(async function*(){await response.promise;yield {items:[m.snapshot(id,body,{state:'succeeded'})],missing_ids:[]};});
    const waiting=f.core.wait(new AbortController().signal);await vi.waitFor(()=>expect(f.api.translationEvents).toHaveBeenCalledOnce());
    await f.core.submit([m.target(1)]);response.resolve();await waiting;
    expect(f.core.records.map(record=>record.pageId)).toEqual(['page-1']);
    expect((await m.readJobs(f.core.scope,[],[id]))[0].status).toBe('succeeded');
    expect((await m.readOperation(m.operationId(f.core.scope,'zh-Hans',m.target(0))))?.result?.state).toBe('succeeded');
    f.core.stopWatching();
  });

  it('updates one page with the same bounded IO after 50 or 500 historical requests',async()=>{
    const m=await modules();
    const observations:{operationScans:number;jobQueries:unknown[];syncWrites:number;syncBytes:number[]}[]=[];
    for(const count of [50,500]){
      const f=m.fixture();
      for(let n=0;n<count;n++){
        const record=m.makeOperation(m.target(n),f.core.scope,'zh-Hans',m.originalInput(n));
        record.state='accepted';record.result=m.snapshot(record.requestId,record.request,{state:'failed'});
        await m.saveReceipt(record,m.translationJob(record.result,record));
      }
      await m.saveSync({id:f.core.scope});await f.core.init();
      const observation={operationScans:0,jobQueries:[] as unknown[],syncWrites:0,syncBytes:[] as number[]};
      const getAll=IDBIndex.prototype.getAll,get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put;
      const allSpy=vi.spyOn(IDBIndex.prototype,'getAll').mockImplementation(function(this:IDBIndex,...args:Parameters<IDBIndex['getAll']>){
        if(this.objectStore.name==='operations')observation.operationScans++;
        if(this.objectStore.name==='jobs')observation.jobQueries.push(args[0]);
        return getAll.apply(this,args);
      });
      const getSpy=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
        const result=get.apply(this,args);
        if(this.name==='sync')result.addEventListener('success',()=>observation.syncBytes.push(JSON.stringify(result.result).length));
        return result;
      });
      const putSpy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
        if(this.name==='sync')observation.syncWrites++;return put.apply(this,args);
      });
      await f.core.submit([m.target(1000)]);allSpy.mockRestore();getSpy.mockRestore();putSpy.mockRestore();
      expect(observation.operationScans).toBe(0);expect(observation.syncWrites).toBe(0);
      expect(observation.jobQueries).toEqual([[f.core.scope,m.target(1000).page.imageSha256]]);
      expect(f.core.records).toHaveLength(1);expect((await m.readJobs(f.core.scope,[m.target(0).page.imageSha256!]))).toHaveLength(1);
      observations.push(observation);
    }
    expect(observations[0].syncBytes).toEqual(observations[1].syncBytes);
  });

  it('reopens an off-window quota denial only after policy changes, retaining its UUID',async()=>{
    const m=await modules(),{ApiError}=await import('../src/api'),f=m.fixture(),t=m.target(0);
    f.submit.mockRejectedValueOnce(new ApiError('quota','DAILY_QUOTA_EXHAUSTED',403));await f.core.submit([t]);
    const id=f.submit.mock.calls[0][0];await f.core.submit([]);await f.core.refreshEntitlements(f.rights);await f.core.submit([t]);
    expect(f.submit).toHaveBeenCalledOnce();
    await f.core.submit([]);await f.core.refreshEntitlements(m.entitlement(true));await f.core.submit([t]);
    expect(f.submit).toHaveBeenCalledTimes(2);expect(f.submit.mock.calls[1][0]).toBe(id);
  });

  it('reopens an off-window rate denial when the allowance changes, retaining its UUID',async()=>{
    const m=await modules(),{ApiError}=await import('../src/api'),f=m.fixture(),t=m.target(0);
    f.submit.mockRejectedValueOnce(new ApiError('wait','IMAGE_RATE_LIMITED',429,null,600));await f.core.submit([t]);
    const id=f.submit.mock.calls[0][0];await f.core.submit([]);await f.core.refreshEntitlements(f.rights);await f.core.submit([t]);
    expect(f.submit).toHaveBeenCalledOnce();
    await f.core.submit([]);await f.core.refreshEntitlements(m.entitlement(true));await f.core.submit([t]);
    expect(f.submit).toHaveBeenCalledTimes(2);expect(f.submit.mock.calls[1][0]).toBe(id);
  });
});
