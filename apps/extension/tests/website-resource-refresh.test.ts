import 'fake-indexeddb/auto';
import {describe,expect,it,vi} from 'vitest';
import type {PageManifest} from '../src/sources/contracts/source';

const discovery=vi.hoisted(()=>vi.fn());
const acquire=vi.hoisted(()=>vi.fn());
vi.mock('../src/sources',async original=>({...await original<typeof import('../src/sources')>(),discoverPage:discovery,discoverEntry:discovery}));
vi.mock('../src/comics/pages/service',()=>({acquirePage:acquire}));
import {catalog} from '../src/comics/repositories';
import {importManifest} from '../src/comics/application/import-service';
import {discoverEntryContent,queueDownloads,runDownloads} from '../src/comics/acquisition';
import {refreshWebsitePage} from '../src/comics/application/website-content';

async function fixture(key?:string,count=1){
  const manifest:PageManifest={id:crypto.randomUUID(),revision:1,title:'Fresh resource fixture',
    url:`https://mangacopy.com/comic/refresh-${crypto.randomUUID()}/chapter/${crypto.randomUUID()}`,adapter:'mangacopy',
    direction:'rtl',discoveryComplete:true,knownTotal:count,note:'',items:Array.from({length:count},(_,index)=>({id:`page-${index}`,contentKey:key&&`${key}-${index}`,url:`https://first.example/${index}.png`,width:10,height:20,order:index}))};
  const {id}=await importManifest(manifest),entry=(await catalog.get('entries',id))!,pages=await catalog.listPages(entry.contentId),[page]=pages;
  await catalog.savePosition({id,entryId:id,comicId:entry.comicId,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.6,updatedAt:1});
  return {manifest,entry,page,pages};
}

const renewed=(manifest:PageManifest):PageManifest=>({...manifest,id:crypto.randomUUID(),items:manifest.items.map((item,index)=>({...item,url:`https://renewed.example/${index}.png`}))});
function pendingDiscovery(){
  let resolve!:(manifest:PageManifest)=>void;
  const promise=new Promise<PageManifest>(done=>{resolve=done;});
  const source:{signal?:AbortSignal;progress?:(manifest:PageManifest)=>Promise<void>}={};
  discovery.mockReset().mockImplementation((_url:unknown,signal:AbortSignal,progress:(manifest:PageManifest)=>Promise<void>)=>{Object.assign(source,{signal,progress});return promise;});
  return {resolve,source};
}

describe('refreshing renewable website resources',()=>{
  it('refreshes indexed content locators only on explicit resource refresh without replacing progress',async()=>{
    const f=await fixture('source-content'),next={...f.manifest,id:crypto.randomUUID(),items:f.manifest.items.map(item=>({...item,url:'https://new.example/0.png'}))};
    discovery.mockReset().mockResolvedValue(next);
    await discoverEntryContent(f.entry.id);expect(discovery).not.toHaveBeenCalled();
    await discoverEntryContent(f.entry.id,undefined,{refreshResources:true});expect(discovery).toHaveBeenCalledOnce();
    expect((await catalog.get('entries',f.entry.id))?.contentId).toBe(f.entry.contentId);
    expect(await catalog.get('pageDescriptors',[f.entry.contentId,f.page.pageId])).toMatchObject({locator:{url:'https://new.example/0.png'}});
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({pageId:f.page.pageId,relativeOffset:.6});
  });
  it('keeps cached discovery for sources without renewable content identities',async()=>{
    const f=await fixture();discovery.mockReset();
    await discoverEntryContent(f.entry.id,undefined,{refreshResources:true});expect(discovery).not.toHaveBeenCalled();
  });
  it('preserves the existing index and position when refresh fails',async()=>{
    const f=await fixture('source-content');discovery.mockReset().mockRejectedValue(Error('Source temporarily unavailable'));
    await expect(discoverEntryContent(f.entry.id,undefined,{refreshResources:true})).rejects.toThrow('temporarily unavailable');
    expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId:f.entry.contentId,error:'Source temporarily unavailable'});
    expect(await catalog.get('pageDescriptors',[f.entry.contentId,f.page.pageId])).toEqual(f.page);
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({pageId:f.page.pageId,relativeOffset:.6});
  });
  it.each([{readable:false},{sourceRemoved:true}])('does not request unavailable chapter resources: %o',async status=>{
    const f=await fixture('source-content');await catalog.patch('entries',f.entry.id,status);discovery.mockReset();
    await expect(discoverEntryContent(f.entry.id,undefined,{refreshResources:true})).rejects.toThrow('暂不可读');
    expect(discovery).not.toHaveBeenCalled();
    expect(await catalog.get('pageDescriptors',[f.entry.contentId,f.page.pageId])).toEqual(f.page);
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({pageId:f.page.pageId,relativeOffset:.6});
  });
  it('renews locators before downloading an already indexed chapter',async()=>{
    const f=await fixture('source-content'),next={...f.manifest,id:crypto.randomUUID(),items:f.manifest.items.map(item=>({...item,url:'https://renewed.example/0.png'}))};
    discovery.mockReset().mockResolvedValue(next);
    acquire.mockReset().mockImplementation(async()=>{
      const [page]=await catalog.listPages(f.entry.contentId);
      expect(page.locator.url).toBe('https://renewed.example/0.png');
      return {blob:new Blob(['image']),release:vi.fn()};
    });
    await queueDownloads([f.entry.id]);await runDownloads();
    expect(discovery).toHaveBeenCalledOnce();expect(acquire).toHaveBeenCalledOnce();
    expect(await catalog.get('tasks','download:'+f.entry.id)).toMatchObject({status:'complete',completed:1});
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({pageId:f.page.pageId,relativeOffset:.6});
  });
  it('shares one chapter discovery between two failed pages and preserves their identities and reading position',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest),pending=pendingDiscovery();
    const requests=f.pages.map(page=>refreshWebsitePage(f.entry,page,new AbortController().signal));
    await vi.waitFor(()=>expect(discovery).toHaveBeenCalledOnce());pending.resolve(next);
    const pages=await Promise.all(requests);
    expect(discovery).toHaveBeenCalledOnce();
    expect(pages.map(page=>page.pageId)).toEqual(f.pages.map(page=>page.pageId));
    expect(pages.map(page=>page.locator.url)).toEqual(next.items.map(item=>item.url));
    expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId:f.entry.contentId,generation:f.entry.generation,indexState:'ready'});
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({contentId:f.entry.contentId,pageId:f.page.pageId,relativeOffset:.6});
  });
  it('lets one failed page cancel without cancelling the other page sharing discovery',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest),pending=pendingDiscovery(),first=new AbortController(),second=new AbortController();
    const subscribed=vi.spyOn(second.signal,'addEventListener');
    const cancelled=expect(refreshWebsitePage(f.entry,f.pages[0],first.signal)).rejects.toMatchObject({name:'AbortError'});
    const remaining=refreshWebsitePage(f.entry,f.pages[1],second.signal);
    await vi.waitFor(()=>{expect(discovery).toHaveBeenCalledOnce();expect(subscribed).toHaveBeenCalledWith('abort',expect.any(Function),{once:true});});
    first.abort();await cancelled;
    expect(pending.source.signal?.aborted).toBe(false);
    pending.resolve(next);
    await expect(remaining).resolves.toMatchObject({pageId:f.pages[1].pageId,locator:{url:next.items[1].url,manifestId:next.id}});
    expect(discovery).toHaveBeenCalledOnce();
  });
  it('cancels discovery after all pages cancel and rejects late progress and final publication',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest),pending=pendingDiscovery(),first=new AbortController(),second=new AbortController();
    const subscribed=vi.spyOn(second.signal,'addEventListener');
    const cancelled=[first,second].map((controller,index)=>expect(refreshWebsitePage(f.entry,f.pages[index],controller.signal)).rejects.toMatchObject({name:'AbortError'}));
    await vi.waitFor(()=>{expect(discovery).toHaveBeenCalledOnce();expect(subscribed).toHaveBeenCalledWith('abort',expect.any(Function),{once:true});});
    first.abort();second.abort();await Promise.all(cancelled);
    expect(pending.source.signal?.aborted).toBe(true);
    await expect(pending.source.progress!(next)).rejects.toMatchObject({name:'AbortError'});
    pending.resolve(next);
    expect(await catalog.listPages(f.entry.contentId)).toEqual(f.pages);
    expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId:f.entry.contentId,generation:f.entry.generation,indexState:'ready'});
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({pageId:f.page.pageId,relativeOffset:.6});
  });
  it('reuses a descriptor renewed by another page without discovering the chapter again',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest);discovery.mockReset().mockResolvedValue(next);
    await refreshWebsitePage(f.entry,f.pages[0],new AbortController().signal);
    await expect(refreshWebsitePage(f.entry,f.pages[1],new AbortController().signal)).resolves.toMatchObject({pageId:f.pages[1].pageId,locator:{url:next.items[1].url,manifestId:next.id}});
    expect(discovery).toHaveBeenCalledOnce();
  });
  it('rejects changed content keys without replacing the existing index or reading position',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest);next.items[1].contentKey='different-source-content';discovery.mockReset().mockResolvedValue(next);
    await expect(refreshWebsitePage(f.entry,f.pages[0],new AbortController().signal)).rejects.toThrow('来源内容已变化');
    expect(await catalog.listPages(f.entry.contentId)).toEqual(f.pages);
    expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId:f.entry.contentId,generation:f.entry.generation,pageCount:2});
    expect(await catalog.get('positions',f.entry.id)).toMatchObject({contentId:f.entry.contentId,pageId:f.page.pageId,relativeOffset:.6});
  });
  it('does not publish a late manifest after the entry content has been replaced',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest),pending=pendingDiscovery(),contentId=crypto.randomUUID();
    const rejected=expect(refreshWebsitePage(f.entry,f.page,new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(discovery).toHaveBeenCalledOnce());
    const replacements=f.pages.map(page=>({...page,contentId,locator:{...page.locator,url:`https://replacement.example/${page.ordinal}.png`}}));
    await catalog.replaceContent(f.entry.id,f.entry.generation,{contentId,format:'website'},replacements,true);
    const position=await catalog.get('positions',f.entry.id);
    pending.resolve(next);await rejected;
    expect(await catalog.listPages(contentId)).toEqual(replacements);
    expect(await catalog.listPages(f.entry.contentId)).toEqual([]);
    expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId,generation:f.entry.generation+1,indexState:'ready'});
    expect(await catalog.get('positions',f.entry.id)).toEqual(position);
  });
  it('does not publish a late manifest after source access is revoked',async()=>{
    const f=await fixture('source-content',2),next=renewed(f.manifest),pending=pendingDiscovery();
    const comic=(await catalog.get('comics',f.entry.comicId))!,connection=(await catalog.get('connections',comic.source.connectionId))!;
    const rejected=expect(refreshWebsitePage(f.entry,f.page,new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(discovery).toHaveBeenCalledOnce());
    try{
      await catalog.patch('connections',connection.id,{status:'revoked',generation:connection.generation+1});
      pending.resolve(next);await rejected;
      expect(await catalog.listPages(f.entry.contentId)).toEqual(f.pages);
      expect(await catalog.get('entries',f.entry.id)).toMatchObject({contentId:f.entry.contentId,generation:f.entry.generation,pageCount:2});
      expect(await catalog.get('positions',f.entry.id)).toMatchObject({contentId:f.entry.contentId,pageId:f.page.pageId,relativeOffset:.6});
    }finally{await catalog.put('connections',connection);}
  });
});
