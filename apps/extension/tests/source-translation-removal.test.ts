import {IDBFactory,IDBIndex,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Job} from '../src/types';
import type {LocalOperation} from '../src/translation/channels/adapters/nodelane/store';
import type {DirectOperation} from '../src/translation/channels/transport/operations';

const hash='a'.repeat(64),sharedHash='b'.repeat(64);
const job=(id:string,imageSha256=hash):Job=>({id,image_sha256:imageSha256,source_image_sha256:imageSha256,mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'succeeded',created_at:'2026-10-04T00:00:00Z',version:1,quota_pages:0,cache_hit:false,result:{key:id,recoverable:false}});
const direct=(id:string,entryId='removed',imageSha256=hash):DirectOperation=>({id,scope:'local-channel',entryId,pageId:id,job:job(id,imageSha256)});
const official=(id:string,entryId='removed',imageSha256=hash):LocalOperation=>{
  const image={sha256:imageSha256,byte_size:12,content_type:'image/png'};
  return {id,entryId,scope:'official-account',pageId:id,requestId:id,image,sourceSha256:imageSha256,mode:'classic',language:'zh-Hans',request:{image,mode:'classic',target_language:'zh-Hans'},state:'accepted',createdAt:1};
};
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});
async function modules(){
  const [catalog,cleanup,directStore,officialStore,receipts,cache,results]=await Promise.all([
    import('../src/comics/repositories'),import('../src/comics/application/source-translation-removal'),
    import('../src/translation/channels/transport/operations'),import('../src/translation/channels/adapters/nodelane/store'),
    import('../src/translation/channels/transport/receipts'),import('../src/storage/translations'),import('../src/storage/translations/results'),
  ]);
  return {...catalog,...cleanup,...directStore,...officialStore,...receipts,...cache,...results};
}
beforeEach(()=>{vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('navigator',{});vi.stubGlobal('BroadcastChannel',undefined);vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('freezes an entry before inspection, removes only its operations and receipts, and rejects late completions',async()=>{
  const m=await modules(),removed=direct('direct-result'),other=direct('other','retained'),record=official('official-result');
  await m.saveDirectOperation(removed);await m.saveDirectOperation(other);await m.saveReceipt(record,job(record.requestId));
  await m.saveTransferReceipt({id:removed.job.id,scope:removed.scope,state:'running',updatedAt:1,input:new Blob(['private original'])});
  await m.blockSourceTranslationEntry('removed');
  expect(await m.readDirectOperation(removed.id)).toEqual(removed);
  const refs=await m.inspectSourceTranslationEntry('removed');
  expect(refs).toContainEqual({imageSha256:hash,scope:removed.scope,key:m.resultBlobKey({key:removed.scope},removed.job)});
  expect(refs).toContainEqual({imageSha256:hash,scope:record.scope,key:m.resultBlobKey({key:record.scope},job(record.requestId))});
  await expect(m.saveOperation(record)).rejects.toThrow('已移除');
  expect(await m.updateOperation(record)).toBe(false);
  await expect(m.saveReceipt(record,job('late-official'))).rejects.toThrow('已移除');
  await expect(m.saveDirectOperation(removed)).rejects.toThrow('已移除');
  await expect(m.updateDirectOperation(removed)).rejects.toThrow('已移除');
  const binding={id:JSON.stringify([record.scope,hash]),scope:record.scope,imageSha256:hash,payload:{jobs:[job(record.requestId)]},updatedAt:1};
  expect(await m.catalog.editTranslationBinding(binding.id,()=>binding,'removed')).toBeUndefined();
  await m.removeSourceTranslationEntry('removed');
  expect(await m.readDirectOperation(removed.id)).toBeUndefined();expect(await m.readOperation(record.id)).toBeUndefined();
  expect(await m.readDirectOperation(other.id)).toEqual(other);expect(await m.readTransferReceipt(removed.job.id)).toBeUndefined();
  await expect(m.saveTransferReceipt({id:removed.job.id,scope:removed.scope,state:'succeeded',updatedAt:2,output:new Blob(['late result'])})).rejects.toThrow('已移除');
  expect(await m.readJobs(record.scope,[],[record.requestId])).toEqual([job(record.requestId)]);
  expect(await m.readJobs(record.scope,[],['late-official'])).toEqual([]);
  await m.removeSourceTranslationEntry('removed');expect(fetch).not.toHaveBeenCalled();
});

it('does not publish a late official completion to a deleted reader target',async()=>{
  const m=await modules(),fixture=await import('./translation-fixture'),f=fixture.fixture(),target=fixture.target(0),response=Promise.withResolvers<ReturnType<typeof fixture.snapshot>>();
  f.submit.mockImplementationOnce(()=>response.promise);
  const pending=f.core.submit([target]);await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
  const [id,body]=f.submit.mock.calls[0];await m.blockSourceTranslationEntry(target.entryId);
  const refs=await m.inspectSourceTranslationEntry(target.entryId);await m.removeSourceTranslationEntry(target.entryId);
  f.onJobs.mockClear();response.resolve(fixture.snapshot(id,body,{state:'succeeded',result:{kind:'translated',representation:'original',normalization_version:1,input_sha256:target.page.imageSha256!,width:800,height:1200}}));
  await pending;
  expect(f.onJobs.mock.calls.flatMap(([jobs])=>jobs)).not.toContainEqual(expect.objectContaining({id,status:'succeeded'}));
  expect(await m.readJobs(f.core.scope,[],[id])).toEqual([]);expect(refs).toEqual([]);
  expect(await m.readEntryOperations(target.entryId)).toEqual([]);f.core.stopWatching();
});

it('retains shared bindings and cached results, then reclaims the final image reference and invalidates pending writes',async()=>{
  const m=await modules(),ownJob=job('removed-result'),sharedJob=job('shared-result',sharedHash),unrelatedJob=job('unrelated','c'.repeat(64));
  for(const value of [ownJob,sharedJob,unrelatedJob]){
    const binding={id:JSON.stringify(['scope',value.image_sha256]),scope:'scope',imageSha256:value.image_sha256!,payload:{jobs:[value]},updatedAt:1};
    await m.catalog.put('translationBindings',binding);await m.translationCache.put(m.resultBlobKey({key:'scope'},value),new Blob([value.id]),{owner:'scope'});
  }
  const shared={id:'shared-materialization',pageId:'page',contentId:'remaining-content',renderProfileId:'original-v1',imageSha256:sharedHash,width:1,height:1,byteSize:1,mime:'image/png',updatedAt:1};
  await m.catalog.put('materializations',shared);
  const oldToken=await m.translationCache.token('scope'),sharedKey=m.resultBlobKey({key:'scope'},sharedJob),ownKey=m.resultBlobKey({key:'scope'},ownJob);
  await m.removeSourceTranslationImages([hash,sharedHash],[{imageSha256:sharedHash,scope:'scope',key:sharedKey}]);
  expect(await m.translationCache.has(ownKey)).toBe(false);expect(await m.translationCache.has(sharedKey)).toBe(true);
  expect(await m.catalog.get('translationBindings',JSON.stringify(['scope',hash]))).toBeUndefined();
  expect(await m.catalog.get('translationBindings',JSON.stringify(['scope',sharedHash]))).toBeDefined();
  expect(await m.translationCache.has(m.resultBlobKey({key:'scope'},unrelatedJob))).toBe(true);
  expect(await m.translationCache.put(ownKey,new Blob(['late']),{owner:'scope',token:oldToken})).toBe(false);
  await m.catalog.remove('materializations',shared.id);await m.removeSourceTranslationImages([], [{imageSha256:sharedHash,scope:'scope',key:sharedKey}]);
  expect(await m.translationCache.has(sharedKey)).toBe(false);expect(await m.catalog.get('translationBindings',JSON.stringify(['scope',sharedHash]))).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps binding metadata recoverable when cache cleanup fails before deletion',async()=>{
  const m=await modules(),value=job('retry-result'),id=JSON.stringify(['scope',hash]);
  await m.catalog.put('translationBindings',{id,scope:'scope',imageSha256:hash,payload:{jobs:[value]},updatedAt:1});
  const remove=vi.spyOn(m.translationCache,'delete').mockRejectedValueOnce(Error('storage unavailable'));
  await expect(m.removeSourceTranslationImages([hash])).rejects.toThrow('storage unavailable');
  expect(await m.catalog.get('translationBindings',id)).toBeDefined();remove.mockRestore();
  await m.removeSourceTranslationImages([hash]);expect(await m.catalog.get('translationBindings',id)).toBeUndefined();
});

it('reads large entry and image history using bounded indexes and keeps other entry operations intact',async()=>{
  const m=await modules();
  for(let i=0;i<205;i++){const id=String(i).padStart(3,'0');await m.saveDirectOperation(direct('d'+id));await m.saveReceipt(official('o'+id),job('o'+id));}
  await m.saveDirectOperation(direct('unrelated','retained'));await m.saveReceipt(official('unrelated','retained',sharedHash),job('unrelated',sharedHash));
  const all=IDBIndex.prototype.getAll,queries:{name:string;limit?:number}[]=[];
  vi.spyOn(IDBIndex.prototype,'getAll').mockImplementation(function(this:IDBIndex,...args:Parameters<IDBIndex['getAll']>){queries.push({name:this.name,limit:args[1] as number|undefined});return all.apply(this,args);});
  const storeReads=vi.spyOn(IDBObjectStore.prototype,'getAll');
  await m.blockSourceTranslationEntry('removed');const refs=await m.inspectSourceTranslationEntry('removed');expect(refs).toHaveLength(410);
  await m.removeSourceTranslationEntry('removed');
  expect(queries.length).toBeGreaterThan(10);expect(queries.every(value=>['entryId','scopeImageJob'].includes(value.name)&&value.limit===100)).toBe(true);
  expect(storeReads).not.toHaveBeenCalled();expect(await m.readDirectOperation('unrelated')).toBeDefined();expect(await m.readOperation('unrelated')).toBeDefined();
});

it('upgrades existing direct operations, transfer bytes and version 2 official history without losing records',async()=>{
  const operation=direct('legacy-direct'),receipt={id:operation.job.id,scope:operation.scope,state:'succeeded',updatedAt:1,output:new Blob(['legacy bytes'])},record=official('legacy-official'),history=job(record.requestId);
  for(const [suffix,version] of [['channel-operations',1],['channel-transfers',1],['translation-requests-overlay-v1',2]] as const){
    const opening=indexedDB.open('node-comics-reading-v2-'+suffix,version);
    opening.onupgradeneeded=()=>{
      if(suffix==='channel-transfers')opening.result.createObjectStore('receipts',{keyPath:'id'});
      else {const operations=opening.result.createObjectStore('operations',{keyPath:'id'});operations.createIndex('scope','scope');if(suffix==='translation-requests-overlay-v1'){opening.result.createObjectStore('sync',{keyPath:'id'});const jobs=opening.result.createObjectStore('jobs',{keyPath:['scope','id']});jobs.createIndex('scopeImage',['scope','sourceSha256']);}}
    };
    const db=await request(opening),tx=db.transaction([...db.objectStoreNames],'readwrite'),done=completed(tx);
    if(suffix==='channel-transfers')tx.objectStore('receipts').put(receipt);
    else{tx.objectStore('operations').put(suffix==='channel-operations'?operation:record);if(suffix==='translation-requests-overlay-v1')tx.objectStore('jobs').put({scope:record.scope,id:history.id,sourceSha256:hash,job:history});}
    await done;db.close();
  }
  const m=await modules();expect(await m.readEntryDirectOperations(operation.entryId)).toEqual([operation]);expect(await m.readEntryOperations(record.entryId)).toEqual([record]);
  expect(await m.readImageJobsPage(record.scope,hash)).toEqual([history]);expect(await (await m.readTransferReceipt(receipt.id))?.output?.text()).toBe('legacy bytes');
});
