import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Job} from '../src/types';
import type {DirectOperation} from '../src/translation/channels/transport/operations';
import type {ReadingTarget} from '../src/translation/automatic';
import {decodedImage,transferLocks} from './channel-transfer-fixture';

beforeEach(()=>{
  vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
  vi.stubGlobal('BroadcastChannel',undefined);transferLocks();decodedImage();
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function modules(){
  const [repository,cleanup,operations,receipts,runtime,client,hash,results]=await Promise.all([
    import('../src/comics/repositories'),import('../src/comics/application/source-translation-removal'),
    import('../src/translation/channels/transport/operations'),import('../src/translation/channels/transport/receipts'),
    import('../src/translation/channels/transport/runtime'),import('../src/translation/channels/transport/client'),
    import('../src/importers/hash'),import('../src/storage/translations/results'),
  ]);
  return {...repository,...cleanup,...operations,...receipts,...runtime,...client,...hash,...results};
}
async function book(m:Awaited<ReturnType<typeof modules>>,id:string,hash:string,status:'connected'|'disconnected'='connected'){
  await m.catalog.put('connections',{id:'connection-'+id,provider:'fixture',displayName:id,status,generation:1,createdAt:1,updatedAt:1});
  await m.catalog.put('comics',{id:'comic-'+id,sourceKey:id,title:id,sourceName:'fixture',source:{connectionId:'connection-'+id,providerItemId:id,locator:{},status:'active',generation:1},createdAt:1,updatedAt:1});
  await m.catalog.put('entries',{id,comicId:'comic-'+id,title:id,order:0,format:'image-sequence',contentId:'content-'+id,generation:1,indexState:'ready',createdAt:1,updatedAt:1});
  await m.catalog.put('materializations',{id:'image-'+id,pageId:'page-'+id,contentId:'content-'+id,renderProfileId:'original-v1',imageSha256:hash,width:800,height:1200,byteSize:8,mime:'image/png',updatedAt:1});
}
function operation(hash:string):DirectOperation{
  const scope='local-shared',language='zh-Hans',mode='classic';
  return {id:JSON.stringify([scope,language,mode,['sha256',hash]]),scope,entryId:'A',pageId:'page-A',job:{id:crypto.randomUUID(),image_sha256:hash,mode,target_language:language,status:'running',phase:'translating_text',created_at:new Date().toISOString(),version:1,quota_pages:0,cache_hit:false}};
}

it('hands a shared running transfer to another valid book, preserves its UUID and receipt, and completes without a second request',async()=>{
  const m=await modules(),blob=new Blob(['original'],{type:'image/png'}),hash=await m.hashFile(blob),scope={key:'shared-runtime'};
  await book(m,'A',hash);await book(m,'B',hash);
  let finish!:(response:Response)=>void;
  const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);
  const runtimes:InstanceType<typeof m.DirectImageRuntime>[]=[];
  const make=()=>{
    const jobs=new Map<string,Job>(),start=vi.fn(async(id:string,input:Blob)=>m.startImageTransfer(id,scope.key,input,{url:'http://localhost/fixture',headers:{},imageField:'image',fields:{}}));
    const runtime=new m.DirectImageRuntime(scope,{language:'zh-Hans',getBlob:async()=>blob,onJobs:async(values)=>{values.forEach(job=>jobs.set(job.id,job));},onChange:()=>{},isCurrent:()=>true},{start,errorMessage:(code)=>code});
    runtimes.push(runtime);return {runtime,jobs,start};
  };
  const target=(entryId:string):ReadingTarget=>({entryId,mode:'classic',page:{id:'page-'+entryId,name:entryId,width:800,height:1200,imageSha256:hash,blobKey:'input-'+entryId,jobs:[],outputBlobs:{}}});
  const first=make(),second=make();
  try{
    await first.runtime.submit([target('A')]);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
    await second.runtime.submit([target('B')]);
    const original=(await m.readDirectOperations(scope.key))[0];first.runtime.dispose();
    await m.blockSourceTranslationEntry('A');await m.removeSourceTranslationEntry('A');
    expect(await m.readDirectOperation(original.id)).toMatchObject({entryId:'B',pageId:'page-B',job:{id:original.job.id,status:'running'}});
    expect(await m.readTransferReceipt(original.job.id)).toMatchObject({state:'running'});
    await m.updateDirectOperation({...original,job:{...original.job,status:'failed',phase:'failed'}});
    expect((await m.readDirectOperation(original.id))?.job.status).toBe('running');
    finish(new Response(new Blob(['translated'],{type:'image/png'})));
    await vi.waitFor(async()=>{await second.runtime.refresh();expect(second.jobs.get(original.job.id)?.status).toBe('succeeded');});
    expect((await m.readDirectOperation(original.id))?.entryId).toBe('B');
    expect(await(await m.loadResultBlob({scope,job:second.jobs.get(original.job.id)!,isCurrent:()=>true})).text()).toBe('translated');
    expect(fetcher).toHaveBeenCalledOnce();expect(second.start).not.toHaveBeenCalled();
    await m.catalog.remove('materializations','image-A');await m.catalog.remove('entries','A');await m.catalog.remove('comics','comic-A');
    await m.blockSourceTranslationEntry('B');await m.removeSourceTranslationEntry('B');
    expect(await m.readDirectOperation(original.id)).toBeUndefined();expect(await m.readTransferReceipt(original.job.id)).toBeUndefined();
  }finally{runtimes.forEach(runtime=>runtime.dispose());}
});

it('keeps the transferred owner when an old observer publishes success and ignores its subsequent failure',async()=>{
  const m=await modules(),hash='a'.repeat(64),record=operation(hash);
  await book(m,'B',hash);await m.saveDirectOperation(record);await m.blockSourceTranslationEntry('A');
  const succeeded={...record,job:{...record.job,status:'succeeded' as const,result:{key:record.job.id,recoverable:false}}};
  expect(await m.updateDirectOperation(succeeded)).toMatchObject({entryId:'B',pageId:'page-B',job:{status:'succeeded'}});
  expect(await m.updateDirectOperation({...record,job:{...record.job,status:'failed'}})).toMatchObject({entryId:'B',job:{status:'succeeded'}});
  await m.removeSourceTranslationEntry('A');expect(await m.readDirectOperation(record.id)).toMatchObject({entryId:'B'});
});

it.each(['disconnected','fenced','missing'] as const)('uses ordinary deletion when the remaining owner is %s',async(condition)=>{
  const m=await modules(),hash='b'.repeat(64),record=operation(hash);
  if(condition!=='missing')await book(m,'B',hash,condition==='disconnected'?'disconnected':'connected');
  if(condition==='fenced')await m.blockEntryDirectOperations('B');
  await m.saveDirectOperation(record);await m.saveTransferReceipt({id:record.job.id,scope:record.scope,state:'running',updatedAt:1});
  await m.blockSourceTranslationEntry('A');await m.removeSourceTranslationEntry('A');
  expect(await m.readDirectOperation(record.id)).toBeUndefined();expect(await m.readTransferReceipt(record.job.id)).toBeUndefined();
  await expect(m.updateDirectOperation(record)).rejects.toThrow('已移除');
  await m.removeSourceTranslationEntry('A');
});

it('does not transfer page identities that are not shared between books',async()=>{
  const m=await modules(),hash='c'.repeat(64),record={...operation(hash),id:'entry-local-page'};
  await book(m,'B',hash);await m.saveDirectOperation(record);
  await m.blockSourceTranslationEntry('A');await m.removeSourceTranslationEntry('A');
  expect(await m.readDirectOperation(record.id)).toBeUndefined();
});
