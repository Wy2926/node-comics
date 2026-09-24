import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importContainer,listContainerReferences,openContainer} from '../src/storage/containers';
import {importLocalFile,reindexEntry} from '../src/comics/application/import-service';
import {beginImportJournal,recordCopiedFile} from '../src/comics/application/import-journal';
import {initializeSources} from '../src/comics/application/source-lifecycle';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {loadEntry,removeComic,saveReaderState} from '../src/comics/application/library-service';
import {LocalImportQueue} from '../src/comics/application/import-queue';
import type {Job} from '../src/types';
const mocks=vi.hoisted(()=>({index:vi.fn(),materialize:vi.fn()}));
vi.mock('../src/comics/formats',()=>({openDocument:async()=>({index:mocks.index,materialize:mocks.materialize,close:async()=>{}})}));
let dispose:()=>void;
beforeEach(()=>{mocks.index.mockReset().mockResolvedValue([{ordinal:0,name:'page.png',locator:{entryIndex:0}}]);mocks.materialize.mockReset();dispose=registerSourceDriver({id:'local',label:'Local',cachePages:false,cacheRanges:false,open:context=>openContainer(context.containerId!)});});
afterEach(()=>dispose());
const file=(name=crypto.randomUUID()+'.cbz',content=crypto.randomUUID())=>new File(['PK',content],name,{type:'application/zip'});
describe('single-file comic imports',()=>{
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
  const job=(id:string,status:Job['status']='succeeded'):Job=>({id,status,input_asset_id:'asset',output_asset_id:status==='succeeded'?id+'-out':null,mode:'classic',target_language:'en',phase:'done',created_at:'2026-09-22',version:1,cache_hit:false,quota_pages:1});
  const first={...page,imageSha256:sha,ownerId:'reader',apiOrigin:'https://api.example',jobs:[job('one')],outputBlobs:{one:'runtime-output'}},second={...first,jobs:[job('two')],outputBlobs:{two:'other-output'}};
  await Promise.all([saveReaderState({...copy,pages:[first]}),saveReaderState({...copy,pages:[second]})]);const binding=(await catalog.get('translationBindings',JSON.stringify(['https://api.example','reader',sha])))!;expect((binding.payload as {jobs:Job[]}).jobs.map(j=>j.id)).toEqual(['one','two']);expect(binding.payload).not.toHaveProperty('outputBlobs');
  await saveReaderState({...copy,pages:[first],lastReadAt:123,pageId:page.id,relativeOffset:.4});expect(await catalog.get('positions',copy.id)).toMatchObject({relativeOffset:.4,updatedAt:123});
  await saveReaderState({...copy,pages:[{...first,jobs:[job('one','running')]}]});expect(((await catalog.get('translationBindings',binding.id))!.payload as {jobs:Job[]}).jobs.find(j=>j.id==='one')?.status).toBe('succeeded');
 });
});
