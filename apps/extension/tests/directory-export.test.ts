import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BlobReader,TextWriter,ZipReader} from '@zip.js/zip.js/index-native.js';
import {seedComic} from './comic-fixture';
import {catalog} from '../src/comics/repositories';
import type {Entry} from '../src/comics/domain';
import {exportDirectoryInfo,exportDocument} from '../src/comics/application/export-service';
import {planDirectoryExport} from '../src/comics/application/export-directory';
import {exportManifest,type ExportOptions} from '../src/export/plan';
import {setSourceLanguagePreference} from '../src/comics/application/reading-preferences';
import {prepareEntryContent} from '../src/comics/application/entry-content';
import {readWebsiteCatalog} from '../src/comics/application/website-catalog';
import {acquirePage} from '../src/comics/pages/service';
import {MAX_EXPORT_BYTES} from '../src/export/plan';

vi.mock('../src/comics/application/entry-content',()=>({prepareEntryContent:vi.fn(async()=>{})}));
vi.mock('../src/comics/application/website-catalog',()=>({readWebsiteCatalog:vi.fn()}));
vi.mock('../src/comics/pages/service',()=>({acquirePage:vi.fn(),materializationId:(ref:{contentId:string;pageId:string;renderProfileId:string})=>JSON.stringify([ref.contentId,ref.pageId,ref.renderProfileId])}));
const options:ExportOptions={format:'cbz',images:'original',mode:'classic',language:'zh-Hans',range:'directory'};
const image=()=>new Blob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4])],{type:'image/png'});
const identity={id:'image',pageId:'page',contentId:'content',renderProfileId:'original',imageSha256:'a'.repeat(64),width:100,height:100,byteSize:12,mime:'image/png',updatedAt:1};
const context=()=>({signal:new AbortController().signal,assertCurrent:async()=>{}});
const releases:ReturnType<typeof vi.fn>[]=[];
beforeEach(()=>{
  vi.clearAllMocks();releases.length=0;
  vi.mocked(prepareEntryContent).mockImplementation(async()=>{});
  vi.mocked(acquirePage).mockImplementation(async()=>{
    const release=vi.fn();releases.push(release);
    return {blob:image(),identity,release};
  });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function book() {
  const {comic,entry}=await seedComic({format:'image-sequence',title:'第一话',sequenceId:'main',readingSlotId:'1',contentLanguage:'en',discoveryComplete:true,pageCount:2});
  await catalog.patch('comics',comic.id,{title:'完整漫画',lastEntryId:entry.id,lastReadAt:123,lastPage:2,lastPageCount:2});
  const entries:Entry[]=[entry,...[1,2].map(order=>({...entry,id:crypto.randomUUID(),contentId:crypto.randomUUID(),title:order===1?'../第二:话':'第三话',order,readingSlotId:String(order+1)}))];
  const alternate:Entry={...entries[1],id:crypto.randomUUID(),contentId:crypto.randomUUID(),title:'第二话中文',contentLanguage:'zh-Hans',sourceOrder:9};
  for(const item of [...entries,alternate]) {
    await catalog.put('entries',item);
    await catalog.putPages(item.id,item.contentId,[0,1].map(ordinal=>({contentId:item.contentId,pageId:`page-${ordinal}`,ordinal,name:`${ordinal}.png`,formatLocator:String(ordinal),locator:{url:'https://private.example/?token=secret'}})),1);
  }
  return {comic,entries,alternate};
}

describe('whole chapter directory export',()=>{
  it('previews metadata only and chooses one release per reading slot without changing progress',async()=>{
    const {comic,entries,alternate}=await book();
    await setSourceLanguagePreference(comic.id,'zh-Hans');
    const saved=await catalog.get('comics',comic.id),preferences=await catalog.get('metadata','reading-preferences:'+comic.id);
    const directory=await exportDirectoryInfo(entries[0].id,'en');
    expect(directory.chapters.map(chapter=>chapter.selectedEntryId)).toEqual([entries[0].id,alternate.id,entries[2].id]);
    expect(prepareEntryContent).not.toHaveBeenCalled();expect(acquirePage).not.toHaveBeenCalled();
    const plan=await planDirectoryExport(entries[0].id,{...options,language:'en'},context());
    expect(plan.chapters?.map(chapter=>chapter.entryId)).toEqual([entries[0].id,alternate.id,entries[2].id]);
    expect(plan.pages.map(page=>page.ordinal)).toEqual([0,1,2,3,4,5]);
    expect(acquirePage).not.toHaveBeenCalled();
    expect(await catalog.get('comics',comic.id)).toEqual(saved);
    expect(await catalog.get('metadata','reading-preferences:'+comic.id)).toEqual(preferences);
    const manifest=JSON.stringify(exportManifest(plan));
    for(const secret of ['private.example','secret','token','sourceUrl','contentId','connectionId'])expect(manifest).not.toContain(secret);
    expect(JSON.parse(manifest)).toMatchObject({schema:'node-comics-export/3',complete:true,expectedPages:6,chapters:[{firstPage:1,pageCount:2},{firstPage:3,pageCount:2},{firstPage:5,pageCount:2}]});
  });

  it('discovers pending chapters serially and writes ordered chapter folders with one live image',async()=>{
    const {entries}=await book();await catalog.patch('entries',entries[1].id,{indexState:'pending',discoveryComplete:false});
    let active=0,maximum=0;
    vi.mocked(prepareEntryContent).mockImplementation(async id=>{
      active++;maximum=Math.max(maximum,active);await Promise.resolve();
      await catalog.patch('entries',id,{indexState:'ready',discoveryComplete:true});active--;
    });
    vi.mocked(acquirePage).mockImplementation(async()=>{
      expect(releases.every(release=>release.mock.calls.length===1)).toBe(true);
      const release=vi.fn();releases.push(release);
      return {blob:image(),identity,release};
    });
    const result=await exportDocument(entries[0].id,{...options,language:'en'},context());
    expect(result.name).toBe('完整漫画-章节目录-原图.cbz');expect(maximum).toBe(1);expect(releases).toHaveLength(6);
    expect(releases.every(release=>release.mock.calls.length===1)).toBe(true);
    const reader=new ZipReader(new BlobReader(result.blob!));
    try {
      const files=await reader.getEntries();
      expect(files.map(file=>file.filename)).toEqual(['0001-第一话/00001.png','0001-第一话/00002.png','0002-_第二_话/00001.png','0002-_第二_话/00002.png','0003-第三话/00001.png','0003-第三话/00002.png','export-manifest.json']);
      const manifest=files.at(-1)!;if(manifest.directory)throw Error('manifest directory');
      expect(JSON.parse(await manifest.getData(new TextWriter())).pages).toHaveLength(6);
    }finally{await reader.close();}
  });

  it('never labels an incomplete catalog or chapter as a full export, even with partial opt-in',async()=>{
    const {comic,entries}=await book();
    await catalog.put('catalogs',{id:crypto.randomUUID(),comicId:comic.id,complete:false,entries:[],groups:[]});
    await expect(exportDocument(entries[0].id,{...options,allowIncomplete:true},context())).rejects.toThrow('章节目录尚未完整加载');
    expect(acquirePage).not.toHaveBeenCalled();
    const second=await book();await catalog.patch('entries',second.entries[2].id,{discoveryComplete:false});
    await expect(exportDocument(second.entries[0].id,{...options,allowIncomplete:true},context())).rejects.toThrow('第三话');
    expect(acquirePage).not.toHaveBeenCalled();
  });

  it('attempts to complete a partial catalog only after export is requested',async()=>{
    const {comic,entries}=await book();await catalog.patch('comics',comic.id,{sourceUrl:'https://source.example/book'});
    await catalog.put('catalogs',{id:crypto.randomUUID(),comicId:comic.id,complete:true,entries:[],groups:[{id:'g',entryIds:[],complete:false}]});
    expect((await exportDirectoryInfo(entries[0].id,'en')).complete).toBe(false);expect(readWebsiteCatalog).not.toHaveBeenCalled();
    vi.mocked(readWebsiteCatalog).mockResolvedValue({complete:false,groups:[]} as unknown as Awaited<ReturnType<typeof readWebsiteCatalog>>);
    await expect(exportDocument(entries[0].id,options,context())).rejects.toThrow('章节目录尚未完整加载');
    expect(readWebsiteCatalog).toHaveBeenCalledOnce();expect(acquirePage).not.toHaveBeenCalled();
  });

  it('uses the completed source catalog, including newly discovered chapters, without changing recency',async()=>{
    const {comic,entries}=await book(),sourceId='mangapill',catalogId=crypto.randomUUID();
    const connection={id:'website:'+sourceId,provider:'local',displayName:'Fixture',status:'connected' as const,generation:1,createdAt:1,updatedAt:1};
    await catalog.put('connections',connection);
    await catalog.patch('comics',comic.id,{source:{...comic.source,connectionId:connection.id,providerItemId:catalogId,locator:{catalogId}},sourceUrl:'https://mangapill.com/manga/1/fixture'});
    for(const [index,entry] of entries.entries())await catalog.patch('entries',entry.id,{sourceEntryId:'source-'+index});
    const rows=[0,1,2,3].map(order=>({id:'source-'+order,catalogId,remoteId:String(order),url:'https://mangapill.com/chapters/'+order,title:'Chapter '+order,order,groupIds:['main'],rawTypes:[],related:false,sequenceId:'main',readingSlotId:String(order+1),contentLanguage:'en'}));
    const source={id:catalogId,sourceId,url:'https://mangapill.com/manga/1/fixture',title:'Complete',observedAt:2,note:'',complete:true,groups:[{id:'main',title:'Main',complete:true,entryIds:rows.map(row=>row.id)}],entries:rows};
    await catalog.put('catalogs',{...source,comicId:comic.id,complete:false,observedAt:1,entries:rows.slice(0,3)});
    vi.mocked(readWebsiteCatalog).mockResolvedValue(source);
    vi.mocked(prepareEntryContent).mockImplementation(async id=>{
      const entry=(await catalog.get('entries',id))!;if(entry.indexState==='ready')return;
      await catalog.putPages(id,entry.contentId,[{contentId:entry.contentId,pageId:'new-page',ordinal:0,name:'new.png',formatLocator:'0',locator:{}}],1);
      await catalog.patch('entries',id,{indexState:'ready',discoveryComplete:true,pageCount:1});
    });
    const plan=await planDirectoryExport(entries[0].id,{...options,language:'en'},context());
    expect(plan.chapters?.map(chapter=>chapter.title)).toEqual(['Chapter 0','Chapter 1','Chapter 2','Chapter 3']);
    expect(plan.pages).toHaveLength(7);expect(plan.incomplete).toBe(false);expect(readWebsiteCatalog).toHaveBeenCalledOnce();
    expect(await catalog.get('comics',comic.id)).toMatchObject({lastEntryId:entries[0].id,lastReadAt:123,lastPage:2});
  });

  it('names unavailable chapters instead of silently skipping them and aborts the destination',async()=>{
    const {entries}=await book();await catalog.patch('entries',entries[2].id,{readable:false});
    const abort=vi.fn(),close=vi.fn();const destination=new WritableStream<Uint8Array>({abort,close});
    await expect(exportDocument(entries[0].id,options,{...context(),destination})).rejects.toThrow('第三话');
    expect(abort).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();expect(acquirePage).not.toHaveBeenCalled();
  });

  it('cancels discovery before later chapters or image reads',async()=>{
    const {entries}=await book(),controller=new AbortController(),abort=vi.fn();
    vi.mocked(prepareEntryContent).mockImplementation(async()=>{controller.abort();});
    await expect(exportDocument(entries[0].id,options,{signal:controller.signal,destination:new WritableStream({abort})})).rejects.toMatchObject({name:'AbortError'});
    expect(prepareEntryContent).toHaveBeenCalledOnce();expect(acquirePage).not.toHaveBeenCalled();expect(abort).toHaveBeenCalledOnce();
  });

  it('rejects identity changes in an earlier chapter before finalizing the file',async()=>{
    const {entries}=await book(),abort=vi.fn(),close=vi.fn();
    const acquire=vi.mocked(acquirePage).getMockImplementation()!;
    vi.mocked(acquirePage).mockImplementation(async request=>{
      if(request.entryId===entries[2].id)await catalog.patch('entries',entries[1].id,{generation:2});
      return acquire(request);
    });
    await expect(exportDocument(entries[0].id,{...options,language:'en'},{...context(),destination:new WritableStream({abort,close})})).rejects.toThrow('来源内容已变化');
    expect(abort).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();expect(releases.every(release=>release.mock.calls.length===1)).toBe(true);
  });

  it('stops if the translation channel or source authorization changes',async()=>{
    const {entries}=await book();let current=true;
    vi.mocked(prepareEntryContent).mockImplementation(async()=>{current=false;});
    await expect(exportDocument(entries[0].id,{...options,images:'translation'},{...context(),scope:{key:'account-a'},isCurrent:()=>current})).rejects.toThrow('翻译渠道已切换');
    expect(acquirePage).not.toHaveBeenCalled();
    vi.mocked(prepareEntryContent).mockImplementation(async()=>{await catalog.patch('connections','local',{status:'disconnected'});});
    await expect(exportDocument(entries[0].id,options,context())).rejects.toMatchObject({name:'AbortError'});
  });

  it('keeps translation fallbacks explicit per chapter without submitting new jobs',async()=>{
    const {entries}=await book();
    const plan=await planDirectoryExport(entries[0].id,{...options,images:'translation'},{...context(),scope:{key:'account-a'}});
    expect(plan.pages).toHaveLength(6);expect(plan.pages.every(page=>page.kind==='fallback')).toBe(true);
    expect(acquirePage).not.toHaveBeenCalled();
  });

  it('enforces the existing buffer ceiling across chapters rather than per chapter',async()=>{
    const {entries}=await book(),release=vi.fn();let reads=0;
    vi.mocked(acquirePage).mockImplementation(async()=>{
      reads++;const blob=image();Object.defineProperty(blob,'size',{value:MAX_EXPORT_BYTES/3});
      return {blob,identity,release};
    });
    await expect(exportDocument(entries[0].id,options,context())).rejects.toThrow('128 MiB');
    expect(reads).toBe(4);expect(release).toHaveBeenCalledTimes(4);
  });

  it('bounds total metadata pages across chapters before acquiring any image',async()=>{
    const {entries,alternate}=await book();
    for(const entry of [...entries,alternate])await catalog.patch('entries',entry.id,{pageCount:5001});
    vi.spyOn(catalog,'listPages').mockImplementation(async(contentId,{offset=0,limit=100}={})=>
      Array.from({length:Math.max(0,Math.min(limit,5001-offset))},(_,index)=>({contentId,pageId:'page-'+(offset+index),ordinal:offset+index,name:'page.png',formatLocator:String(offset+index),locator:{}})));
    await expect(exportDocument(entries[0].id,options,context())).rejects.toThrow('10000');
    expect(prepareEntryContent).toHaveBeenCalledTimes(2);expect(acquirePage).not.toHaveBeenCalled();
  });
});
