import 'fake-indexeddb/auto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import type {Comic,Entry} from '../src/comics/domain';
import type {SourceCatalog} from '../src/comics/application/types';
import {downloadKey,downloadStore} from '../src/storage/downloads';
import {sourceDatabaseName} from '../src/storage/database';
const mocks=vi.hoisted(()=>({acquire:vi.fn(),discover:vi.fn(),directory:vi.fn(),track:vi.fn()}));
vi.mock('../src/analytics',()=>({track:mocks.track}));
vi.mock('../src/comics/pages/service',()=>({acquirePage:mocks.acquire}));
vi.mock('../src/sources',()=>({discoverEntry:mocks.discover,ImagePermissionsRequired:class extends Error{},sourceFor:vi.fn(),validateSourceCatalog:(value:unknown)=>value}));
vi.mock('../src/comics/application/import-service',()=>({publishWebsiteManifest:vi.fn()}));
vi.mock('../src/comics/application/website-catalog',()=>({readWebsiteCatalog:mocks.directory}));
import {discoverEntryContent,queueDownloads,stopDownloads} from '../src/comics/acquisition';
import {cancelBookDownload,clearBookDownloads,downloadLanguages,hostBookDownloads,listBookDownloads,pauseBookDownload,readDownloadScope,runBookDownloadCycle,saveDownloadLanguages,startBookDownload} from '../src/comics/acquisition/books';
import {bookDownloadId,readBookPlan,selectDownloadScope} from '../src/comics/acquisition/book-model';

beforeEach(async()=>{
  stopDownloads();vi.clearAllMocks();await downloadStore.clear();
  for(const row of await catalog.list('tasks',{limit:Number.MAX_SAFE_INTEGER}))await catalog.remove('tasks',row.id);
  for(const row of await catalog.list('metadata',{limit:Number.MAX_SAFE_INTEGER}))if(row.id!=='download-host')await catalog.remove('metadata',row.id);
  mocks.acquire.mockImplementation(async()=>({blob:new Blob(['original']),release:vi.fn(),identity:{}}));
});
async function fixture(count=3,pages=2,discovered=true){
  const id=crypto.randomUUID(),now=Date.now();
  const comic:Comic={id,title:'Cache fixture',sourceName:'Fixture',sourceKey:id,sourceUrl:'https://example.test/comic',source:{connectionId:'website:'+id,providerItemId:id,locator:{catalogId:id+':catalog'},generation:1,status:'active'},createdAt:now,updatedAt:now};
  await catalog.put('connections',{id:comic.source.connectionId,provider:'website',displayName:'Fixture',status:'connected',generation:1,createdAt:now,updatedAt:now});
  await catalog.put('comics',comic);
  const entries:Entry[]=Array.from({length:count},(_,order)=>({id:id+':'+order,comicId:id,title:'Chapter '+order,sourceEntryId:'source:'+order,sourceUrl:'https://example.test/chapter/'+order,format:'website',contentId:id+':content:'+order,generation:1,indexState:discovered?'ready':'pending',order,sequenceId:order<2?'main':'extra',readingSlotId:order<2?'first':'extra:'+order,contentLanguage:order%2?'en':'zh-Hans',discoveryComplete:discovered,pageCount:discovered?pages:undefined,knownTotal:discovered?pages:undefined,createdAt:now,updatedAt:now}));
  for(const entry of entries){
    await catalog.put('entries',entry);
    await catalog.putPages(entry.id,entry.contentId,Array.from({length:pages},(_,ordinal)=>({pageId:entry.id+':page:'+ordinal,contentId:entry.contentId,ordinal,name:'Page '+(ordinal+1),formatLocator:String(ordinal),locator:{url:'https://example.test/'+ordinal+'.png'}})),entry.generation);
  }
  const source:SourceCatalog={id:id+':catalog',comicId:id,sourceId:'fixture',url:comic.sourceUrl!,title:comic.title,observedAt:now,complete:true,note:'',groups:[{id:'main',title:'Main',complete:true,entryIds:entries.slice(0,2).map(entry=>entry.sourceEntryId!)},{id:'extras',title:'Extras',complete:true,entryIds:entries.slice(1).map(entry=>entry.sourceEntryId!)}],entries:entries.map(entry=>({id:entry.sourceEntryId!,catalogId:id,remoteId:entry.id,url:entry.sourceUrl!,title:entry.title,groupIds:[],rawTypes:[],order:entry.order,related:false,contentLanguage:entry.contentLanguage,sequenceId:entry.sequenceId,readingSlotId:entry.readingSlotId}))};
  await catalog.put('catalogs',{...source});return {comic,entries,source};
}
const cycle=()=>runBookDownloadCycle(new AbortController().signal,'test-host');
const view=async(id:string)=>(await listBookDownloads(true)).find(book=>book.comic.id===id)!;

describe('whole comic retained downloads',()=>{
  it('selects all groups and releases, deduplicates identity, and applies only cache-language selection',async()=>{
    const f=await fixture();
    const scope=selectDownloadScope([...f.entries,f.entries[1]],f.source,null);
    expect(scope.selected.map(entry=>entry.id)).toEqual(f.entries.map(entry=>entry.id));
    expect(selectDownloadScope(f.entries,f.source,['en']).selected.map(entry=>entry.id)).toEqual([f.entries[1].id]);
    expect(selectDownloadScope(f.entries,f.source,['en']).missingLanguages).toBe(1);
    const related={...f.entries[2],sourceEntryId:'related'};
    expect(selectDownloadScope([...f.entries,related],{...f.source,entries:[...f.source.entries,{...f.source.entries[0],id:'related',related:true}]},null).selected).toHaveLength(3);
  });
  it('registers one plan for concurrent starts, saves originals and preserves reading metadata',async()=>{
    const f=await fixture(),before=await catalog.get('comics',f.comic.id);
    expect((await Promise.all([startBookDownload(f.comic.id),startBookDownload(f.comic.id)])).filter(Boolean)).toHaveLength(1);
    expect(await catalog.list('tasks')).toHaveLength(0);
    const startedAt=(await readBookPlan(f.comic.id))!.createdAt;
    await cycle();
    expect(mocks.acquire).toHaveBeenCalledTimes(6);
    expect(await view(f.comic.id)).toMatchObject({status:'complete',completed:3,total:3,bytes:48});
    expect(await catalog.get('comics',f.comic.id)).toEqual(before);
    expect((await catalog.listEntries(f.comic.id)).every(entry=>!entry.readAt)).toBe(true);
    expect(mocks.track).toHaveBeenCalledWith('offline_download_result',expect.objectContaining({outcome:'success',count:3}),startedAt);
    await cycle();expect(mocks.track).toHaveBeenCalledTimes(1);
    await startBookDownload(f.comic.id);await cycle();expect(mocks.acquire).toHaveBeenCalledTimes(6);
  });
  it('remembers multiple languages independently and keeps other-language originals when changing scope',async()=>{
    const f=await fixture();await saveDownloadLanguages(f.comic.id,['en']);
    await startBookDownload(f.comic.id);await cycle();expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect((await view(f.comic.id)).total).toBe(1);
    await startBookDownload(f.comic.id,['zh-Hans'],true);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'complete',completed:2,total:2,bytes:48});
    expect(await downloadStore.get(downloadKey(f.entries[1].contentId,f.entries[1].id+':page:0'))).toBeDefined();
    await expect(startBookDownload(f.comic.id,[],true)).rejects.toThrow('至少选择');
    expect(await catalog.get('metadata','reading-preferences:'+f.comic.id)).toBeUndefined();
  });
  it('records partial failure without 100%, continues the next chapter, and retries only missing pages',async()=>{
    const f=await fixture();
    mocks.acquire.mockImplementation(async(request:{entryId:string})=>{if(request.entryId===f.entries[1].id)throw Error('Temporary page failure');return {blob:new Blob(['original']),release:vi.fn(),identity:{}};});
    await startBookDownload(f.comic.id);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'partial',completed:2,total:3});
    const calls=mocks.acquire.mock.calls.length;
    mocks.acquire.mockImplementation(async()=>({blob:new Blob(['original']),release:vi.fn(),identity:{}}));
    await startBookDownload(f.comic.id);await cycle();
    expect(mocks.acquire).toHaveBeenCalledTimes(calls+2);
    expect((await view(f.comic.id)).status).toBe('complete');
  });
  it('resumes from retained metadata without reading complete chapters or saved page Blobs again',async()=>{
    const f=await fixture(),missing=f.entries[2].id+':page:1';
    mocks.acquire.mockImplementation(async(request:{pageId:string})=>{
      if(request.pageId===missing)throw Error('Page unavailable');
      return {blob:new Blob(['original']),release:vi.fn(),identity:{}};
    });
    await startBookDownload(f.comic.id);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'partial',completed:2,bytes:40});
    mocks.acquire.mockReset().mockImplementation(async()=>({blob:new Blob(['original']),release:vi.fn(),identity:{}}));
    const blobs=vi.spyOn(downloadStore,'get'),pages=vi.spyOn(catalog,'listPages');
    try{
      await startBookDownload(f.comic.id);await cycle();
      expect(mocks.acquire).toHaveBeenCalledTimes(1);expect(mocks.acquire.mock.calls[0][0].pageId).toBe(missing);
      expect(blobs).not.toHaveBeenCalled();
      expect(pages.mock.calls.every(([contentId])=>contentId===f.entries[2].contentId)).toBe(true);
      expect(await view(f.comic.id)).toMatchObject({status:'complete',completed:3,bytes:48});
    }finally{blobs.mockRestore();pages.mockRestore();}
  });
  it('does not treat a conflicting zero total as a complete retained chapter',async()=>{
    const f=await fixture(1,2);await catalog.patch('entries',f.entries[0].id,{knownTotal:0});
    await startBookDownload(f.comic.id);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'partial',completed:0,bytes:16});
    await catalog.patch('entries',f.entries[0].id,{knownTotal:2});
    await startBookDownload(f.comic.id);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'complete',completed:1,bytes:16});
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
  });
  it('pauses the entire plan, fences late image writes, and resumes all unfinished chapters',async()=>{
    const f=await fixture(),ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(()=>{ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    const reads=vi.spyOn(catalog,'get');
    try{
      await catalog.put('metadata',{id:'unrelated-source-session',updatedAt:Date.now()});
      await catalog.patch('entries',f.entries[1].id,{title:'Unrelated chapter update'});
      await catalog.patch('tasks','download:'+f.entries[1].id,{updatedAt:Date.now()});
      expect(reads).not.toHaveBeenCalled();
    }finally{reads.mockRestore();}
    await pauseBookDownload(f.comic.id);pending.resolve({blob:new Blob(['late']),release:vi.fn(),identity:{}});await run;
    expect((await view(f.comic.id)).status).toBe('paused');expect((await downloadStore.usage()).count).toBe(0);
    expect((await catalog.list('tasks')).every(task=>task.status==='paused')).toBe(true);
    await startBookDownload(f.comic.id);await cycle();expect((await view(f.comic.id)).completed).toBe(3);
  });
  it('retains completed pages on pause and resumes only unfinished pages',async()=>{
    const f=await fixture(2),ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(async()=>({blob:new Blob(['original']),release:vi.fn(),identity:{}}));
    mocks.acquire.mockImplementationOnce(()=>{ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    await pauseBookDownload(f.comic.id);pending.resolve({blob:new Blob(['late']),release:vi.fn(),identity:{}});await run;
    expect(await view(f.comic.id)).toMatchObject({status:'paused',bytes:8});
    await startBookDownload(f.comic.id);await cycle();
    expect(await view(f.comic.id)).toMatchObject({status:'complete',bytes:32});
    expect(mocks.acquire).toHaveBeenCalledTimes(5);
  });
  it('cancels a paused download instead of retaining a stopped plan, tasks or originals',async()=>{
    const f=await fixture(2),ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<unknown>();
    await catalog.savePosition({id:f.entries[0].id,entryId:f.entries[0].id,comicId:f.comic.id,contentId:f.entries[0].contentId,pageId:f.entries[0].id+':page:1',relativeOffset:0.3,updatedAt:Date.now()});
    const comicBefore=await catalog.get('comics',f.comic.id),positionBefore=await catalog.get('positions',f.entries[0].id);
    await saveDownloadLanguages(f.comic.id,['en','zh-Hans']);
    mocks.acquire.mockImplementationOnce(async()=>({blob:new Blob(['original']),release:vi.fn(),identity:{}}));
    mocks.acquire.mockImplementationOnce(()=>{ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    await pauseBookDownload(f.comic.id);
    expect(await view(f.comic.id)).toMatchObject({status:'paused',bytes:8});
    await Promise.all([cancelBookDownload(f.comic.id),cancelBookDownload(f.comic.id)]);
    pending.resolve({blob:new Blob(['late']),release:vi.fn(),identity:{}});await run;
    expect(await readBookPlan(f.comic.id)).toBeUndefined();expect(await view(f.comic.id)).toBeUndefined();
    expect(await catalog.list('tasks')).toEqual([]);expect((await downloadStore.usage()).count).toBe(0);
    expect(await catalog.get('comics',f.comic.id)).toEqual(comicBefore);
    expect(await catalog.get('positions',f.entries[0].id)).toEqual(positionBefore);
    expect(await downloadLanguages(f.comic.id)).toEqual(['en','zh-Hans']);
  });
  it('fences cancelled preparations and late workers when a fresh plan recreates its tasks',async()=>{
    const f=await fixture(1),ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(()=>{ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    const previous=(await readBookPlan(f.comic.id))!;
    await cancelBookDownload(f.comic.id);
    await queueDownloads([f.entries[0].id],{comicId:f.comic.id,generation:previous.generation});
    expect(await catalog.list('tasks')).toEqual([]);
    await startBookDownload(f.comic.id);
    expect((await readBookPlan(f.comic.id))!.generation).toBeGreaterThan(previous.generation);
    await queueDownloads([f.entries[0].id],{comicId:f.comic.id,generation:previous.generation});
    expect(await catalog.list('tasks')).toEqual([]);
    const resumed=cycle();
    await vi.waitFor(async()=>expect((await readBookPlan(f.comic.id))?.status).toBe('running'));
    pending.resolve({blob:new Blob(['late']),release:vi.fn(),identity:{}});await Promise.all([run,resumed]);
    expect(await view(f.comic.id)).toMatchObject({status:'complete',completed:1,bytes:16});
    expect(await (await downloadStore.get(downloadKey(f.entries[0].contentId,f.entries[0].id+':page:0')))!.text()).toBe('original');
  });
  it('rejects stale row actions queued with cancellation or targeting a fresh replacement',async()=>{
    const f=await fixture(2);await startBookDownload(f.comic.id,['zh-Hans']);await cycle();
    const previous=(await readBookPlan(f.comic.id))!;
    const [_,applied]=await Promise.all([
      cancelBookDownload(f.comic.id,previous.generation),
      startBookDownload(f.comic.id,['en'],true,undefined,previous.generation),
    ]);
    expect(applied).toBe(false);expect(await readBookPlan(f.comic.id)).toBeUndefined();
    expect(await downloadLanguages(f.comic.id)).toEqual(['zh-Hans']);
    expect(await startBookDownload(f.comic.id,undefined,false,undefined,previous.generation)).toBe(false);
    await startBookDownload(f.comic.id);const replacement=await readBookPlan(f.comic.id);
    expect(await startBookDownload(f.comic.id,['en'],true,undefined,previous.generation)).toBe(false);
    await pauseBookDownload(f.comic.id,previous.generation);
    await cancelBookDownload(f.comic.id,previous.generation);
    await clearBookDownloads(f.comic.id,previous.generation);
    expect(await readBookPlan(f.comic.id)).toEqual(replacement);
    expect(await downloadLanguages(f.comic.id)).toEqual(['zh-Hans']);
  });
  it('clears completed content, removes its record and serializes a concurrent fresh start',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);await cycle();
    const ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<void>();
    const remove=downloadStore.deleteOwner.bind(downloadStore);
    const delayed=vi.spyOn(downloadStore,'deleteOwner').mockImplementationOnce(async id=>{ready.resolve();await pending.promise;await remove(id);});
    try{
      const clearing=clearBookDownloads(f.comic.id);await ready.promise;
      const restart=startBookDownload(f.comic.id);pending.resolve();await clearing;
      expect((await downloadStore.usage()).count).toBe(0);expect(await catalog.list('tasks')).toEqual([]);
      expect(await restart).toBe(true);await cycle();expect((await view(f.comic.id)).status).toBe('complete');
      await clearBookDownloads(f.comic.id);expect(await view(f.comic.id)).toBeUndefined();
      expect(await catalog.get('comics',f.comic.id)).toBeDefined();
    }finally{delayed.mockRestore();}
  });
  it('recovers failed cleanup and legacy stopped records without adopting their tasks again',async()=>{
    const clearing=await fixture(1),legacy=await fixture(1);
    await startBookDownload(clearing.comic.id);await cycle();await startBookDownload(legacy.comic.id);await cycle();
    const failure=vi.spyOn(downloadStore,'deleteOwner').mockRejectedValueOnce(Error('Storage temporarily unavailable'));
    await expect(clearBookDownloads(clearing.comic.id)).rejects.toThrow('Storage temporarily unavailable');failure.mockRestore();
    await pauseBookDownload(clearing.comic.id);
    expect((await readBookPlan(clearing.comic.id))?.status).toBe('clearing');
    await expect(startBookDownload(clearing.comic.id)).rejects.toThrow('正在清理');
    await catalog.patch('metadata',bookDownloadId(legacy.comic.id),{status:'stopped'});
    await catalog.patch('tasks','download:'+legacy.entries[0].id,{bookId:undefined,bookGeneration:undefined});
    const controller=new AbortController(),host=hostBookDownloads(controller.signal);
    await vi.waitFor(async()=>{expect(await readBookPlan(clearing.comic.id)).toBeUndefined();expect(await readBookPlan(legacy.comic.id)).toBeUndefined();});
    controller.abort();await host;
    expect(await catalog.list('tasks')).toEqual([]);expect(await listBookDownloads()).toEqual([]);
    expect((await downloadStore.usage()).count).toBe(0);
  });
  it('keeps failed cancellation fencing as a retryable deletion intent',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);await cycle();
    const failure=vi.spyOn(downloadStore,'invalidateOwner').mockRejectedValueOnce(Error('Storage unavailable'));
    try{await expect(cancelBookDownload(f.comic.id)).rejects.toThrow('Storage unavailable');}finally{failure.mockRestore();}
    expect(await readBookPlan(f.comic.id)).toMatchObject({status:'clearing',error:'Storage unavailable'});
    await clearBookDownloads(f.comic.id);expect(await readBookPlan(f.comic.id)).toBeUndefined();
    expect((await downloadStore.usage()).count).toBe(0);
  });
  it('cancels queued and discovering plans without publishing a late directory or download task',async()=>{
    const queued=await fixture(1);await startBookDownload(queued.comic.id);await cancelBookDownload(queued.comic.id);
    expect(await readBookPlan(queued.comic.id)).toBeUndefined();
    const f=await fixture(1);await catalog.patch('catalogs',f.source.id,{complete:false});
    const ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<SourceCatalog>();
    let signal:AbortSignal|undefined;
    mocks.directory.mockImplementationOnce((_url:string,lifetime:AbortSignal)=>{signal=lifetime;ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    await cancelBookDownload(f.comic.id);expect(signal?.aborted).toBe(true);
    pending.resolve({...f.source,title:'Late directory'});await run;
    expect(await readBookPlan(f.comic.id)).toBeUndefined();expect(await catalog.list('tasks')).toEqual([]);
    expect((await catalog.get('catalogs',f.source.id))?.complete).toBe(false);expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('recovers an abandoned whole-book host by pausing queued as well as running chapters',async()=>{
    const f=await fixture();await startBookDownload(f.comic.id);
    await catalog.patch('metadata',bookDownloadId(f.comic.id),{createdAt:1,owner:'dead-host'});
    const controller=new AbortController(),host=hostBookDownloads(controller.signal);
    await vi.waitFor(async()=>expect((await readBookPlan(f.comic.id))?.status).toBe('paused'));
    controller.abort();await host;expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('does not count an incomplete manifest or a missing retained object as complete',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);await cycle();
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open(sourceDatabaseName('downloads'));open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('objects','readwrite');tx.objectStore('objects').delete(downloadKey(f.entries[0].contentId,f.entries[0].id+':page:0'));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
    expect(await view(f.comic.id)).toMatchObject({status:'partial',completed:0});
    await catalog.patch('entries',f.entries[0].id,{knownTotal:3});
    await startBookDownload(f.comic.id);await cycle();expect((await view(f.comic.id)).status).toBe('partial');
  });
  it('can revisit retained originals without refreshing expiring source URLs',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);await cycle();
    const [page]=await catalog.listPages(f.entries[0].contentId);
    await catalog.put('pageDescriptors',{...page,locator:{...page.locator,contentKey:'stable-source-page'}});
    await discoverEntryContent(f.entries[0].id,undefined,{refreshResources:true});
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('rejects late writes after source revocation and comic removal',async()=>{
    const f=await fixture(1),ready=Promise.withResolvers<void>(),pending=Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(()=>{ready.resolve();return pending.promise;});
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;
    await catalog.patch('comics',f.comic.id,{source:{...f.comic.source,status:'revoked',generation:2}});
    pending.resolve({blob:new Blob(['late']),release:vi.fn(),identity:{}});await run;
    expect((await downloadStore.usage()).count).toBe(0);
    await catalog.deleteComic(f.comic.id);expect(await readBookPlan(f.comic.id)).toBeUndefined();
  });
  it('honors a source cooldown without retrying the same blocked source or blocking another source',async()=>{
    const a=await fixture(1),b=await fixture(1),other=await fixture(1);
    await catalog.patch('comics',b.comic.id,{source:{...b.comic.source,connectionId:a.comic.source.connectionId}});
    mocks.acquire.mockImplementation(async(request:{entryId:string})=>{if(request.entryId===a.entries[0].id)throw Object.assign(Error('Rate limited'),{details:{status:429,retryAfter:60}});return {blob:new Blob(['original']),release:vi.fn(),identity:{}};});
    await startBookDownload(a.comic.id);await startBookDownload(b.comic.id);await startBookDownload(other.comic.id);
    for(const [order,f] of [a,b,other].entries())await catalog.patch('metadata',bookDownloadId(f.comic.id),{createdAt:order+1});
    await cycle();expect((await readBookPlan(a.comic.id))?.reason).toBe('source');expect((await readBookPlan(b.comic.id))?.status).toBe('paused');
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    await expect(startBookDownload(a.comic.id)).rejects.toThrow('限制请求');await cycle();expect((await view(other.comic.id)).status).toBe('complete');
  });
  it('stops all queued books when retained storage is full',async()=>{
    const a=await fixture(1),b=await fixture(1);await startBookDownload(a.comic.id);await startBookDownload(b.comic.id);
    const full=vi.spyOn(downloadStore,'put').mockRejectedValueOnce(new DOMException('Storage full','QuotaExceededError'));
    try{await cycle();expect((await readBookPlan(a.comic.id))?.reason).toBe('space');expect((await readBookPlan(b.comic.id))?.reason).toBe('space');expect(mocks.acquire).toHaveBeenCalledTimes(1);}
    finally{full.mockRestore();}
  });
  it('does not automatically restart a network-paused plan in a new page',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);
    await catalog.patch('metadata',bookDownloadId(f.comic.id),{status:'paused',reason:'network',createdAt:1});
    const controller=new AbortController(),host=hostBookDownloads(controller.signal);
    await vi.waitFor(async()=>expect((await readBookPlan(f.comic.id))?.reason).toBe('interrupted'));
    controller.abort();await host;expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('keeps manual pause authoritative when an automatic network retry is already pending',async()=>{
    const f=await fixture(1);await startBookDownload(f.comic.id);
    await catalog.patch('metadata',bookDownloadId(f.comic.id),{status:'paused',reason:'network'});
    const pending=(await readBookPlan(f.comic.id))!;await pauseBookDownload(f.comic.id);
    expect(await startBookDownload(f.comic.id,undefined,false,pending.generation)).toBe(false);
    expect((await readBookPlan(f.comic.id))?.status).toBe('paused');expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('adopts legacy chapter downloads without starting their abandoned queue',async()=>{
    const f=await fixture();await queueDownloads([f.entries[0].id]);
    const controller=new AbortController(),host=hostBookDownloads(controller.signal);
    await vi.waitFor(async()=>expect((await readBookPlan(f.comic.id))?.entryIds).toHaveLength(3));
    controller.abort();await host;expect(mocks.acquire).not.toHaveBeenCalled();expect((await view(f.comic.id)).status).toBe('paused');
  });
  it('refuses incomplete directories and cancels discovery when the whole-book plan is paused',async()=>{
    const f=await fixture();await catalog.patch('catalogs',f.source.id,{complete:false});
    mocks.directory.mockResolvedValueOnce({...f.source,complete:false});
    await startBookDownload(f.comic.id);await cycle();expect((await readBookPlan(f.comic.id))?.status).toBe('paused');expect(await catalog.list('tasks')).toHaveLength(0);
    const ready=Promise.withResolvers<void>();
    mocks.directory.mockImplementationOnce((_url:string,signal:AbortSignal)=>new Promise((_,reject)=>{ready.resolve();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
    await startBookDownload(f.comic.id);const run=cycle();await ready.promise;await pauseBookDownload(f.comic.id);await run;
    expect((await readBookPlan(f.comic.id))?.status).toBe('paused');expect(mocks.acquire).not.toHaveBeenCalled();
    expect((await catalog.get('catalogs',f.source.id))?.complete).toBe(false);
  });
  it('enumerates more than 1000 targets across all directories',async()=>{
    const f=await fixture(1003,0);
    expect((await readDownloadScope(f.comic.id)).selected).toHaveLength(1003);
    // Zero-page entries still remain targets and fail explicitly instead of disappearing.
    mocks.discover.mockRejectedValue(Error('Pages unavailable'));
    await startBookDownload(f.comic.id);await cycle();
    expect((await view(f.comic.id)).total).toBe(1003);
    expect((await catalog.list('tasks',{limit:Number.MAX_SAFE_INTEGER})).length).toBe(1003);
  },60000);
  it('discovers only the current chapter while a large undiscovered book is being cached',async()=>{
    const f=await fixture(1003,0,false),bySource=new Map(f.entries.map(entry=>[entry.sourceEntryId,entry]));
    mocks.discover.mockImplementation(async(_source:SourceCatalog,sourceEntryId:string)=>{
      const entry=bySource.get(sourceEntryId)!;
      await catalog.putPages(entry.id,entry.contentId,Array.from({length:2},(_,ordinal)=>({pageId:entry.id+':page:'+ordinal,contentId:entry.contentId,ordinal,name:'Page '+(ordinal+1),formatLocator:String(ordinal),locator:{url:'https://example.test/'+ordinal+'.png'}})),entry.generation);
      await catalog.finishIndex(entry.id,entry.contentId,entry.generation,{discoveryComplete:true,pageCount:2,knownTotal:2});
      return {};
    });
    const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),releaseFirst=Promise.withResolvers<void>(),releaseSecond=Promise.withResolvers<void>();
    mocks.acquire.mockImplementation(async(request:{entryId:string;pageId:string})=>{
      if(request.entryId===f.entries[0].id&&request.pageId.endsWith(':0')){first.resolve();await releaseFirst.promise;}
      if(request.entryId===f.entries[1].id){second.resolve();await releaseSecond.promise;}
      return {blob:new Blob(['original']),release:vi.fn(),identity:{}};
    });
    const controller=new AbortController();
    await startBookDownload(f.comic.id);expect(mocks.discover).not.toHaveBeenCalled();expect(mocks.acquire).not.toHaveBeenCalled();
    const run=runBookDownloadCycle(controller.signal,'test-host');
    try{
      await first.promise;
      expect((await readBookPlan(f.comic.id))?.entryIds).toHaveLength(1003);
      expect(mocks.discover).toHaveBeenCalledTimes(1);expect(mocks.acquire).toHaveBeenCalledTimes(1);
      expect(await catalog.count('pageDescriptors',{index:'contentId',range:f.entries[1].contentId})).toBe(0);
      releaseFirst.resolve();await second.promise;
      expect(mocks.discover).toHaveBeenCalledTimes(2);expect(mocks.acquire).toHaveBeenCalledTimes(3);
      expect((await catalog.get('tasks','download:'+f.entries[0].id))?.status).toBe('complete');
      expect((await catalog.listEntries(f.comic.id)).filter(entry=>entry.discoveryComplete)).toHaveLength(2);
      expect((await downloadStore.usage()).count).toBe(2);
    }finally{controller.abort();releaseFirst.resolve();releaseSecond.resolve();await run;}
  },60000);
  it('honors a pause during large queue registration without creating late queued tasks',async()=>{
    const f=await fixture(205,0,false);await startBookDownload(f.comic.id);
    const plan=(await readBookPlan(f.comic.id))!;
    await catalog.patch('metadata',plan.id,{entryIds:f.entries.map(entry=>entry.id)});
    let pausing:Promise<unknown>|undefined;
    const unsubscribe=catalog.subscribe(change=>{if(change.table==='tasks'&&!pausing)pausing=pauseBookDownload(f.comic.id);});
    try{
      await queueDownloads(f.entries.map(entry=>entry.id),{comicId:f.comic.id,generation:plan.generation});
      await pausing;
      const tasks=await catalog.list('tasks',{limit:Number.MAX_SAFE_INTEGER});
      expect(tasks.length).toBeGreaterThan(0);expect(tasks.length).toBeLessThan(f.entries.length);
      expect(tasks.every(task=>task.status==='paused')).toBe(true);
      expect((await readBookPlan(f.comic.id))?.status).toBe('paused');
      expect(mocks.discover).not.toHaveBeenCalled();expect(mocks.acquire).not.toHaveBeenCalled();
    }finally{unsubscribe();}
  });
  it('preserves directory order across queue batches within the same clock tick',async()=>{
    const f=await fixture(105,1),now=vi.spyOn(Date,'now').mockReturnValue(1000);
    try{await startBookDownload(f.comic.id);await cycle();}finally{now.mockRestore();}
    expect(mocks.acquire.mock.calls.map(([request])=>request.entryId)).toEqual(f.entries.map(entry=>entry.id));
    expect((await view(f.comic.id)).status).toBe('complete');
  },30000);
});
