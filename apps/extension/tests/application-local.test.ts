import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importContainer,listContainerReferences,openContainer} from '../src/storage/containers';
import {importLocalFile,reindexEntry} from '../src/comics/application/import-service';
import {beginImportJournal,recordCopiedFile} from '../src/comics/application/import-journal';
import {initializeSources} from '../src/comics/application/source-lifecycle';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {coverReference,loadEntry,removeComic,saveReaderState} from '../src/comics/application/library-service';
import {LocalImportQueue} from '../src/comics/application/import-queue';
import type {Job} from '../src/types';
import {PDF_RENDER_PROFILE,RENDER_PROFILE,pageReference} from '../src/comics/pages/identity';
import {acquirePage,materializationId} from '../src/comics/pages/service';
import {sourcePageCache} from '../src/storage/source-pages';
import {downloadKey,downloadStore} from '../src/storage/downloads';
import {planExport} from '../src/export/plan';
const mocks=vi.hoisted(()=>({index:vi.fn(),materialize:vi.fn()}));
vi.mock('../src/comics/formats',()=>({openDocument:async()=>({index:mocks.index,materialize:mocks.materialize,close:async()=>{}})}));
let dispose:()=>void;
beforeEach(()=>{mocks.index.mockReset().mockResolvedValue([{ordinal:0,name:'page.png',locator:{entryIndex:0}}]);mocks.materialize.mockReset();dispose=registerSourceDriver({id:'local',label:'Local',cachePages:false,cacheRanges:false,open:context=>openContainer(context.containerId!)});});
afterEach(()=>dispose());
const file=(name=crypto.randomUUID()+'.cbz',content=crypto.randomUUID())=>new File(['PK',content],name,{type:'application/zip'});
describe('single-file comic imports',()=>{
 it('isolates the new PDF render profile while retaining old cached pages, translations and reading position',async()=>{
  const input=new File(['%PDF-',crypto.randomUUID()],crypto.randomUUID()+'.pdf'),created=await importLocalFile(input),copy=await loadEntry(created.id),page=copy.pages[0];
  const oldRef={entryId:copy.id,contentId:copy.contentId!,pageId:page.id,renderProfileId:RENDER_PROFILE},newRef={...oldRef,renderProfileId:PDF_RENDER_PROFILE};
  const oldBlob=new Blob(['old-pdf'],{type:'image/png'}),oldSha='e'.repeat(64),oldIdentity={id:materializationId(oldRef),contentId:copy.contentId!,pageId:page.id,renderProfileId:RENDER_PROFILE,imageSha256:oldSha,width:8192,height:1953,byteSize:oldBlob.size,mime:'image/png',updatedAt:1};
  await catalog.putMaterialization(oldIdentity,copy.generation);
  await sourcePageCache.put(pageReference(oldRef),oldBlob,{owner:copy.id,contentId:copy.contentId});
  await downloadStore.put(downloadKey(copy.contentId!,page.id),oldBlob,{owner:copy.id,contentId:copy.contentId});
  const oldJob:Job={id:'old-pdf-result',status:'succeeded',result:{key:'old-pdf-result',recoverable:false},mode:'classic',target_language:'en',phase:'done',created_at:'2026-09-22',version:1,cache_hit:false,quota_pages:0};
  await saveReaderState({...copy,pageId:page.id,lastReadAt:100,relativeOffset:.3,pages:[{...page,imageSha256:oldSha,translationScope:'pdf-channel',jobs:[oldJob]}]});
  const position=await catalog.get('positions',copy.id);
  vi.stubGlobal('createImageBitmap',async()=>({width:10000,height:12000,close(){}}));
  const newBlob=new Blob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4])],{type:'image/png'});mocks.materialize.mockResolvedValue(newBlob);
  try{
   const before=await loadEntry(copy.id,{key:'pdf-channel'});expect(before.pages[0]).toMatchObject({renderProfileId:PDF_RENDER_PROFILE,blobKey:pageReference(newRef),jobs:[]});expect(before.pages[0].imageSha256).toBeUndefined();
   const comic=(await catalog.get('comics',created.comicId))!;expect(coverReference(comic)).toBe(pageReference(newRef));
   expect((await planExport(copy.id,{format:'cbz',images:'original',mode:'classic',language:'en'})).pages[0].reference).toEqual(newRef);
   const lease=await acquirePage(newRef);try{expect(lease.blob).toBe(newBlob);expect(lease.identity).toMatchObject({renderProfileId:PDF_RENDER_PROFILE,width:10000,height:12000});expect(lease.identity.imageSha256).not.toBe(oldSha);}finally{lease.release();}
   const after=await loadEntry(copy.id,{key:'pdf-channel'});expect(after.pages[0]).toMatchObject({renderProfileId:PDF_RENDER_PROFILE,width:10000,height:12000,jobs:[]});expect(after.relativeOffset).toBe(.3);
   expect(await catalog.get('positions',copy.id)).toEqual(position);expect(await catalog.get('entries',copy.id)).toMatchObject({contentId:copy.contentId,generation:copy.generation});
   expect(await catalog.get('materializations',materializationId(oldRef))).toEqual(oldIdentity);
   expect(await (await sourcePageCache.get(pageReference(oldRef)))!.text()).toBe('old-pdf');expect(await (await downloadStore.get(downloadKey(copy.contentId!,page.id)))!.text()).toBe('old-pdf');
   expect((await catalog.get('translationBindings',JSON.stringify(['pdf-channel',oldSha])))!.payload).toMatchObject({jobs:[oldJob]});
   expect(downloadKey(copy.contentId!,page.id,PDF_RENDER_PROFILE)).toBe(JSON.stringify([copy.contentId,page.id,PDF_RENDER_PROFILE]));
   expect(downloadKey(copy.contentId!,page.id)).toBe(JSON.stringify([copy.contentId,page.id]));
  }finally{vi.unstubAllGlobals();await removeComic(created.comicId);}
 });
 it('restores channel bindings independently while preserving source bytes and reading position',async()=>{
  const input=file(),created=await importLocalFile(input),copy=await loadEntry(created.id),page=copy.pages[0],sha='c'.repeat(64);
  await catalog.putMaterialization({id:JSON.stringify([copy.contentId,page.id,RENDER_PROFILE]),contentId:copy.contentId!,pageId:page.id,renderProfileId:RENDER_PROFILE,imageSha256:sha,width:800,height:1200,byteSize:10,mime:'image/png',updatedAt:Date.now()},copy.generation);
  const delivered=(id:string):Job=>({id,status:'succeeded',result:{key:id,recoverable:false},mode:'classic',target_language:'en',phase:'done',created_at:'2026-09-22',version:1,cache_hit:false,quota_pages:0});
  for(const channel of ['local-a','local-b'])await saveReaderState({...copy,pageId:page.id,lastReadAt:100,relativeOffset:.3,pages:[{...page,imageSha256:sha,translationScope:channel,jobs:[delivered(channel)]}]});
  for(const channel of ['local-a','local-b']){
   const restored=await loadEntry(copy.id,{key:channel});expect(restored.pages[0]).toMatchObject({translationScope:channel,jobs:[{id:channel}],outputBlobs:{}});expect(restored.pages[0].ownerId).toBeUndefined();expect(restored.relativeOffset).toBe(.3);
   expect(await catalog.list('translationBindings',{index:'scope',range:channel})).toHaveLength(1);
  }
  expect((await loadEntry(copy.id,{key:'other'})).pages[0].jobs).toEqual([]);
  const entry=(await catalog.get('entries',copy.id))!,source=await openContainer(entry.containerId!);try{expect(await source.readAt(0,input.size)).toEqual(new Uint8Array(await input.arrayBuffer()));}finally{await source.close();}
 });
 it('deduplicates identical files even after renaming, without decoding pages',async()=>{
  const input=file(),first=await importLocalFile(input),second=await importLocalFile(new File([input],'renamed.zip'));
  expect(second).toEqual({...first,created:false});expect(mocks.materialize).not.toHaveBeenCalled();
  const entry=(await catalog.get('entries',first.id))!;expect(await catalog.listEntries(first.comicId)).toHaveLength(1);expect(await listContainerReferences(entry.contentId)).toHaveLength(1);
  const comic=(await catalog.get('comics',first.comicId))!,pages=await catalog.listPages(entry.contentId);
  expect(comic.sourceCover).toBeUndefined();expect(comic.cover).toEqual({entryId:entry.id,contentId:entry.contentId,pageId:pages[0].pageId});
  const source=await openContainer(entry.containerId!);try{expect(await source.readAt(0,input.size)).toEqual(new Uint8Array(await input.arrayBuffer()));}finally{await source.close();}
 });
 it('serializes concurrent duplicate imports and keeps different files separate regardless of title',async()=>{
  const input=file();const [a,b]=await Promise.all([importLocalFile(input),importLocalFile(input)]);expect(a.id).toBe(b.id);
  const c=await importLocalFile(file(input.name));expect(c.comicId).not.toBe(a.comicId);
 });
 it('reindexes with stable page identity and removes the only source with its comic',async()=>{
  const saved=await importLocalFile(file()),entry=(await catalog.get('entries',saved.id))!,pages=await catalog.listPages(entry.contentId);
  await reindexEntry(entry.id);expect(await catalog.listPages(entry.contentId)).toEqual(pages);
  await removeComic(saved.comicId);expect(await catalog.get('entries',entry.id)).toBeUndefined();expect(await catalog.listPages(entry.contentId)).toEqual([]);await expect(openContainer(entry.containerId!)).rejects.toThrow('已移除');
 });
 it('recovers a copied file after interruption between byte persistence and registration',async()=>{
  const input=file(),contentId=crypto.randomUUID(),journal=await beginImportJournal(contentId,input),container=await importContainer(input,undefined,undefined,contentId);await recordCopiedFile(journal,container.id);
  await initializeSources();const [entry]=await catalog.list('entries',{index:'contentId',range:contentId});expect(entry.containerId).toBe(container.id);expect(entry.indexState).toBe('ready');expect(await catalog.get('metadata',journal.id)).toBeUndefined();
 });
 it('does not publish empty comics or retain source bytes when indexing fails or is cancelled',async()=>{
  const input=file(),before=await catalog.count('comics');mocks.index.mockRejectedValueOnce(Error('invalid archive'));await expect(importLocalFile(input)).rejects.toThrow('invalid archive');expect(await catalog.count('comics')).toBe(before);
  const controller=new AbortController();mocks.index.mockImplementationOnce(async()=>{controller.abort();return [{ordinal:0,name:'p',locator:{entryIndex:0}}];});await expect(importLocalFile(input,controller.signal)).rejects.toThrow();expect(await catalog.count('comics')).toBe(before);
 });
 it.each(['png','jpg','jpeg','webp','gif','avif','svg'])('rejects a loose %s even with an empty browser MIME type',async extension=>{
  await expect(importLocalFile(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'page.'+extension))).rejects.toThrow('不支持散图');expect(mocks.index).not.toHaveBeenCalled();
 });
 it('rejects images renamed as supported archives',async()=>{await expect(importLocalFile(new File([new Uint8Array([137,80,78,71])],'page.cbz'))).rejects.toThrow('不支持散图');});
 it('automatically imports valid files independently of invalid images in a batch',async()=>{
  const queue=new LocalImportQueue(),before=await catalog.count('comics');const items=await queue.add([file('one.cbz'),new File(['bad'],'two.png'),file('three.cbz')]);expect(items.map(i=>i.status)).toEqual(['created','failed','created']);expect(await catalog.count('comics')).toBe(before+2);expect(queue.getSnapshot().phase).toBe('done');queue.dispose();
 });
 it('pauses after the current file and resumes without repeating it',async()=>{
  const queue=new LocalImportQueue(),started=Promise.withResolvers<void>(),ready=Promise.withResolvers<{ordinal:number;name:string;locator:{entryIndex:number}}[]>();mocks.index.mockImplementationOnce(()=>{started.resolve();return ready.promise;});const processing=queue.add([file(),file()]);await started.promise;queue.pause();ready.resolve([{ordinal:0,name:'p',locator:{entryIndex:0}}]);await processing;expect(queue.getSnapshot().items.map(i=>i.status)).toEqual(['created','queued']);await queue.resume();expect(queue.getSnapshot().items.every(i=>i.status==='created')).toBe(true);expect(mocks.index).toHaveBeenCalledTimes(2);queue.dispose();
 });
 it('merges concurrent translation results without persisting runtime URLs or regressing terminal jobs',async()=>{
  const result=await importLocalFile(file()),copy=await loadEntry(result.id),page=copy.pages[0],sha='d'.repeat(64);
  const job=(id:string,status:Job['status']='succeeded'):Job=>({id,status,mode:'classic',target_language:'en',phase:'done',created_at:'2026-09-22',version:1,cache_hit:false,quota_pages:1});
  const first={...page,imageSha256:sha,translationScope:'local-channel',jobs:[job('one')],outputBlobs:{one:'runtime-output'}},second={...first,jobs:[job('two')],outputBlobs:{two:'other-output'}};
  await Promise.all([saveReaderState({...copy,pages:[first]}),saveReaderState({...copy,pages:[second]})]);const binding=(await catalog.get('translationBindings',JSON.stringify(['local-channel',sha])))!;expect((binding.payload as {jobs:Job[]}).jobs.map(j=>j.id)).toEqual(['one','two']);expect(binding.payload).not.toHaveProperty('outputBlobs');
  await saveReaderState({...copy,pages:[first],lastReadAt:123,pageId:page.id,relativeOffset:.4});expect(await catalog.get('positions',copy.id)).toMatchObject({relativeOffset:.4,updatedAt:123});
  await saveReaderState({...copy,pages:[{...first,jobs:[job('one','running')]}]});expect(((await catalog.get('translationBindings',binding.id))!.payload as {jobs:Job[]}).jobs.find(j=>j.id==='one')?.status).toBe('succeeded');
 });
});
