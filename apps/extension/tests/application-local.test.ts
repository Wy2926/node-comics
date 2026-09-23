import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/comics/repositories';
import { importContainer, listContainerReferences, openContainer } from '../src/storage/containers';
import { importImageAlbum, importLocalFile, importManifest, publishWebsiteManifest, registerDocument, reindexDocument } from '../src/comics/application/import-service';
import { beginImportJournal, recordCopiedFile } from '../src/comics/application/import-journal';
import { initializeSources, invalidateSourceAccess, reconnectSource } from '../src/comics/application/source-lifecycle';
import { registerSourceDriver } from '../src/comics/sources/registry';
import { loadDocument, removeDocument, removeWork, saveReaderState } from '../src/comics/application/library-service';
import { LocalImportQueue } from '../src/comics/application/import-queue';
import { sourcePageCache } from '../src/storage/source-pages';
import type { Job } from '../src/types';
import type { PageManifest } from '../src/sources';

const mocks=vi.hoisted(()=>({index:vi.fn(),remote:vi.fn(),select:vi.fn(),materialize:vi.fn()}));
vi.mock('../src/comics/formats',()=>({openDocument:async()=>({index:mocks.index,materialize:mocks.materialize,close:async()=>{}})}));
let disposeDrivers:(()=>void)[]=[];
beforeEach(()=>{
  mocks.index.mockReset().mockResolvedValue([{ordinal:0,name:'page.png',locator:{entryIndex:0}}]);
  mocks.remote.mockReset();mocks.select.mockReset();
  disposeDrivers=[registerSourceDriver({id:'local',label:'本地文件',cachePages:false,cacheRanges:false,open:context=>{
    const containerId=context.containerId??context.revision.containerId;if(!containerId)throw Error('本地容器不存在。');return openContainer(containerId);
  }}),registerSourceDriver({id:'fixture-cloud',label:'Fixture cloud',cachePages:true,cacheRanges:false,open:mocks.remote,select:mocks.select})];
});
afterEach(()=>{for(const dispose of disposeDrivers)dispose();disposeDrivers=[];});
const image=(name=crypto.randomUUID()+'.png',content=crypto.randomUUID())=>new File([new Uint8Array([137,80,78,71,13,10,26,10]),content],name,{type:'image/png'});
const assignment=()=>({title:'Test '+crypto.randomUUID(),kind:'book' as const});
async function work(){const id=crypto.randomUUID();await catalog.put('works',{id,title:'Target',createdAt:1,updatedAt:1});return id;}

describe('local source application lifecycle',()=>{
  it('copies one immutable source and deduplicates registrations without materializing any pages',async()=>{
    const file=image(),first=await importLocalFile(file,assignment()),second=await importLocalFile(file,assignment());
    expect(second).toEqual({id:first.id,created:false});expect(mocks.materialize).not.toHaveBeenCalled();
    const document=(await catalog.get('documents',first.id))!,revision=(await catalog.get('revisions',document.revisionId))!;
    expect(await listContainerReferences(revision.id)).toHaveLength(1);
    const source=await openContainer(revision.containerId!);try{expect(await source.readAt(0,file.size)).toEqual(new Uint8Array(await file.arrayBuffer()));}finally{await source.close();}
    expect((await catalog.get('works',(await catalog.get('units',document.unitId))!.workId))?.documentCount).toBe(1);
  });
  it('preserves distinct album occurrences and releases shared source bytes only after the last document',async()=>{
    const file=image(),duplicate=new File([file],'repeat.png',{type:file.type});
    const first=await importImageAlbum([file,duplicate],assignment()),target=await work();
    const second=await importImageAlbum([file,duplicate],{...assignment(),workId:target});
    const doc=(await catalog.get('documents',first.id))!,revision=(await catalog.get('revisions',doc.revisionId))!,ids=revision.sourceSnapshot!.containerIds as string[];
    expect(ids[0]).toBe(ids[1]);const pages=await catalog.listPages(doc.revisionId);
    expect(pages).toHaveLength(2);expect(new Set(pages.map(page=>page.pageId)).size).toBe(2);
    await reindexDocument(first.id);expect((await catalog.listPages(doc.revisionId)).map(page=>page.pageId)).toEqual(pages.map(page=>page.pageId));expect(mocks.remote).not.toHaveBeenCalled();
    await removeDocument(first.id);const source=await openContainer(ids[0]);await source.close();
    await removeDocument(second.id);await expect(openContainer(ids[0])).rejects.toThrow('已移除');
  });
  it('recovers an album published between the byte commit and journal update without losing repeated pages',async()=>{
    const first=image(),second=new File([first],'same-image-second.png',{type:'image/png'}),revisionId=crypto.randomUUID();
    const journal=await beginImportJournal(revisionId,'images',[first,second],assignment());
    const bytes=await importContainer(first,undefined,undefined,revisionId);await recordCopiedFile(journal,0,bytes.id);
    await importContainer(second,undefined,undefined,revisionId); // Simulated process exit before recordCopiedFile.
    await initializeSources();
    const revision=(await catalog.get('revisions',revisionId))!;
    expect(revision.sourceSnapshot).toMatchObject({containerIds:[bytes.id,bytes.id],importComplete:true});
    await reindexDocument(revision.documentId);expect(await catalog.listPages(revisionId)).toHaveLength(2);
  });
  it('preserves partial album bytes after a crash without claiming a complete source',async()=>{
    const first=image(),second=image(),revisionId=crypto.randomUUID(),journal=await beginImportJournal(revisionId,'images',[first,second],assignment());
    const bytes=await importContainer(first,undefined,undefined,revisionId);await recordCopiedFile(journal,0,bytes.id);
    await initializeSources();const revision=(await catalog.get('revisions',revisionId))!;
    expect(revision.sourceSnapshot).toMatchObject({containerIds:[bytes.id],expectedPageCount:2,importComplete:false});
    await reindexDocument(revision.documentId);
    expect(await catalog.get('documents',revision.documentId)).toMatchObject({indexState:'failed',pageCount:1,knownTotal:2,discoveryComplete:false});
  });
  it('does not resurrect a removed target work during startup reconciliation',async()=>{
    const target=await work(),revisionId=crypto.randomUUID(),file=image(),journal=await beginImportJournal(revisionId,'file',[file],{...assignment(),workId:target});
    const bytes=await importContainer(file,undefined,undefined,revisionId);await recordCopiedFile(journal,0,bytes.id);
    await removeWork(target);await initializeSources();
    expect(await catalog.get('revisions',revisionId)).toBeUndefined();expect(await listContainerReferences(revisionId)).toHaveLength(0);
    await expect(openContainer(bytes.id)).rejects.toThrow('已移除');
  });
  it('discards a late index after document deletion and closes the retained source lease',async()=>{
    const file=image(),started=Promise.withResolvers<void>(),index=Promise.withResolvers<{ordinal:number;name:string;locator:{entryIndex:number}}[]>();
    mocks.index.mockImplementationOnce(()=>{started.resolve();return index.promise;});
    const importing=importLocalFile(file,assignment());const outcome=expect(importing).rejects.toThrow();await started.promise;
    const document=(await catalog.list('documents',{limit:10000})).find(document=>document.title===file.name.replace(/\.[^.]+$/,''))!;
    const revision=(await catalog.get('revisions',document.revisionId))!;await removeDocument(document.id);
    index.resolve([{ordinal:0,name:'late.png',locator:{entryIndex:0}}]);await outcome;
    expect(await catalog.listPages(document.revisionId)).toHaveLength(0);expect(await catalog.get('documents',document.id)).toBeUndefined();
    await expect(openContainer(revision.containerId!)).rejects.toThrow('已移除');
  });
  it('groups image files with missing browser MIME types and avoids whole-file preflight reads',async()=>{
    const queue=new LocalImportQueue(),first=image('2.png'),second=image('1.png'),files=[first,second].map(file=>new File([file],file.name));
    await queue.add(files);expect(queue.getSnapshot().items).toHaveLength(1);
    expect(queue.getSnapshot().items[0].files.map(file=>file.name)).toEqual(['1.png','2.png']);expect(queue.getSnapshot().items[0].status).toBe('ready');queue.dispose();
  });
});

describe('local content bindings and access revocation',()=>{
  it('keeps website page identity across new discovery sessions and rejects changed slots at the same URL',async()=>{
    const manifest:PageManifest={id:'first-session',sourceTabId:1,navigationId:'one',revision:1,title:'Website '+crypto.randomUUID(),url:'https://example.org/'+crypto.randomUUID(),adapter:'generic',direction:'rtl',discoveryComplete:true,note:'',items:[{id:'slot-1',url:'https://example.org/page.png',width:1,height:1,order:0}]};
    const id=await importManifest(manifest,assignment()),document=(await catalog.get('documents',id))!,before=await catalog.listPages(document.revisionId);
    await publishWebsiteManifest(document,{...manifest,id:'second-session',navigationId:'two'});
    const after=await catalog.listPages(document.revisionId);expect(after).toHaveLength(1);expect(after[0].pageId).toBe(before[0].pageId);expect(after[0].locator.manifestId).toBe('second-session');
    await expect(publishWebsiteManifest(document,{...manifest,items:[{...manifest.items[0],id:'changed-slot'}]})).rejects.toThrow('文档版本');
    expect(await catalog.listPages(document.revisionId)).toHaveLength(1);
  });
  it('merges concurrent content results, drops runtime cache keys, and only saves changed page bindings',async()=>{
    const result=await importLocalFile(image(),assignment()),copy=await loadDocument(result.id),page=copy.pages[0],sha='d'.repeat(64);
    const job=(id:string,status:Job['status']='succeeded'):Job=>({id,status,input_asset_id:'asset',output_asset_id:status==='succeeded'?id+'-out':null,mode:'classic',target_language:'en',phase:'done',created_at:'2026-09-22',version:1,cache_hit:false,quota_pages:1});
    const first={...page,imageSha256:sha,ownerId:'reader',apiOrigin:'https://api.example',jobs:[job('one')],outputBlobs:{one:'runtime-output'}};
    const second={...first,jobs:[job('two')],outputBlobs:{two:'other-runtime-output'}};
    await Promise.all([saveReaderState({...copy,pages:[first]}),saveReaderState({...copy,pages:[second]})]);
    const binding=(await catalog.get('translationBindings',JSON.stringify(['https://api.example','reader',sha])))!;
    expect((binding.payload as {jobs:Job[]}).jobs.map(job=>job.id)).toEqual(['one','two']);expect(binding.payload).not.toHaveProperty('outputBlobs');
    const writes=vi.spyOn(IDBObjectStore.prototype,'put');await saveReaderState({...copy,pages:[first],lastReadAt:123,pageId:page.id,relativeOffset:.4});
    expect(writes.mock.instances.filter(store=>(store as IDBObjectStore).name==='translationBindings')).toHaveLength(0);writes.mockRestore();
    expect(await catalog.get('positions',copy.id)).toMatchObject({relativeOffset:.4,updatedAt:123});
    await saveReaderState({...copy,pages:[{...first,jobs:[job('one','running')]}]});
    expect(((await catalog.get('translationBindings',binding.id))!.payload as {jobs:Job[]}).jobs.find(job=>job.id==='one')?.status).toBe('succeeded');
  });
  it('marks only the revoked source item unavailable and blocks old cache writers until explicit reconnection',async()=>{
    const account=crypto.randomUUID(),fileId=crypto.randomUUID(),connectionId='fixture:'+account;
    const result=await registerDocument({title:'Cloud test',format:'cbz',sourceKey:'test-cloud:'+fileId,providerItemId:fileId,connectionId,provider:'fixture-cloud',accountId:account,displayName:'Fixture cloud',locator:{resource:fileId},sourceSnapshot:{resource:fileId,size:100,version:'1'}},assignment());
    const token=await sourcePageCache.token(result.document.id);await sourcePageCache.put('test:'+fileId,new Blob(['cached']),{owner:result.document.id,token});
    await invalidateSourceAccess({connectionId,itemId:fileId});
    expect((await catalog.get('connections',connectionId))?.status).toBe('connected');
    expect((await catalog.get('bindings',result.document.sourceBindingId))?.status).toBe('revoked');expect(await sourcePageCache.get('test:'+fileId)).toBeUndefined();
    expect(await sourcePageCache.put('late:'+fileId,new Blob(['late']),{owner:result.document.id,token})).toBe(false);
    mocks.select.mockResolvedValue({connection:{id:connectionId,provider:'fixture-cloud',accountId:account,displayName:'Fixture cloud'},files:[{id:fileId,name:'file.cbz',format:'cbz',sourceKey:'test-cloud:'+fileId,locator:{resource:fileId},snapshot:{resource:fileId,size:100,version:'1'}}]});await reconnectSource(connectionId);
    expect((await catalog.get('bindings',result.document.sourceBindingId))?.status).toBe('active');
    expect(await sourcePageCache.put('new:'+fileId,new Blob(['new']),{owner:result.document.id,token:await sourcePageCache.token(result.document.id)})).toBe(true);
  });
});
