import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeCopy } from '../src/library/model';
import { commitCopies, editLibrary, putBlob, readCopies, readLibrary, saveCopy, savePosition } from '../src/library/store';
import { insertWebCopy, type WebDestination } from '../src/library/web-import';
import { emptyPage } from '../src/reader/model';
import { sourcePageIdentity } from '../src/sources';
import { initialChoices, moveChoice, refreshChoices, selectManifest } from '../src/sources/core/selection';
import type { PageManifest, SourceItem } from '../src/sources/page';
import { createSourceNavigation } from '../src/sources/page';

beforeAll(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});});
const image=(id:string,width=800,height=1200,order=0):SourceItem=>({id,url:'https://images.example/'+id,width,height,order});
const manifest=(items:SourceItem[]):PageManifest=>({id:'snapshot',sourceTabId:2,navigationId:'nav',revision:1,title:'网页',url:'https://example.test/comic',adapter:'generic',direction:'rtl',discoveryComplete:false,note:'当前图片',items});

describe('generic selection and refresh',()=>{
 it('selects the discovered manifest without another source-resolution filter',()=>{
  const items=[image('avatar',128,128),image('low',320,400),image('banner',2000,400),image('spread',1800,1000),image('webtoon',800,16000),image('lazy',0,0)];
  expect(initialChoices(manifest(items)).every(item=>item.selected)).toBe(true);
  expect(initialChoices({...manifest(items),adapter:'xkcd'}).every(item=>item.selected)).toBe(true);
 });
 it('keeps explicit deselection and order while appending new images',()=>{
  const a=image('a',800,1200,0),b=image('b',800,1200,1),small=image('small',64,64,2);
  let chosen=initialChoices(manifest([a,b,small]));chosen=moveChoice(chosen,'b','a');chosen=chosen.map(item=>({...item,selected:item.id!=='a'}));
  const refreshed=refreshChoices(chosen,manifest([{...small,order:0},{...a,order:1},{...b,order:2},image('new',800,1200,3)]));
  expect(refreshed.map(item=>[item.id,item.selected])).toEqual([['b',true],['a',false],['small',true],['new',true]]);
  expect(refreshChoices(refreshed,manifest([small,b])).map(item=>item.id)).toEqual(['b','small']);
 });
 it('validates source membership and carries the exact selected order without marking a subset complete',()=>{
  const m={...manifest([image('a'),image('b'),image('tiny',50,50)]),discoveryComplete:true,knownTotal:3};
  expect(()=>selectManifest(m,['a','a'])).toThrow('重复');expect(()=>selectManifest(m,['untrusted'])).toThrow('清单');expect(()=>selectManifest(m,[])).toThrow();
  const picked=selectManifest(m,['tiny','a']);expect(picked.items.map(item=>item.id)).toEqual(['tiny','a']);expect(picked.discoveryComplete).toBe(false);expect(picked.knownTotal).toBeUndefined();
  expect(initialChoices(picked).every(item=>item.selected)).toBe(true);
 });
 it('keeps dedicated adapters lazy original URLs without mistaking placeholder dimensions for original dimensions',()=>{
  const imgs=[{dataset:{src:'https://images.example/full'},src:'https://images.example/pixel',currentSrc:'https://images.example/pixel',naturalWidth:1,naturalHeight:1,width:1,height:1},{dataset:{},src:'https://images.example/icon',naturalWidth:64,naturalHeight:64},{dataset:{},src:'javascript:alert(1)'}];
  const doc={title:'网页',querySelectorAll:()=>imgs} as unknown as Document;
  const session=createSourceNavigation(doc).get('https://xkcd.com/1').session,result=session.snapshot();expect(result.items).toHaveLength(2);expect(result.items[0]).toMatchObject({resource:{kind:'http',url:'https://images.example/full'},width:0,height:0});
  Object.assign(doc,{querySelectorAll:()=>imgs.slice(1)});const second=session.snapshot();expect(second.items[0].id).toBe(result.items[1].id);
 });
});

async function setup(){
 const key=crypto.randomUUID(),a={...emptyPage('原页1',800,1200),blobKey:key},b={...emptyPage('原页2',800,1200),blobKey:key,outputBlobs:{translated:key},fileHash:'original-file',pageIndex:5};
 await putBlob(key,new Blob(['original']));const copy=makeCopy('现有章节',[a,b]);
 await commitCopies([copy],[{title:'作品',kind:'chapter'}]);savePosition(copy.id,1,{pageId:b.id,relativeOffset:.45});
 const incoming=makeCopy('新增页面',[{...emptyPage('新增1',800,1200),blobKey:key,fileHash:'new-file',pageIndex:0},{...emptyPage('新增2',800,1200),blobKey:key}],'generic','web:'+key);
 return {copy,incoming,a,b};
}
describe('inserting pages into the existing library',()=>{
 it('restores previously unfetched web pages without reusing translations for changed bytes',async()=>{
  const key=crypto.randomUUID(),url='https://images.example/'+key,sourceKey='web:'+key;
  const first={...emptyPage('失败页',800,1200),sourceUrl:url,fetchError:'HTTP 503'},copy=makeCopy('网页',[first],'网页图片',sourceKey);
  await commitCopies([copy],[{title:'失败恢复',kind:'chapter'}]);await putBlob(key,new Blob(['image']));
  const fetched={...emptyPage('重试页',900,1400),sourceUrl:url,blobKey:key,imageSha256:'digest-a',fileHash:'digest-a',pageIndex:0};
  const retry=makeCopy('重试',[fetched],'网页图片',sourceKey);await commitCopies([retry],[{title:'不要新建',kind:'chapter'}]);
  let saved=(await readCopies()).find(value=>value.id===copy.id)!;expect(saved.pages[0]).toMatchObject({id:first.id,blobKey:key,imageSha256:'digest-a',width:900,height:1400});expect(saved.pages[0].fetchError).toBeUndefined();
  retry.pages[0].imageSha256='digest-b';await commitCopies([retry],[{title:'不要改变',kind:'chapter'}]);saved=(await readCopies()).find(value=>value.id===copy.id)!;expect(saved.pages[0].imageSha256).toBe('digest-a');
 });
 it('recognizes a pre-existing web copy through its mirror URL without creating another work',async()=>{
  const digest='a'.repeat(64),url='https://www.mangacopy.com/comic/mirror_reuse/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
  const old={...makeCopy('已有网页',[],'网页图片','web:'+url+':'+digest),sourceUrl:url};await commitCopies([old],[{title:'已有作品',kind:'chapter'}]);
  const mirror={...makeCopy('镜像网页',[],'网页图片','web:'+sourcePageIdentity(url)+':'+digest),sourceUrl:url.replace('www.mangacopy.com','www.copy4000.com')};
  expect(await commitCopies([mirror],[{title:'不能新建',kind:'chapter'}])).toMatchObject({created:0,copyIds:[old.id]});
 });
 it.each(['start','end','after'] as const)('inserts at %s with original identities, translations and reading anchor intact',async kind=>{
  const {copy,incoming,a,b}=await setup(),before=await readLibrary();
  const destination:Extract<WebDestination,{mode:'insert'}>={mode:'insert',copyId:copy.id,revision:1,position:kind==='after'?{kind,pageId:a.id}:{kind}};
  const result=await insertWebCopy(incoming,destination),saved=(await readCopies()).find(item=>item.id===copy.id)!;
  expect(result.added).toBe(2);expect(saved.pages.map(page=>page.name)).toEqual(kind==='start'?['新增1','新增2','原页1','原页2']:kind==='end'?['原页1','原页2','新增1','新增2']:['原页1','新增1','新增2','原页2']);
  expect(saved.pages.find(page=>page.id===b.id)).toEqual(b);expect(saved).toMatchObject({pageId:b.id,relativeOffset:.45,manifestRevision:2,knownTotal:4});
  const after=await readLibrary();expect(after.works.length).toBe(before.works.length);expect(after.coverage).toEqual(before.coverage);
  await saveCopy(copy);expect((await readCopies()).find(item=>item.id===copy.id)!.pages).toHaveLength(4);
 });
 it('serializes duplicate insertions across tabs and restores failed inserted bytes on retry',async()=>{
  const {copy,incoming}=await setup();const failed=structuredClone(incoming);failed.pages[0].blobKey=undefined;failed.pages[0].fetchError='HTTP 503';
  const destination:Extract<WebDestination,{mode:'insert'}>={mode:'insert',copyId:copy.id,revision:1,position:{kind:'end'}};
  const results=await Promise.all([insertWebCopy(failed,destination),insertWebCopy(failed,destination)]);expect(results.map(result=>result.added).sort()).toEqual([0,2]);
  const before=(await readCopies()).find(item=>item.id===copy.id)!;
  await insertWebCopy(incoming,destination);const after=(await readCopies()).find(item=>item.id===copy.id)!;
  expect(after.pages.map(page=>page.id)).toEqual(before.pages.map(page=>page.id));expect(after.pages[2].blobKey).toBe(incoming.pages[0].blobKey);expect(after.pages[2].fetchError).toBeUndefined();expect(after.manifestRevision).toBe(2);
 });
 it('rejects stale or missing insertion positions and active source acquisition without partial writes',async()=>{
  const {copy,incoming}=await setup();const destination:Extract<WebDestination,{mode:'insert'}>={mode:'insert',copyId:copy.id,revision:2,position:{kind:'end'}};
  await expect(insertWebCopy(incoming,destination)).rejects.toThrow('页序已改变');
  await expect(insertWebCopy(incoming,{...destination,revision:1,position:{kind:'after',pageId:'removed'}})).rejects.toThrow('位置已移除');
  await editLibrary(library=>library.tasks.push({id:crypto.randomUUID(),copyId:copy.id,status:'running',phase:'images',completed:0,updatedAt:0}));
  await expect(insertWebCopy(incoming,{...destination,revision:1})).rejects.toThrow('暂停');expect((await readCopies()).find(item=>item.id===copy.id)!.pages).toHaveLength(2);
 });
 it('marks manually extended source copies to preserve inserted slots on later download retries',async()=>{
  const {copy,incoming}=await setup();await editLibrary((_library,copies)=>{copies.find(item=>item.id===copy.id)!.sourceEntryId='source-entry';});
  await insertWebCopy(incoming,{mode:'insert',copyId:copy.id,revision:1,position:{kind:'end'}});
  expect((await readCopies()).find(item=>item.id===copy.id)).toMatchObject({sourcePagesEdited:true});
 });
});
