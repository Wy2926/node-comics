import 'fake-indexeddb/auto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LocalImportQueue,importSummary} from '../src/library/import-queue';
import {readLocalFiles} from '../src/library/local-import';
import {hashFile} from '../src/importers/hash';
import {emptyPage} from '../src/reader/model';
import {emptyLibrary,makeCopy} from '../src/library/model';
import {editLibrary,readCopies,readLibrary,putBlob,getBlob,commitCopies,clearCopyImages,savePosition,collectUnusedBlobs,copyBlobKeys} from '../src/library/store';
import type {ReadingCopy} from '../src/types';

vi.mock('../src/library/local-import',()=>({readLocalFiles:vi.fn()}));
const extract=vi.mocked(readLocalFiles);
const assignment={title:'批量作品',kind:'chapter' as const};
const file=(name:string,bytes=name)=>new File([bytes],name);
async function fakeExtract(files:File[]):Promise<ReadingCopy[]>{
 const digest=await hashFile(files[0]),blobKey='test-original:'+digest;
 await putBlob(blobKey,files[0]);
 return [makeCopy(files[0].name,[{...emptyPage('第一页',100,200),imageSha256:digest,blobKey}],'本地测试','file:'+digest)];
}
beforeEach(async()=>{
 const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
 const old=await readCopies();await editLibrary((state,copies)=>{Object.assign(state,emptyLibrary());copies.splice(0);});await collectUnusedBlobs(old.flatMap(copyBlobKeys));
 extract.mockReset();extract.mockImplementation(fakeExtract);
});

describe('local import preflight and per-copy settlement',()=>{
 it('skips renamed identical files before extraction and reports the existing title',async()=>{
  const original=file('原名.cbz');const [copy]=await fakeExtract([original]);await commitCopies([copy],[assignment]);
  const queue=new LocalImportQueue();await queue.add([file('改名.zip',await original.text())]);
  expect(queue.getSnapshot().items[0]).toMatchObject({status:'duplicate',selected:false,copyId:copy.id});
  expect(queue.getSnapshot().items[0].message).toContain('原名.cbz');
  await queue.start(assignment,512);expect(extract).not.toHaveBeenCalled();expect(importSummary(queue.getSnapshot().items)).toBe('已有 1 份，已跳过');
 });
 it('marks missing originals for restoration and retains translation records and reading position',async()=>{
  const original=file('恢复.cbz'),[copy]=await fakeExtract([original]);await commitCopies([copy],[assignment]);
  savePosition(copy.id,1,{pageId:copy.pages[0].id,relativeOffset:.42});await clearCopyImages(copy.id);
  const queue=new LocalImportQueue();await queue.add([original]);expect(queue.getSnapshot().items[0].status).toBe('restore');
  await queue.start(assignment,512);expect(queue.getSnapshot().items[0].status).toBe('restored');
  const saved=await readCopies();expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({id:copy.id,pageId:copy.pages[0].id,relativeOffset:.42});expect(saved[0].pages[0].blobKey).toBeTruthy();
 });
 it('does not claim restored when an edited copy still has unmatched missing pages',async()=>{
  const original=file('编辑过.cbz'),[copy]=await fakeExtract([original]);copy.pages.push({...emptyPage('后来插入的页',100,200),imageSha256:'other-file'});await commitCopies([copy],[assignment]);
  const queue=new LocalImportQueue();await queue.add([original]);await queue.start(assignment,512);
  expect(queue.getSnapshot().items[0]).toMatchObject({status:'failed'});expect(queue.getSnapshot().items[0].message).toContain('仍有 1 页缺少原图');expect(await readCopies()).toHaveLength(1);
 });
 it('decodes one copy for repeated bytes in the same batch, without merging same filenames with different content',async()=>{
  const queue=new LocalImportQueue();await queue.add([file('1.cbz','same'),file('2.cbz','same'),file('1.cbz','different')]);
  await queue.start(assignment,512);
  expect(extract).toHaveBeenCalledTimes(2);expect(queue.getSnapshot().items.map(item=>item.status)).toEqual(['created','created','duplicate']);
  expect(await readCopies()).toHaveLength(2);expect((await readLibrary()).works).toHaveLength(1);
 });
 it('keeps successful files when another fails, and retries only the failed file into the same work',async()=>{
  let fail=true;extract.mockImplementation(async files=>{if(files[0].name==='2.cbz'&&fail)throw Error('文件损坏');return fakeExtract(files);});
  const queue=new LocalImportQueue();await queue.add([file('1.cbz'),file('2.cbz'),file('3.cbz')]);await queue.start(assignment,512);
  expect(queue.getSnapshot().items.map(item=>item.status)).toEqual(['created','failed','created']);expect(await readCopies()).toHaveLength(2);
  fail=false;await queue.retry([queue.getSnapshot().items[1].id],assignment,512);
  expect(extract).toHaveBeenCalledTimes(4);expect(await readCopies()).toHaveLength(3);expect((await readLibrary()).works).toHaveLength(1);
 });
 it('does not let an unsupported file block supported siblings; selection and removal prevent processing',async()=>{
  const queue=new LocalImportQueue();await queue.add([file('不支持.txt'),file('1.cbz'),file('2.cbz'),file('3.cbz')]);
  const byName=(name:string)=>queue.getSnapshot().items.find(item=>item.title===name)!;
  expect(byName('不支持.txt').status).toBe('failed');queue.select(byName('1.cbz').id,false);queue.remove(byName('2.cbz').id);
  await queue.start(assignment,512);expect(extract).toHaveBeenCalledTimes(1);expect((await readCopies())[0].title).toBe('3.cbz');
  queue.select(byName('1.cbz').id,true);await queue.start(assignment,512);expect(await readCopies()).toHaveLength(2);expect((await readLibrary()).works).toHaveLength(1);
 });
 it('rechecks before decoding when another tab has imported the same file after preflight',async()=>{
  const original=file('并发.cbz'),queue=new LocalImportQueue();await queue.add([original]);
  await commitCopies(await fakeExtract([original]),[assignment]);await queue.start(assignment,512);
  expect(extract).not.toHaveBeenCalled();expect(queue.getSnapshot().items[0].status).toBe('duplicate');expect(await readCopies()).toHaveLength(1);
 });
 it('removes uncommitted blobs on a metadata commit failure',async()=>{
  const queue=new LocalImportQueue(),original=file('未提交.cbz');await queue.add([original]);
  await queue.start({title:'不存在',workId:'missing-work',kind:'chapter'},512);
  expect(queue.getSnapshot().items[0].status).toBe('failed');expect(await readCopies()).toHaveLength(0);expect(await getBlob('test-original:'+await hashFile(original))).toBeUndefined();
 });
 it('groups images in natural reading order and keeps comic files separate',async()=>{
  const images=['10.png','2.png','1.png'].map(name=>new File([name],name,{type:'image/png'})),queue=new LocalImportQueue();await queue.add([...images,file('chapter.cbz')]);
  const items=queue.getSnapshot().items;expect(items).toHaveLength(2);expect(items[1].files.map(file=>file.name)).toEqual(['1.png','2.png','10.png']);expect(items[1].key).toMatch(/^images:/);
 });
 it('supports one work per file when explicitly selected',async()=>{
  const queue=new LocalImportQueue();await queue.add([file('1.cbz'),file('2.cbz')]);await queue.start({title:'',kind:'unclassified'},512,true);
  expect((await readLibrary()).works.map(work=>work.title)).toEqual(['1.cbz','2.cbz']);
 });
 it('starts a fresh assignment after every list item is removed',async()=>{
  const queue=new LocalImportQueue();await queue.add([file('1.cbz')]);await queue.start(assignment,512);queue.remove(queue.getSnapshot().items[0].id);
  await queue.add([file('2.cbz')]);await queue.start(assignment,512);expect((await readLibrary()).works).toHaveLength(2);
 });
});

describe('batch controls',()=>{
 it('pauses after the current file commits, then resumes without duplicate extraction',async()=>{
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  extract.mockImplementation(async files=>{entered();await gate;return fakeExtract(files);});
  const queue=new LocalImportQueue();await queue.add([file('1.cbz'),file('2.cbz')]);const run=queue.start(assignment,512);await started;queue.pause();release();await run;
  expect(queue.getSnapshot()).toMatchObject({running:false,phase:'paused'});expect(queue.getSnapshot().items.map(item=>item.status)).toEqual(['created','queued']);
  await queue.resume();expect(extract).toHaveBeenCalledTimes(2);expect(queue.getSnapshot().phase).toBe('done');
 });
 it('stops pending files, guards duplicate starts and refuses to replace an active batch',async()=>{
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  extract.mockImplementation(async files=>{entered();await gate;return fakeExtract(files);});
  const queue=new LocalImportQueue();await queue.add([file('1.cbz'),file('2.cbz'),file('3.cbz')]);const run=queue.start(assignment,512);await started;
  await queue.start(assignment,512);expect(await queue.add([file('覆盖.cbz')])).toBe(false);queue.stopRemaining();release();await run;
  expect(queue.getSnapshot().items.map(item=>item.status)).toEqual(['created','cancelled','cancelled']);expect(extract).toHaveBeenCalledTimes(1);expect(await readCopies()).toHaveLength(1);
 });
});
