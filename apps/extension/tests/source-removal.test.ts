import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog,openCatalog,sourceCleanupRange} from '../src/comics/repositories';
import type {Comic,Entry,SourceConnection} from '../src/comics/domain';
import {inspectSourceRemoval,removeSource} from '../src/comics/application/source-lifecycle';
import {connectRemoteLibrary} from '../src/comics/application/remote-library-service';
import {connectionCapabilities,listSourceAccounts} from '../src/comics/application/source-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import type {RemoteReadingPlan,SourceProvider} from '../src/comics/sources/contracts';
import {queueRemoteFileDownload,readRemoteFileDownload,runRemoteFileDownloadCycle,stopRemoteFileDownloads} from '../src/comics/acquisition/files';
import {sourcePageCache} from '../src/storage/source-pages';
import {sourceRangeCache} from '../src/storage/source-ranges';
import {thumbnailCache} from '../src/storage/thumbnails';
import {downloadStore} from '../src/storage/downloads';
import {sourceCoverOwner} from '../src/comics/application/cover-access';
import {bytesTransaction,CHUNK_SIZE,idbRequest} from '../src/storage/bytes/database';
import {importContainer,listContainerReferences,openContainer,retainContainer} from '../src/storage/containers';
import {comicFile} from './comic-fixture';

const caches=[sourcePageCache,sourceRangeCache,thumbnailCache,downloadStore];
const unregister:(()=>void)[]=[];
beforeEach(async()=>{
  stopRemoteFileDownloads();
  const db=await openCatalog(),tables=Array.from(db.objectStoreNames);
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(tables,'readwrite');for(const name of tables)tx.objectStore(name).clear();
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });
  await bytesTransaction(['objects','chunks','operations','references','leases','settings'],'readwrite',async tx=>{
    for(const name of ['objects','chunks','operations','references','leases'])tx.objectStore(name).clear();
  });
  await Promise.all(caches.map(cache=>cache.clear()));
});
afterEach(()=>{stopRemoteFileDownloads();for(const stop of unregister.splice(0))stop();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){
  const providerId='remove-fixture-'+crypto.randomUUID(),remove=vi.fn(async()=>{}),connect=vi.fn();
  const provider:SourceProvider={id:providerId,label:'Fixture',cachePages:true,cacheRanges:true,
    connection:{connect,remove,list:async()=>[]},
    catalog:{browse:async()=>({title:'Library',location:'root',navigation:[],publications:[]}),resolve:async()=>{throw Error('Unexpected server request');}},
    files:{open:async()=>{throw Error('Unexpected server request');},download:async()=>{throw Error('Unexpected server request');}},
  };
  unregister.push(registerSourceDriver(provider));
  const connection:SourceConnection={id:'source:'+crypto.randomUUID(),provider:providerId,displayName:'Library',status:'connected',generation:1,createdAt:1,updatedAt:1};
  await catalog.put('connections',connection);
  return {connection,provider,remove,connect};
}
async function book(connection:SourceConnection,suffix:string=crypto.randomUUID()){
  const id='comic:'+suffix,entryId='entry:'+suffix,contentId='content:'+suffix;
  const comic:Comic={id,title:'Book',sourceName:'Fixture',sourceKey:JSON.stringify([connection.id,id]),source:{connectionId:connection.id,providerItemId:id,locator:{},status:'active',generation:1},startEntryId:entryId,createdAt:1,updatedAt:1};
  const entry:Entry={id:entryId,comicId:id,contentId,title:'Entry',format:'cbz',order:0,generation:1,indexState:'ready',createdAt:1,updatedAt:1};
  await catalog.commit([{table:'comics',value:comic},{table:'entries',value:entry}]);
  return {comic,entry};
}
function plan(id:string):RemoteReadingPlan{return {publication:{id,title:'Pending file'},kind:'download-file',representationId:'archive',format:'cbz',locator:{},snapshot:{version:'1'}};}

describe('explicit remote-library local removal',()=>{
  it('counts both download kinds, deletes only this connection, and preserves a shared container',async()=>{
    const a=await fixture(),b=await fixture(),target=await book(a.connection),other=await book(b.connection);
    const file=await comicFile('shared',[new Blob(['original bytes'])]);
    const container=await importContainer(file,undefined,undefined,target.entry.contentId);
    await retainContainer(container.id,other.entry.contentId);
    await catalog.patch('entries',target.entry.id,{containerId:container.id});
    await catalog.patch('entries',other.entry.id,{containerId:container.id});
    await catalog.commit([
      {table:'positions',value:{id:target.entry.id,entryId:target.entry.id,comicId:target.comic.id,contentId:target.entry.contentId,pageId:'page',relativeOffset:.5,updatedAt:1}},
      {table:'tasks',value:{id:'download:'+target.entry.id,entryId:target.entry.id,status:'queued',generation:1}},
      ...['reading-preferences:','book-download:','download-languages:'].map(prefix=>({table:'metadata' as const,value:{id:prefix+target.comic.id}})),
    ]);
    const intent=await queueRemoteFileDownload(a.connection.id,plan('unregistered'),{confirmed:true});
    await importContainer(file,undefined,undefined,intent.contentId);
    const otherIntent=await queueRemoteFileDownload(b.connection.id,plan('other'),{confirmed:true});
    for(const cache of caches){
      await cache.put('target:'+cache.name,new Blob(['target']),{owner:target.entry.id,connectionId:a.connection.id,contentId:target.entry.contentId});
      await cache.put('other:'+cache.name,new Blob(['other']),{owner:other.entry.id,connectionId:b.connection.id,contentId:other.entry.contentId});
    }
    await thumbnailCache.put('cover',new Blob(['cover']),{owner:sourceCoverOwner(target.comic.id),connectionId:a.connection.id});
    const token=await sourcePageCache.token(target.entry.id);
    expect(connectionCapabilities(a.connection)).toMatchObject({canRemove:true});
    expect(await inspectSourceRemoval(a.connection.id)).toEqual({comicCount:1,downloadTaskCount:2});
    await removeSource(a.connection.id);
    expect(a.remove).toHaveBeenCalledOnce();
    for(const table of ['comics','entries','positions','tasks'] as const)expect(await catalog.get(table,table==='comics'?target.comic.id:table==='tasks'?'download:'+target.entry.id:target.entry.id)).toBeUndefined();
    expect(await catalog.get('connections',a.connection.id)).toBeUndefined();
    expect(await catalog.get('connections',b.connection.id)).toEqual(b.connection);
    expect(await catalog.get('entries',other.entry.id)).toMatchObject({containerId:container.id});
    expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect(await readRemoteFileDownload(otherIntent.id)).toBeDefined();
    expect(await listContainerReferences(target.entry.contentId)).toEqual([]);
    expect(await listContainerReferences(intent.contentId)).toEqual([]);
    expect(await listContainerReferences(other.entry.contentId)).toHaveLength(1);
    const source=await openContainer(container.id);expect((await source.readAt(0,2)).length).toBe(2);await source.close();
    for(const cache of caches){expect(await cache.get('target:'+cache.name)).toBeUndefined();expect(await cache.get('other:'+cache.name)).toBeDefined();}
    expect(await thumbnailCache.get('cover')).toBeUndefined();
    expect(await sourcePageCache.put('late',new Blob(['late']),{owner:target.entry.id,token})).toBe(false);
    for(const kind of ['entry','image','cover'] as const)expect(await catalog.count('metadata',{range:sourceCleanupRange(kind,a.connection.id)})).toBe(0);
    await removeSource(a.connection.id);expect(a.remove).toHaveBeenCalledOnce();
  });

  it('keeps a disconnected retry entry if private deletion fails, including provider account refresh',async()=>{
    const f=await fixture(),saved=await book(f.connection);
    f.provider.connection!.list=async()=>[{...f.connection,status:'connected'}];
    f.remove.mockRejectedValueOnce(Error('private storage failed'));
    await expect(removeSource(f.connection.id)).rejects.toThrow('private storage failed');
    expect(await catalog.get('connections',f.connection.id)).toMatchObject({status:'disconnected',generation:2});
    expect((await listSourceAccounts([f.connection.provider])).accounts[0].status).toBe('disconnected');
    expect(await catalog.get('comics',saved.comic.id)).toBeDefined();
    await expect(connectRemoteLibrary(f.connection.provider,{},f.connection.id)).rejects.toMatchObject({name:'AbortError'});
    expect(f.connect).not.toHaveBeenCalled();
    await removeSource(f.connection.id);
    expect(await catalog.get('connections',f.connection.id)).toBeUndefined();expect(f.remove).toHaveBeenCalledTimes(2);
  });

  it('retries physical cleanup after catalog deletion without recreating the book',async()=>{
    const f=await fixture(),saved=await book(f.connection);
    await downloadStore.put('saved-page',new Blob(['saved']),{owner:saved.entry.id,connectionId:f.connection.id});
    vi.spyOn(downloadStore,'deleteOwner').mockRejectedValueOnce(Error('download cleanup failed'));
    await expect(removeSource(f.connection.id)).rejects.toThrow('download cleanup failed');
    expect(await catalog.get('comics',saved.comic.id)).toBeUndefined();
    expect(await catalog.get('connections',f.connection.id)).toMatchObject({status:'disconnected'});
    expect(await catalog.count('metadata',{range:sourceCleanupRange('entry',f.connection.id)})).toBe(1);
    await removeSource(f.connection.id);
    expect(await downloadStore.get('saved-page')).toBeUndefined();
    expect(await catalog.get('connections',f.connection.id)).toBeUndefined();
    await removeSource(f.connection.id);expect(f.remove).toHaveBeenCalledTimes(2);
  });

  it('does not publish a reconnect that started before removal',async()=>{
    const f=await fixture(),waiting=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
    f.connect.mockImplementation(async()=>{started.resolve();await waiting.promise;return {...f.connection,status:'connected'};});
    const reconnect=connectRemoteLibrary(f.connection.provider,{},f.connection.id);
    await started.promise;await removeSource(f.connection.id);waiting.resolve();
    await expect(reconnect).rejects.toMatchObject({name:'AbortError'});
    expect(await catalog.get('connections',f.connection.id)).toBeUndefined();
  });

  it('cancels an unfinished file stream and clears its partial bytes before completing removal',async()=>{
    const f=await fixture(),publication=plan('stalled'),progress=Promise.withResolvers<void>(),cancel=vi.fn();
    const bytes=new Uint8Array(CHUNK_SIZE);bytes.set([80,75,3,4]);let delivered=false;
    f.provider.catalog!.resolve=async()=>publication;
    f.provider.files!.download=async()=>({name:'stalled.cbz',size:CHUNK_SIZE*2,stream:new ReadableStream<Uint8Array>({
      pull(controller){if(!delivered){delivered=true;controller.enqueue(bytes);}},cancel,
    },{highWaterMark:0})});
    const intent=await queueRemoteFileDownload(f.connection.id,publication,{confirmed:true});
    const unsubscribe=catalog.subscribe(change=>{if(change.table==='metadata'&&change.ids.includes(intent.id))void readRemoteFileDownload(intent.id).then(value=>{if(value?.bytes===CHUNK_SIZE)progress.resolve();});});
    const running=runRemoteFileDownloadCycle(new AbortController().signal,'removal-test');
    await progress.promise;unsubscribe();
    await removeSource(f.connection.id);await running;
    expect(cancel).toHaveBeenCalledOnce();expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect(await catalog.count('comics',{index:'connectionId',range:f.connection.id})).toBe(0);
    for(const name of ['operations','chunks','objects','references'])expect(await bytesTransaction([name],'readonly',tx=>idbRequest(tx.objectStore(name).count()))).toBe(0);
  });

  it('retains the clearing intent when a delayed writer and both cleanup retries fail',async()=>{
    const f=await fixture(),publication=plan('late-staging'),estimateEntered=Promise.withResolvers<void>(),estimateReleased=Promise.withResolvers<void>(),clearing=Promise.withResolvers<void>();
    vi.stubGlobal('navigator',{storage:{estimate:async()=>{estimateEntered.resolve();await estimateReleased.promise;return {usage:0,quota:1024**3};}}});
    const bytes=new Uint8Array(CHUNK_SIZE);bytes.set([80,75,3,4]);let delivered=false;
    f.provider.catalog!.resolve=async()=>publication;
    f.provider.files!.download=async()=>({name:'late-staging.cbz',size:CHUNK_SIZE*2,stream:new ReadableStream<Uint8Array>({
      pull(controller){if(!delivered){delivered=true;controller.enqueue(bytes);}},
    },{highWaterMark:0})});
    const intent=await queueRemoteFileDownload(f.connection.id,publication,{confirmed:true}),deleteOriginal=IDBObjectStore.prototype.delete;
    let failures=3;
    vi.spyOn(IDBObjectStore.prototype,'delete').mockImplementation(function(this:IDBObjectStore,key:IDBValidKey|IDBKeyRange){
      if(this.name==='operations'&&failures>0){failures--;throw Error('staging cleanup failed');}
      return deleteOriginal.call(this,key);
    });
    const unsubscribe=catalog.subscribe(change=>{if(change.table==='metadata'&&change.ids.includes(intent.id))void readRemoteFileDownload(intent.id).then(value=>{if(value?.status==='clearing')clearing.resolve();});});
    const running=runRemoteFileDownloadCycle(new AbortController().signal,'late-staging-test');
    await estimateEntered.promise;
    const removal=removeSource(f.connection.id),failure=expect(removal).rejects.toThrow('staging cleanup failed');
    await clearing.promise;unsubscribe();
    // Let cleanup reach its wait for the aborted writer, whose reserve is still unresolved.
    await new Promise(resolve=>setTimeout(resolve,100));estimateReleased.resolve();
    await failure;await running;
    expect(failures).toBe(0);
    expect(await readRemoteFileDownload(intent.id)).toMatchObject({status:'clearing',contentId:intent.contentId});
    expect(await bytesTransaction(['operations'],'readonly',tx=>idbRequest(tx.objectStore('operations').count()))).toBe(1);
    expect(await catalog.get('connections',f.connection.id)).toMatchObject({status:'disconnected'});
    await removeSource(f.connection.id);
    expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect(await bytesTransaction(['operations'],'readonly',tx=>idbRequest(tx.objectStore('operations').count()))).toBe(0);
    expect(await catalog.get('connections',f.connection.id)).toBeUndefined();
  });

  it('removes every catalog child across bounded batches and traverses more than one connection batch',async()=>{
    const f=await fixture(),saved=await book(f.connection);
    const entryTotal=205,pageTotal=205;
    await catalog.mutate(['entries','pageDescriptors','materializations','tasks'],async tx=>{
      for(let index=0;index<entryTotal;index++)await tx.put('entries',{...saved.entry,id:'large:'+index.toString().padStart(5,'0'),contentId:'large-content:'+index,order:index+1});
      for(let index=0;index<pageTotal;index++){
        const pageId='page:'+index;
        await tx.put('pageDescriptors',{pageId,contentId:saved.entry.contentId,ordinal:index,name:pageId,formatLocator:pageId,locator:{}});
        await tx.put('materializations',{id:'materialization:'+index,pageId,contentId:saved.entry.contentId,renderProfileId:'original-v1',imageSha256:'hash:'+index,width:1,height:1,byteSize:1,mime:'image/png',updatedAt:1});
      }
      await tx.put('tasks',{id:'last-task',entryId:'large:'+(entryTotal-1).toString().padStart(5,'0'),status:'queued'});
    });
    expect(await inspectSourceRemoval(f.connection.id)).toEqual({comicCount:1,downloadTaskCount:1});
    const reads=vi.spyOn(IDBIndex.prototype,'getAll');
    await catalog.deleteComic(saved.comic.id,f.connection.id);
    expect(await catalog.count('entries',{index:'comicId',range:saved.comic.id})).toBe(0);
    expect(await catalog.count('pageDescriptors',{index:'contentId',range:saved.entry.contentId})).toBe(0);
    expect(await catalog.count('materializations',{index:'contentId',range:saved.entry.contentId})).toBe(0);
    expect(await catalog.get('tasks','last-task')).toBeUndefined();
    const bounded=reads.mock.calls.filter((_,i)=>['comicId','contentId','entryId'].includes((reads.mock.contexts[i] as IDBIndex).name));
    expect(bounded.length).toBeGreaterThan(10);expect(bounded.every(args=>Number(args[1])<=100)).toBe(true);
    reads.mockRestore();
    // The same index cursor also crosses a full 100-comic batch without skipping a primary key.
    for(let index=0;index<105;index++)await book(f.connection,'batch:'+index.toString().padStart(3,'0'));
    const first=await catalog.listConnectionComics(f.connection.id,100),last=await catalog.listConnectionComics(f.connection.id,100,first.at(-1)!.id);
    expect(first.length+last.length).toBe(105);expect(new Set([...first,...last].map(item=>item.id)).size).toBe(105);
  },30000);

  it('finishes a representative 105-book removal using bounded scoped metadata reads',async()=>{
    const f=await fixture();for(let index=0;index<105;index++)await book(f.connection,'removal:'+index.toString().padStart(3,'0'));
    const reads=vi.spyOn(IDBIndex.prototype,'getAll'),started=performance.now();
    await removeSource(f.connection.id);
    const elapsed=Math.round(performance.now()-started);
    expect(await catalog.count('comics',{index:'connectionId',range:f.connection.id})).toBe(0);
    const scopes=reads.mock.calls.filter((_,index)=>['connectionId','comicId'].includes((reads.mock.contexts[index] as IDBIndex).name));
    expect(scopes.length).toBeGreaterThan(105);expect(scopes.every(args=>Number(args[1])<=100)).toBe(true);
    console.info(`105-book local removal: ${elapsed} ms; ${scopes.length} scoped getAll reads, all <= 100 records.`);
  },30000);
});
