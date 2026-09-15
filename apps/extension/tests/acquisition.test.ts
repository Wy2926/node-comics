import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AcquisitionCoordinator,grantImagePermissions,pauseCopies,queueCopies} from '../src/library/acquisition';
import {acquisitionCopies} from '../src/library/acquisition-order';
import {emptyLibrary,makeCopy} from '../src/library/model';
import {commitCopies,editLibrary,readCopies,readLibrary} from '../src/library/store';
import type {SourceCatalog} from '../src/library/types';
import {discoverEntry} from '../src/sources/client';
import {sourceImage} from '../src/sources/image-fetch';
import {prepareImageOrigins} from '../src/sources/permissions';

vi.mock('../src/sources/client',()=>({inExtension:()=>true,discoverEntry:vi.fn()}));
vi.mock('../src/sources/image-fetch',()=>({sourceImage:vi.fn()}));
beforeEach(async()=>{
 vi.clearAllMocks();
 vi.stubGlobal('localStorage',{getItem:()=>null});
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true}});
 vi.stubGlobal('createImageBitmap',async()=>({width:800,height:1200,close(){}}));
 let held=false;
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_options:unknown,run:(lock:object|null)=>Promise<void>)=>{
  if(held)return run(null);held=true;try{return await run({});}finally{held=false;}
 }}});
 await editLibrary((s,copies)=>{Object.assign(s,emptyLibrary());copies.length=0;});
 vi.mocked(discoverEntry).mockImplementation(async(catalog,id)=>({id:'manifest',sourceTabId:1,navigationId:'nav',revision:1,title:id,url:catalog.entries.find(e=>e.id===id)!.url,adapter:'mangacopy',direction:'rtl',discoveryComplete:true,knownTotal:2,note:'complete',items:[0,1].map(n=>({id:'slot-'+n,order:n,width:800,height:1200,url:`https://images.example/${id}/${n}`}))}));
 vi.mocked(sourceImage).mockImplementation(async url=>new Blob([url],{type:'image/png'}));
});
afterEach(()=>vi.unstubAllGlobals());

async function setup(){
 const entries=['chapter-1','chapter-2','extra','volume-1'].map((id,n)=>({id,catalogId:'catalog',remoteId:id,title:id,url:'https://example.test/'+id,groupIds:[n<3?'main':'books'],rawTypes:[],order:n<3?n:0,related:false}));
 const catalog:SourceCatalog={id:'catalog',sourceId:'mangacopy',url:'https://example.test',title:'sample',observedAt:1,complete:true,note:'',groups:[{id:'main',title:'默认',entryIds:entries.slice(0,3).map(e=>e.id),complete:true},{id:'books',title:'单行本',entryIds:['volume-1'],complete:true}],entries:[...entries].reverse(),excludedEntryIds:[]};
 const copies=entries.map(e=>({...makeCopy(e.title,[],'source',e.id),sourceEntryId:e.id,sourceUrl:e.url,discoveryComplete:false}));
 await commitCopies(copies,copies.map(()=>({title:'sample',kind:'chapter'})),catalog);return copies;
}

describe('ordered acquisition and recovery',()=>{
 it('orders separate clicks, duplicate triggers and display updates by catalog/group position',async()=>{
  const copies=await setup();
  for(const n of [3,1,2,0,1])await queueCopies([copies[n].id]);
  const state=await readLibrary();expect(state.tasks.map(t=>t.copyId)).toEqual(copies.map(c=>c.id));
  expect(acquisitionCopies(state,[...copies].reverse().map((c,n)=>({...c,updatedAt:9999+n}))).map(c=>c.id)).toEqual(copies.map(c=>c.id));
 });
 it('claims an old shuffled queue in source order and saves each image before requesting the next',async()=>{
  const copies=await setup();await queueCopies(copies.map(c=>c.id));
  await editLibrary(s=>{s.tasks.reverse();});
  const savedBefore:number[]=[];
  vi.mocked(sourceImage).mockImplementation(async url=>{savedBefore.push((await readCopies()).reduce((sum,c)=>sum+c.pages.filter(p=>p.blobKey).length,0));return new Blob([url]);});
  await Promise.all([new AcquisitionCoordinator().run(100),new AcquisitionCoordinator().run(100)]);
  expect(vi.mocked(discoverEntry).mock.calls.map(call=>call[1])).toEqual(copies.map(c=>c.sourceEntryId));
  expect(vi.mocked(sourceImage).mock.calls.map(call=>call[0])).toEqual(copies.flatMap(c=>[0,1].map(n=>`https://images.example/${c.sourceEntryId}/${n}`)));
  expect(savedBefore).toEqual([0,1,2,3,4,5,6,7]);
  expect((await readLibrary()).tasks.every(t=>t.status==='complete')).toBe(true);
 });
 it('skips paused entries, continues after a failed chapter and resumes without refetching saved pages',async()=>{
  const copies=await setup();await queueCopies(copies.slice(0,3).map(c=>c.id));await pauseCopies([copies[1].id]);
  vi.mocked(sourceImage).mockRejectedValueOnce(Error('原图暂不可用'));
  await new AcquisitionCoordinator().run(100);
  expect(vi.mocked(discoverEntry).mock.calls.map(call=>call[1])).toEqual(['chapter-1','extra']);
  expect((await readLibrary()).tasks.map(t=>t.status)).toEqual(['failed','paused','complete']);
  vi.mocked(sourceImage).mockClear();
  await queueCopies([copies[1].id,copies[0].id]);await new AcquisitionCoordinator().run(100);
  expect(vi.mocked(sourceImage).mock.calls.map(call=>call[0])).toEqual(['https://images.example/chapter-1/0','https://images.example/chapter-2/0','https://images.example/chapter-2/1']);
 });
 it('keeps a running chapter intact when an earlier chapter is added and pauses stale running tasks on restart',async()=>{
  const copies=await setup();await queueCopies([copies[2].id]);
  await editLibrary(s=>{s.tasks[0].status='running';s.tasks[0].completed=1;});
  await queueCopies([copies[0].id,copies[2].id]);
  expect((await readLibrary()).tasks.find(t=>t.copyId===copies[2].id)).toMatchObject({status:'running',completed:1});
  await new AcquisitionCoordinator().run(100);
  expect((await readLibrary()).tasks.find(t=>t.copyId===copies[2].id)?.status).toBe('paused');
  expect(vi.mocked(discoverEntry).mock.calls.map(call=>call[1])).toEqual(['chapter-1']);
 });
 it('downloads the first discovered page while the rest of the manifest is still pending',async()=>{
  const copies=await setup();await queueCopies([copies[0].id]);
  const original=vi.mocked(discoverEntry).getMockImplementation()!;
  let release!:()=>void;const firstDownloaded=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(sourceImage).mockImplementation(async url=>{release();return new Blob([url]);});
  vi.mocked(discoverEntry).mockImplementation(async(...args)=>{
   const full=await original(...args);
   await args[3]({...full,discoveryComplete:false,items:full.items.slice(0,1)});
   await firstDownloaded;
   expect((await readCopies()).find(c=>c.id===copies[0].id)?.discoveryComplete).toBe(false);
   return full;
  });
  await new AcquisitionCoordinator().run(100);
  expect(vi.mocked(sourceImage).mock.calls.map(call=>call[0])).toEqual(['https://images.example/chapter-1/0','https://images.example/chapter-1/1']);
  expect((await readLibrary()).tasks[0].status).toBe('complete');
 });
 it('prepares exact CDN origins and requests them from the click before a task is queued',async()=>{
  const copies=await setup(),catalog=(await readLibrary()).catalogs[0];
  const origins=await prepareImageOrigins(catalog,'chapter-1',new AbortController().signal);
  expect(origins).toEqual(['https://images.example/*']);
  expect(vi.mocked(discoverEntry).mock.calls[0][5]).toBe(true);expect(sourceImage).not.toHaveBeenCalled();
  const request=vi.fn(async()=>true);vi.stubGlobal('chrome',{permissions:{request}});
  const grant=grantImagePermissions([copies[0].id],copies,origins);
  expect(request).toHaveBeenCalledWith({origins:['https://example.test/*','https://images.example/*']});
  await grant;expect((await readLibrary()).tasks[0].status).toBe('queued');
 });
 it('does not queue on permission denial or mark an unexpected CDN as a failed first chapter',async()=>{
  const copies=await setup();vi.stubGlobal('chrome',{permissions:{contains:async()=>false,request:async()=>false}});
  await expect(grantImagePermissions([copies[0].id],copies,['https://images.example/*'])).rejects.toThrow('未获授权');
  expect((await readLibrary()).tasks).toHaveLength(0);
  await queueCopies([copies[0].id]);await new AcquisitionCoordinator().run(100);
  expect((await readLibrary()).tasks[0]).toMatchObject({status:'paused',error:expect.stringContaining('授权图片域名')});
  expect((await readCopies()).find(c=>c.id===copies[0].id)?.pages).toHaveLength(2);
  expect(sourceImage).not.toHaveBeenCalled();
 });
});
