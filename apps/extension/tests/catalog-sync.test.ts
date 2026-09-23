import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importCatalog, importManifest} from '../src/comics/application/import-service';
import {acknowledgeCatalogUpdates, applyCatalogRefresh, catalogSyncPolicy} from '../src/comics/application/catalog-service';
import {syncNextCatalog} from '../src/comics/application/catalog-sync';
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
afterEach(async()=>{vi.useRealTimers();for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);});

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
    expect((await comicDirectory(comic.id)).entries.map(entry=>entry.title)).toEqual(['新标题']);
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

describe('persistent periodic and opening checks',()=>{
  it('skips repeated openings and unsupported sources, checks all due comics only after twelve hours',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    const first=snapshot(),second=snapshot();await importCatalog(first);await importCatalog(second);
    await importManifest({id:'other',revision:1,title:'Other',url:'https://www.gunnerkrigg.com/?p=123',adapter:'gunnerkrigg',direction:'ltr',discoveryComplete:true,note:'',items:[{id:'one',url:'https://www.gunnerkrigg.com/comics/fixture.png',width:800,height:1200,order:0}]});
    const sources=new Map([first,second].map(value=>[value.url,append(value)])),read=vi.fn(async(url:string)=>sources.get(url)!);
    await syncNextCatalog(read);expect(read).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now()+12*60*60_000);while(await syncNextCatalog(read)){}expect(read).toHaveBeenCalledTimes(2);
    await syncNextCatalog(read);expect(read).toHaveBeenCalledTimes(2);
    while(await syncNextCatalog(read)){}expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now()+12*60*60_000-1);await syncNextCatalog(read);expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now()+1);while(await syncNextCatalog(read)){}expect(read).toHaveBeenCalledTimes(4);
  });
  it('persists the check time before requests and retains the twelve-hour gate after failure or worker interruption',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    const first=snapshot(),comic=await importCatalog(first);vi.setSystemTime(Date.now()+12*60*60_000);
    let finish!:(value:SourceCatalogSnapshot)=>void;const read=vi.fn(()=>new Promise<SourceCatalogSnapshot>(resolve=>{finish=resolve;}));
    const startedAt=Date.now(),running=syncNextCatalog(read);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    expect((await catalog.get('comics',comic.id))?.catalogSync).toMatchObject({lastAttemptAt:startedAt,nextCheckAt:startedAt+12*60*60_000});
    await syncNextCatalog(read);expect(read).toHaveBeenCalledOnce();finish(append(first));await running;
    const successAt=(await catalog.get('comics',comic.id))?.catalogSync?.lastSuccessAt;
    vi.setSystemTime(Date.now()+12*60*60_000);await syncNextCatalog(async()=>{throw Error('offline');});
    expect((await catalog.get('comics',comic.id))?.catalogSync).toMatchObject({lastAttemptAt:Date.now(),lastSuccessAt:successAt,nextCheckAt:Date.now()+12*60*60_000});
    expect((await comicDirectory(comic.id)).entries).toHaveLength(2);
    await catalog.patch('comics',comic.id,{catalogSync:{lease:'abandoned',lastAttemptAt:Date.now(),nextCheckAt:Date.now()+12*60*60_000}});
    const recovered=vi.fn(async()=>append(first));await syncNextCatalog(recovered);expect(recovered).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now()+120_000);await syncNextCatalog(recovered);expect(recovered).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now()+12*60*60_000);await syncNextCatalog(recovered);expect(recovered).toHaveBeenCalledOnce();
  });
});
