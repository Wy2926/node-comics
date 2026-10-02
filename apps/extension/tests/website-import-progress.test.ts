import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceCatalogSnapshot,SourceEntry} from '../src/sources';
import type {Comic,Entry} from '../src/comics/domain';
const fixture=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../src/comics/application/website-catalog',()=>({readWebsiteCatalog:fixture.read}));
import {catalog} from '../src/comics/repositories';
import {importCatalog,importManifest} from '../src/comics/application/import-service';
import {importWebsiteLink,resumeWebsiteCatalog} from '../src/comics/application/website-import';
import {comicDirectory,continueEntry} from '../src/comics/application/library-service';
import {syncNextCatalog} from '../src/comics/application/catalog-sync';

function snapshot():SourceCatalogSnapshot {
  const slug='progress-'+crypto.randomUUID(),id='mangacopy:'+slug,url='https://mangacopy.com/comic/'+slug;
  const entries:SourceEntry[]=[0,1,2].map(order=>{
    const remoteId=crypto.randomUUID();
    return {id:id+':'+remoteId,catalogId:id,remoteId,url:url+'/chapter/'+remoteId,title:'Chapter '+order,order,
      groupIds:['chapters'],rawTypes:[],related:false,sequenceId:'main',contentLanguage:'en'};
  });
  return {id,sourceId:'mangacopy',url,title:'Progress fixture',complete:true,observedAt:Date.now()+10,note:'',entries,
    groups:[{id:'chapters',title:'Chapters',entryIds:entries.map(entry=>entry.id),complete:true}],defaultEntryId:entries[0].id};
}
function partial(source:SourceCatalogSnapshot,length=1):SourceCatalogSnapshot {
  const entries=source.entries.slice(0,length);
  return {...source,observedAt:source.observedAt-1,complete:false,note:'Loading directory',entries,
    groups:[{...source.groups[0],complete:false,entryIds:entries.map(entry=>entry.id)}]};
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
beforeEach(()=>{
  fixture.read.mockReset();
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{contains:vi.fn(async()=>true)}});
});
afterEach(async()=>{
  vi.unstubAllGlobals();vi.restoreAllMocks();
  for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);
});

describe('progressive website directory import',()=>{
  it('opens a saved partial directory before completion and preserves content and position when it completes',async()=>{
    const source=snapshot(),finish=deferred<SourceCatalogSnapshot>(),seen=deferred<void>(),onReady=vi.fn((_result:{comic:Comic;entry:Entry})=>{seen.resolve();});
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source));return finish.promise;
    });
    let complete=false;
    const importing=importWebsiteLink(source.url,{onReady}).then(comic=>{complete=true;return comic;});
    await seen.promise;
    expect(complete).toBe(false);expect(onReady).toHaveBeenCalledOnce();
    const {comic,entry}=onReady.mock.calls[0][0];
    expect(await comicDirectory(comic.id,entry.id)).toMatchObject({complete:false});
    expect((await catalog.get('comics',comic.id))?.catalogSync?.lastSuccessAt).toBeUndefined();
    const backgroundRead=vi.fn();
    expect(await syncNextCatalog(backgroundRead)).toBe(false);expect(backgroundRead).not.toHaveBeenCalled();
    await importManifest({id:'progress-manifest',revision:1,title:'Chapter zero',url:source.entries[0].url,adapter:source.sourceId,
      direction:'rtl',discoveryComplete:true,knownTotal:1,note:'',items:[{id:'page-1',url:'https://images.example/progress.png',width:800,height:1200,order:0}]});
    const [page]=await catalog.listPages(entry.contentId);
    const position={id:entry.id,entryId:entry.id,comicId:comic.id,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.4,updatedAt:Date.now()};
    await catalog.savePosition(position);
    finish.resolve(source);
    expect((await importing).id).toBe(comic.id);expect(onReady).toHaveBeenCalledOnce();
    expect(await catalog.listEntries(comic.id)).toHaveLength(3);
    expect(await catalog.get('entries',entry.id)).toMatchObject({contentId:entry.contentId,indexState:'ready'});
    expect(await catalog.get('positions',entry.id)).toEqual(position);
    expect(await comicDirectory(comic.id,entry.id)).toMatchObject({complete:true});
    expect((await catalog.get('comics',comic.id))?.catalogUpdates).toBeUndefined();
  });

  it('retains usable partial entries after rate limiting and resumes the same book without restarting reading',async()=>{
    const source=snapshot(),onReady=vi.fn();
    fixture.read.mockImplementationOnce(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source,2));throw Error('HTTP 429');
    });
    await expect(importWebsiteLink(source.url,{onReady})).rejects.toThrow('429');
    const [comic]=await catalog.list('comics');
    const original=await continueEntry(comic.id);
    expect(original).toBeDefined();expect(await comicDirectory(comic.id)).toMatchObject({complete:false});
    // A retry's shorter first page must not shrink the accepted directory.
    fixture.read.mockImplementationOnce(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress({...partial(source),observedAt:source.observedAt});
      expect((await catalog.get('catalogs',source.id))?.entries).toHaveLength(2);
      return {...source,observedAt:source.observedAt+1};
    });
    const resumed=await resumeWebsiteCatalog(comic.id);
    expect(resumed.id).toBe(comic.id);expect(await catalog.list('comics')).toHaveLength(1);
    expect((await continueEntry(comic.id))?.id).toBe(original?.id);expect(onReady).toHaveBeenCalledOnce();
    expect(await comicDirectory(comic.id)).toMatchObject({complete:true});
  });

  it('never recreates a removed book when a later complete batch arrives',async()=>{
    const source=snapshot(),finish=deferred<SourceCatalogSnapshot>(),seen=deferred<void>();
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source));return finish.promise;
    });
    const importing=importWebsiteLink(source.url,{onReady:()=>seen.resolve()});
    const rejected=expect(importing).rejects.toThrow('已移除');
    await seen.promise;
    const [comic]=await catalog.list('comics');await catalog.deleteComic(comic.id);
    finish.resolve(source);await rejected;
    expect(await catalog.list('comics')).toEqual([]);
    expect(await catalog.get('catalogs',source.id)).toBeUndefined();
  });

  it('binds an existing book before reading so deletion before the first batch cannot recreate it',async()=>{
    const source=snapshot(),comic=await importCatalog(source),finish=deferred<SourceCatalogSnapshot>(),started=deferred<void>();
    fixture.read.mockImplementation(async()=>{started.resolve();return finish.promise;});
    const importing=importWebsiteLink(source.url),rejected=expect(importing).rejects.toThrow('已移除');
    await started.promise;await catalog.deleteComic(comic.id);finish.resolve({...source,observedAt:source.observedAt+1});await rejected;
    expect(await catalog.list('comics')).toEqual([]);expect(await catalog.get('catalogs',source.id)).toBeUndefined();
  });

  it('rejects the final batch when the accepted book has changed its source generation',async()=>{
    const source=snapshot(),finish=deferred<SourceCatalogSnapshot>(),seen=deferred<void>();
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source));return finish.promise;
    });
    const importing=importWebsiteLink(source.url,{onReady:()=>seen.resolve()}),rejected=expect(importing).rejects.toThrow('已断开');
    await seen.promise;
    const [comic]=await catalog.list('comics');await catalog.patch('comics',comic.id,{source:{...comic.source,generation:comic.source.generation+1}});
    finish.resolve(source);await rejected;
    expect(await catalog.listEntries(comic.id)).toHaveLength(1);expect(await comicDirectory(comic.id)).toMatchObject({complete:false});
  });

  it('keeps an existing complete snapshot while another import reports a partial observation',async()=>{
    const source=snapshot(),comic=await importCatalog(source),onReady=vi.fn();
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress({...partial(source),observedAt:source.observedAt+1});
      expect((await catalog.get('catalogs',source.id))?.complete).toBe(true);
      expect(await catalog.listEntries(comic.id)).toHaveLength(3);
      return {...source,observedAt:source.observedAt+2};
    });
    expect((await importWebsiteLink(source.url,{onReady})).id).toBe(comic.id);
    expect(onReady).toHaveBeenCalledOnce();expect(await catalog.list('comics')).toHaveLength(1);
  });

  it('waits for the explicit requested chapter instead of opening a different partial chapter',async()=>{
    const source=snapshot(),finish=deferred<SourceCatalogSnapshot>(),observed=deferred<void>(),onReady=vi.fn();
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source));observed.resolve();return finish.promise;
    });
    const importing=importWebsiteLink(source.entries[2].url,{onReady});
    await observed.promise;
    expect(onReady).not.toHaveBeenCalled();expect(await catalog.list('comics')).toEqual([]);
    finish.resolve(source);const comic=await importing;
    expect(onReady).toHaveBeenCalledOnce();expect((await continueEntry(comic.id))?.sourceEntryId).toBe(source.entries[2].id);
  });

  it('cancels after the early opening without accepting a late final directory',async()=>{
    const source=snapshot(),controller=new AbortController(),finish=deferred<SourceCatalogSnapshot>(),seen=deferred<void>();
    fixture.read.mockImplementation(async(_url:string,_signal:AbortSignal|undefined,options:{onCatalogProgress:(source:SourceCatalogSnapshot)=>Promise<void>})=>{
      await options.onCatalogProgress(partial(source));seen.resolve();return finish.promise;
    });
    const importing=importWebsiteLink(source.url,{signal:controller.signal,onReady:vi.fn()});
    const rejected=expect(importing).rejects.toThrow();
    await seen.promise;controller.abort();finish.resolve(source);await rejected;
    const [comic]=await catalog.list('comics');
    expect(await catalog.listEntries(comic.id)).toHaveLength(1);expect(await comicDirectory(comic.id)).toMatchObject({complete:false});
  });
});
