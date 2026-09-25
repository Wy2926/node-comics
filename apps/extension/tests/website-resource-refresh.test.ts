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

async function fixture(key?:string){
  const manifest:PageManifest={id:crypto.randomUUID(),revision:1,title:'Fresh resource fixture',
    url:`https://mangacopy.com/comic/refresh-${crypto.randomUUID()}/chapter/${crypto.randomUUID()}`,adapter:'mangacopy',
    direction:'rtl',discoveryComplete:true,knownTotal:1,note:'',items:[{id:'page-0',contentKey:key,url:'https://first.example/0.png',width:10,height:20,order:0}]};
  const {id}=await importManifest(manifest),entry=(await catalog.get('entries',id))!,[page]=await catalog.listPages(entry.contentId);
  await catalog.savePosition({id,entryId:id,comicId:entry.comicId,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.6,updatedAt:1});
  return {manifest,entry,page};
}

describe('refreshing renewable website resources',()=>{
  it('refreshes indexed content locators on explicit opening without replacing progress',async()=>{
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
});
