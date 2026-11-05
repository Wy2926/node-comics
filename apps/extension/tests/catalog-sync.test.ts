import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importCatalog, importManifest} from '../src/comics/application/import-service';
import {acknowledgeCatalogUpdates, applyCatalogRefresh, catalogSyncPolicy} from '../src/comics/application/catalog-service';
import {checkCatalogUpdates} from '../src/comics/application/catalog-sync';
import {comicDirectory, continueEntry, loadEntry, readerSequence} from '../src/comics/application/library-service';
import type {SourceCatalogSnapshot} from '../src/sources';

function snapshot():SourceCatalogSnapshot {
  const slug='sync-'+crypto.randomUUID(),id='mangacopy:'+slug;
  const value:SourceCatalogSnapshot={id,sourceId:'mangacopy',url:'https://www.copy4000.com/comic/'+slug,title:'自动更新验收',observedAt:Date.now(),complete:true,note:'',groups:[{id:'default',title:'默认',entryIds:[],complete:true}],entries:[]};
  return append(value);
}
function append(value:SourceCatalogSnapshot):SourceCatalogSnapshot {
  const remoteId=crypto.randomUUID(),entry={id:value.id+':'+remoteId,catalogId:value.id,remoteId,url:value.url+'/chapter/'+remoteId,title:'第'+(value.entries.length+1)+'话',groupIds:['default'],rawTypes:['话'],order:value.entries.length,related:false,sequenceId:'default:话'};
  return {...value,observedAt:value.observedAt+1,entries:[...value.entries,entry],groups:[{...value.groups[0],entryIds:[...value.groups[0].entryIds,entry.id]}],defaultEntryId:value.defaultEntryId??entry.id};
}
afterEach(async()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);});

describe('automatic source directory reconciliation',()=>{
  it('establishes a quiet baseline, detects additions once, and keeps images and reading positions',async()=>{
    const first=snapshot(),comic=await importCatalog(first),entry=(await continueEntry(comic.id))!;
    expect(comic.catalogUpdates).toBeUndefined();expect(catalogSyncPolicy(comic)?.intervalMinutes).toBe(720);
    await importManifest({id:'manifest',revision:1,title:'第1话',url:first.entries[0].url,adapter:'mangacopy',direction:'rtl',discoveryComplete:true,knownTotal:1,note:'',items:[{id:'one',url:'https://images.example/one.png',width:800,height:1200,order:0}]});
    const [page]=await catalog.listPages(entry.contentId),position={id:entry.id,comicId:comic.id,entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.42,updatedAt:Date.now()};
    await catalog.savePosition(position);
    const next=append(first);await applyCatalogRefresh(comic.id,1,next);await applyCatalogRefresh(comic.id,1,next);
    const saved=(await catalog.get('comics',comic.id))!;
    expect(saved.catalogUpdates).toEqual({revision:1,seenRevision:0,count:1});
    expect(await catalog.get('positions',entry.id)).toEqual(position);
    expect(await catalog.get('entries',entry.id)).toMatchObject({contentId:entry.contentId,indexState:'ready'});
    expect(await catalog.listPages(entry.contentId)).toEqual([page]);expect((await readerSequence(entry.id)).copies).toHaveLength(2);
    expect((await loadEntry(entry.id)).catalogUpdateRevision).toBe(1);
    await comicDirectory(comic.id);expect((await catalog.get('comics',comic.id))?.catalogUpdates?.count).toBe(1);
    await acknowledgeCatalogUpdates(comic.id,1);expect((await catalog.get('comics',comic.id))?.catalogUpdates).toEqual({revision:1,seenRevision:1,count:0});
    const readAt=(await catalog.get('comics',comic.id))?.lastReadAt;
    await applyCatalogRefresh(comic.id,1,append(next));await acknowledgeCatalogUpdates(comic.id,1);
    expect((await catalog.get('comics',comic.id))?.catalogUpdates).toEqual({revision:2,seenRevision:1,count:1});
    expect((await catalog.get('comics',comic.id))?.lastReadAt).toBe(readAt);
  });
  it('syncs titles, groups, order and removals without false update badges or erasing the current entry',async()=>{
    const first=append(snapshot()),comic=await importCatalog(first),entries=await catalog.listEntries(comic.id);
    const next={...first,observedAt:first.observedAt+1,title:'改名',defaultEntryId:first.entries[1].id,entries:[{...first.entries[1],title:'新标题',order:0}],groups:[{...first.groups[0],title:'新分类',entryIds:[first.entries[1].id]}]};
    await applyCatalogRefresh(comic.id,1,next);
    expect((await catalog.get('comics',comic.id))?.catalogUpdates).toBeUndefined();
    expect((await comicDirectory(comic.id)).entries.filter(entry=>entry.readable).map(entry=>entry.title)).toEqual(['新标题']);
    expect((await comicDirectory(comic.id)).entries.find(entry=>entry.id===entries[0].id)).toMatchObject({readable:false,sourceRemoved:true});
    expect((await comicDirectory(comic.id)).groups[0].title).toBe('新分类');
    expect(await catalog.get('entries',entries[0].id)).toMatchObject({sourceRemoved:true,contentId:entries[0].contentId});
    expect((await comicDirectory(comic.id,entries[0].id)).entries).toHaveLength(2);
  });
  it('rejects partial, foreign and stale observations; deletion and lease changes cannot resurrect a comic',async()=>{
    const first=snapshot(),comic=await importCatalog(first),next=append(first);
    await expect(applyCatalogRefresh(comic.id,1,{...next,complete:false})).rejects.toThrow();
    await expect(applyCatalogRefresh(comic.id,1,{...next,groups:[{...next.groups[0],complete:false}]})).rejects.toThrow();
    await expect(applyCatalogRefresh(comic.id,1,snapshot())).rejects.toThrow('不属于');
    await applyCatalogRefresh(comic.id,1,next,'wrong-lease');expect(await catalog.listEntries(comic.id)).toHaveLength(1);
    await applyCatalogRefresh(comic.id,1,next);await applyCatalogRefresh(comic.id,1,first);
    expect(await catalog.listEntries(comic.id)).toHaveLength(2);
    await catalog.deleteComic(comic.id);await applyCatalogRefresh(comic.id,1,next);expect(await catalog.get('comics',comic.id)).toBeUndefined();
  });
});

describe('on-demand directory checks',()=>{
  it('checks only the requested book after twelve hours without scanning the shelf',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    const first=snapshot(),second=snapshot(),comic=await importCatalog(first),other=await importCatalog(second);
    await catalog.put('comics',{id:'other',sourceKey:'other',title:'Other',sourceName:'Local',source:{connectionId:'local',providerItemId:'other',locator:{},generation:1,status:'active'},createdAt:Date.now(),updatedAt:Date.now()});
    const sources=new Map([first,second].map(value=>[value.url,append(value)])),read=vi.fn(async(url:string)=>sources.get(url)!);
    const scan=vi.spyOn(catalog,'search'),list=vi.spyOn(catalog,'list');
    expect(await checkCatalogUpdates(comic.id,{},read)).toEqual({status:'skipped'});expect(read).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now()+12*60*60_000);
    expect(await checkCatalogUpdates(comic.id,{},read)).toEqual({status:'checked',hasUpdates:true});
    expect(read).toHaveBeenCalledExactlyOnceWith(first.url,undefined);
    expect((await catalog.get('comics',other.id))?.catalogUpdates).toBeUndefined();
    await checkCatalogUpdates('other',{manual:true},read);await checkCatalogUpdates('missing',{},read);
    vi.setSystemTime(Date.now()+12*60*60_000-1);await checkCatalogUpdates(comic.id,{},read);expect(read).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now()+1);await checkCatalogUpdates(comic.id,{},read);expect(read).toHaveBeenCalledTimes(2);
    expect(scan).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
  });
  it('deduplicates manual/automatic work, persists attempts, and lets manual retry bypass the interval',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    const first=snapshot(),comic=await importCatalog(first);vi.setSystemTime(Date.now()+12*60*60_000);
    let finish!:(value:SourceCatalogSnapshot)=>void;const read=vi.fn(()=>new Promise<SourceCatalogSnapshot>(resolve=>{finish=resolve;}));
    const startedAt=Date.now(),running=checkCatalogUpdates(comic.id,{},read);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    expect((await catalog.get('comics',comic.id))?.catalogSync).toMatchObject({lastAttemptAt:startedAt,nextCheckAt:startedAt+12*60*60_000});
    expect(await checkCatalogUpdates(comic.id,{manual:true},read)).toEqual({status:'busy'});
    expect(read).toHaveBeenCalledOnce();finish(append(first));await running;
    const successAt=(await catalog.get('comics',comic.id))?.catalogSync?.lastSuccessAt;
    vi.setSystemTime(Date.now()+12*60*60_000);await expect(checkCatalogUpdates(comic.id,{},async()=>{throw Error('offline');})).rejects.toThrow('offline');
    expect((await catalog.get('comics',comic.id))?.catalogSync).toMatchObject({lastAttemptAt:Date.now(),lastSuccessAt:successAt,nextCheckAt:Date.now()+12*60*60_000});
    expect((await comicDirectory(comic.id)).entries).toHaveLength(2);
    await catalog.patch('comics',comic.id,{catalogSync:{lease:'abandoned',lastAttemptAt:Date.now(),nextCheckAt:Date.now()+12*60*60_000}});
    const recovered=vi.fn(async()=>append(first));await checkCatalogUpdates(comic.id,{},recovered);expect(recovered).not.toHaveBeenCalled();
    await checkCatalogUpdates(comic.id,{manual:true},recovered);expect(recovered).toHaveBeenCalledOnce();
    expect((await catalog.get('comics',comic.id))?.catalogSync?.lease).toBeUndefined();
  });
  it('shares a non-waiting book lock across tabs and skips revoked or unsupported sources',async()=>{
    const first=snapshot(),comic=await importCatalog(first),read=vi.fn(async()=>append(first));
    const request=vi.fn(async(_name:string,_options:unknown,callback:(lock:null)=>unknown)=>callback(null));
    vi.stubGlobal('navigator',{locks:{request}});
    expect(await checkCatalogUpdates(comic.id,{manual:true},read)).toEqual({status:'busy'});
    expect(request).toHaveBeenCalledWith('nc-catalog-check:'+comic.id,{ifAvailable:true},expect.any(Function));
    expect(read).not.toHaveBeenCalled();vi.unstubAllGlobals();
    const connection=(await catalog.get('connections',comic.source.connectionId))!;
    await catalog.put('connections',{...connection,status:'disconnected'});
    expect(await checkCatalogUpdates(comic.id,{manual:true},read)).toEqual({status:'unavailable'});
    await catalog.put('connections',connection);
    expect(catalogSyncPolicy({...comic,sourceUrl:'https://unadapted.example/book'})).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['cancel','remove','disconnect'] as const)('ignores a late result after %s and preserves retained content',async action=>{
    const first=snapshot(),comic=await importCatalog(first),controller=new AbortController();
    let finish!:(value:SourceCatalogSnapshot)=>void;const read=vi.fn(()=>new Promise<SourceCatalogSnapshot>(resolve=>{finish=resolve;}));
    const running=checkCatalogUpdates(comic.id,{manual:true,signal:controller.signal},read);
    await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    if(action==='cancel')controller.abort();
    else if(action==='remove')await catalog.deleteComic(comic.id);
    else {const connection=(await catalog.get('connections',comic.source.connectionId))!;await catalog.put('connections',{...connection,status:'disconnected'});}
    const result=action==='cancel'?expect(running).rejects.toMatchObject({name:'AbortError'}):expect(running).resolves.toEqual({status:'unavailable'});
    finish(append(first));await result;
    expect(await catalog.listEntries(comic.id)).toHaveLength(action==='remove'?0:1);
    expect((await catalog.get('comics',comic.id))?.catalogSync?.lease).toBeUndefined();
  });
});
