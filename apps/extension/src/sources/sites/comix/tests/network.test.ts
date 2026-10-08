import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {network} from '../network';
import {definition} from '../definition';
import {encodeRequest,decodeResponse} from '../protocol';
import {tileOrder,decodeImage} from '../images';
import {validateSourceCatalog,sourceFor} from '../../..';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {discoverEntry,discoverPage} from '../../../runtime/client';
import {PageImageRegistry} from '../../../core/resources';
import {catalog} from '../../../../comics/repositories';
import {importCatalog,importManifest} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {readWebsiteCatalog} from '../../../../comics/application/website-catalog';
import {withPageNetworkContext} from '../../../runtime/page-network';

// Parser/runtime routing coverage; real tab lifecycle is exercised by source-page-network.test.ts.
vi.mock('../../../runtime/page-network',async()=>{
 const {createSourceNetworkContext}=await import('../../../runtime/http');
 return {withPageNetworkContext:vi.fn(async(_url:string,signal:AbortSignal,read:any)=>read(createSourceNetworkContext(signal)))};
});

const url='https://comix.to/title/rrzm-sample';
const row=(id:number,number:number|string,official=false)=>({id,number,mangaId:2188,language:'en',isOfficial:official,group:{name:'Group'},name:'',url:`/title/rrzm-sample/${id}-chapter-${number}`});
function fixture(rows=[row(20,0),row(30,1),row(10,1,true),row(40,1.5)],mutate?:(data:any,page:number)=>void){
 const request=vi.fn(async(target:string)=>{
   const u=new URL(target);
   if(!u.pathname.startsWith('/api/'))throw Error('Catalog must not fetch or parse the HTML document');
   if(u.pathname==='/api/v1/manga/rrzm'){
     expect(u.searchParams.get('_')).toBe(encodeRequest('/manga/rrzm'));
     return JSON.stringify({status:'ok',result:{id:2188,hid:'rrzm',url:'/title/rrzm-sample',title:'Fixture'}});
   }
   if(u.pathname.includes('/chapters/'))return JSON.stringify({status:'ok',result:{id:20,mangaId:2188,number:0,url:'/title/rrzm-sample/20-chapter-0',pages:{baseUrl:'',items:[{url:'https://images.example/0.png',width:800,height:1200,s:1}]}}});
   const page=Number(u.searchParams.get('page')),items=rows.slice((page-1)*2,page*2),lastPage=Math.ceil(rows.length/2);
   expect(u.searchParams.get('_')).toBe(encodeRequest(`/manga/rrzm/chapters?limit=100&order[number]=asc&page=${page}`));
   const data={status:'ok',result:{items,meta:{total:rows.length,lastPage,page,hasNext:page<lastPage}}};mutate?.(data,page);return JSON.stringify(data);
 });return {request};
}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('Comix network adapter',()=>{
 it('explicitly selects page catalog/chapter transport and reads only APIs',async()=>{
   expect(network.pageTransport).toEqual(['catalog','pages']);
   const context=fixture();await network.catalog(url,context);
   expect(context.request.mock.calls.every(([target])=>new URL(target).pathname.startsWith('/api/v1/'))).toBe(true);
 });
 it.each(['identity','url'])('rejects mismatched detail %s before requesting chapters',async kind=>{
   const context=fixture(),request=vi.fn(async(target:string)=>{
     const body=await context.request(target);
     return kind==='identity'?body.replace('"hid":"rrzm"','"hid":"other"'):body.replace('/title/rrzm-sample','https://evil.test/title/rrzm-sample');
   });
   await expect(network.catalog(url,{request})).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 });
 it('preserves large valid page dimensions without a source pixel ceiling',async()=>{
   const context=fixture(),request=async(target:string)=>(await context.request(target)).replace('"width":800,"height":1200','"width":20001,"height":20001');
   expect((await network.pages(url+'/20-chapter-0',{request})).items[0]).toMatchObject({width:20001,height:20001});
 });
 it('reads the dedicated poster without treating it as a chapter image',async()=>{
   const context=fixture(),request=async(target:string)=>(await context.request(target)).replace('"title":"Fixture"','"title":"Fixture","poster":{"large":"https://static.comix.to/cover.jpg","medium":"https://static.comix.to/small.jpg"}');
   const source=validateSourceCatalog(await network.catalog(url,{request}));
   expect(source.cover).toEqual({url:'https://static.comix.to/cover.jpg'});
   expect(source.entries).toHaveLength(3);
   expect((await network.catalog(url,fixture())).cover).toBeUndefined();
 });
 it('removes xkcd imports and isolates supported Comix paths and identities',()=>{
   expect(sourceFor('https://xkcd.com/1/').definition.capabilities.importable).not.toBe(true);
   expect(definition.identify(new URL(url))?.catalog?.key).toBe('comix:rrzm');
   expect(definition.identify(new URL(url+'/20-chapter-0'))?.pageKey).toBe('comix:rrzm:chapter:0');
   expect(definition.identify(new URL('https://comix.to.evil.test/title/rrzm-sample'))).toBeNull();
   expect(definition.identify(new URL('http://comix.to/title/rrzm-sample'))?.kind).toBe('other');
 });
 it('collects every page, preserves decimal/zero chapters, prefers official and pins existing choices',async()=>{
   const context=fixture(),first=validateSourceCatalog(await network.catalog(url,context));
   expect(context.request).toHaveBeenCalledTimes(3);
   expect(first.entries.map(e=>e.remoteId)).toEqual(['20','10','40']);
   expect(first.entries.map(e=>e.chapterNumber)).toEqual(['0','1','1.5']);
   const next=await network.catalog(url,{...fixture([row(20,0),row(30,1),row(5,1,true),row(10,1,true),row(40,1.5),row(50,2)]),previous:first});
   expect(next.entries.map(e=>e.remoteId)).toEqual(['20','10','40','50']);
   const replacement=await network.catalog(url,{...fixture([row(20,0),row(30,1),row(40,1.5)]),previous:first});
   expect(replacement.entries[1].id).toBe(first.entries[1].id);expect(replacement.entries[1].remoteId).toBe('30');
 });
 it('retains native string chapter labels without rounding decimals or using display titles',async()=>{
   const rows=[row(20,'1.00'),row(30,'1.50'),row(40,2)];rows[2].name='Chapter 99';
   const value=validateSourceCatalog(await network.catalog(url,fixture(rows)));
   expect(value.entries.map(entry=>entry.chapterNumber)).toEqual(['1.00','1.50','2']);
   expect(value.externalIds).toBeUndefined();
 });
 it.each([null,true,false,'',' ','0x1','1e0','-1','1a','1.2.3',{},['1']])('rejects invalid native chapter evidence %s',async number=>{
   await expect(network.catalog(url,fixture(undefined,(data,page)=>{if(page===1)data.result.items[0].number=number;}))).rejects.toThrow();
 });
 it.each(['partial','repeat','foreign','changed-total','invalid-url'])('rejects %s instead of publishing a partial directory',async(mode)=>{
   const context=fixture(undefined,(d,page)=>{if(page!==2)return;if(mode==='partial')d.result.items.pop();if(mode==='repeat')d.result.items[0]=row(20,0);if(mode==='foreign')d.result.items[0].mangaId=999;if(mode==='changed-total')d.result.meta.total++;if(mode==='invalid-url')d.result.items[0].url='https://evil.test/title/rrzm/10-chapter-1';});
   await expect(network.catalog(url,context)).rejects.toThrow();
 });
 it('retains upload selection, reading positions and caches while notifying only new chapter numbers',async()=>{
   const first=await network.catalog(url,fixture()),comic=await importCatalog(first);
   const page=await network.pages(first.entries[0].url,fixture());
   const imported=await importManifest({...new PageImageRegistry().register(page,[]),id:'fixture',revision:1});
   const entry=(await catalog.get('entries',imported.id))!,pages=await catalog.listPages(entry.contentId);
   const position={id:entry.id,entryId:entry.id,comicId:comic.id,contentId:entry.contentId,pageId:pages[0].pageId,relativeOffset:.4,updatedAt:1};await catalog.savePosition(position);
   const next=await network.catalog(url,{...fixture([row(20,0),row(10,1,true),row(40,1.5),row(9,1,true),row(50,2)]),previous:first});
   await applyCatalogRefresh(comic.id,1,next);await applyCatalogRefresh(comic.id,1,next);
   expect((await catalog.get('comics',comic.id))?.catalogUpdates?.count).toBe(1);
   expect(await catalog.get('positions',entry.id)).toEqual(position);expect(await catalog.listPages(entry.contentId)).toEqual(pages);
 });
 it('routes catalogs and chapters through page transport and keeps HTTP image manifests durable',async()=>{
   const storage:Record<string,unknown>={},tabs={create:vi.fn(()=>{throw Error('must not create tab')})},context=fixture();
   vi.stubGlobal('chrome',{runtime:{id:'fixture'},permissions:{contains:vi.fn(async()=>true)},tabs,storage:{local:{get:async(k:string)=>({[k]:storage[k]}),set:async(v:object)=>Object.assign(storage,v)}}});
   vi.stubGlobal('fetch',vi.fn(async(target:string)=>new Response(await context.request(String(target)))));
   const source=await readSourceCatalog(url),progress=vi.fn(),signal=new AbortController().signal;
   expect(withPageNetworkContext).toHaveBeenCalledOnce();
   const manifest=await discoverEntry(source,source.entries[0].id,signal,progress);
   expect(withPageNetworkContext).toHaveBeenCalledTimes(2);
   expect(manifest.items[0].processing).toBe('tiles-v1');expect(storage['manifest:'+manifest.id]).toEqual(manifest);
   expect(manifest.pageContext).toBeUndefined();expect(storage['nc-source:'+source.id]).toBeUndefined();
   await discoverPage(source.entries[0].url,signal,progress);expect(tabs.create).not.toHaveBeenCalled();
   const controller=new AbortController();controller.abort();await expect(discoverPage(source.entries[0].url,controller.signal,progress)).rejects.toThrow();
 });
 it('a rejected refresh cannot replace the library upload choice used by the next read',async()=>{
   const first=await network.catalog(url,fixture()),comic=await importCatalog(first);
   vi.stubGlobal('chrome',{runtime:{id:'fixture'},permissions:{contains:vi.fn(async()=>true)}});
   let context=fixture([row(20,0),row(5,1,true),row(40,1.5)]);
   vi.stubGlobal('fetch',vi.fn(async(target:string)=>new Response(await context.request(String(target)))));
   const rejected=await readWebsiteCatalog(url);expect(rejected.entries[1].remoteId).toBe('5');
   await applyCatalogRefresh(comic.id,comic.source.generation+1,rejected);
   context=fixture([row(20,0),row(5,1,true),row(10,1,true),row(40,1.5)]);
   const next=await readWebsiteCatalog(url);expect(next.entries[1].remoteId).toBe('10');
   expect((await catalog.get('catalogs',first.id))?.entries).toEqual(first.entries);
 });
 it('implements the observed signature codec and tile shuffle, rejecting changed image protocols',async()=>{
   expect(decodeResponse(encodeRequest('sample 请求'))).toBe('sample 请求');
   expect(tileOrder(239595250,25)).toEqual([21,8,16,13,1,12,3,10,5,6,23,2,20,14,7,0,18,9,15,19,24,22,11,17,4]);
   await expect(decodeImage(new Blob(),new Headers(),'tiles-v1')).rejects.toThrow('协议已变化');
 });
});
