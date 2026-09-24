import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importCatalog,importManifest} from '../src/comics/application/import-service';
import {applyCatalogRefresh} from '../src/comics/application/catalog-service';
import {coverReference,removeComic} from '../src/comics/application/library-service';
import {readThumbnail} from '../src/comics/application/image-access';
import {invalidateSourceAccess} from '../src/comics/application/source-access';
import {thumbnailCache} from '../src/storage/thumbnails';
import {pageReference,RENDER_PROFILE} from '../src/comics/pages/identity';
import {validateSourceCatalog,type SourceCatalogSnapshot} from '../src/sources';
const mocks=vi.hoisted(()=>({read:vi.fn(),encode:vi.fn(),acquire:vi.fn()}));
vi.mock('../src/sources',async original=>({...await original<typeof import('../src/sources')>(),readSourceCover:mocks.read}));
vi.mock('../src/comics/pages/service',async original=>({...await original<typeof import('../src/comics/pages/service')>(),acquirePage:mocks.acquire}));
function snapshot():SourceCatalogSnapshot {
  const slug='cover-'+crypto.randomUUID(),id='mangacopy:'+slug,remoteId=crypto.randomUUID(),entryId=id+':'+remoteId,url='https://www.copy4000.com/comic/'+slug;
  return {id,sourceId:'mangacopy',url,title:'Cover fixture',cover:{url:'https://sg.mangafunb.fun/cover.jpg'},observedAt:Date.now(),complete:true,note:'',groups:[],
    entries:[{id:entryId,catalogId:id,remoteId,url:url+'/chapter/'+remoteId,title:'Chapter',groupIds:[],rawTypes:[],order:0,related:false}],defaultEntryId:entryId};
}
beforeEach(async()=>{
  await thumbnailCache.clear();mocks.read.mockReset().mockResolvedValue(new Blob(['cover']));mocks.encode.mockReset().mockResolvedValue(new Blob(['thumbnail']));mocks.acquire.mockReset();
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:240,height:360,close(){}})));
  vi.stubGlobal('OffscreenCanvas',class{getContext(){return{drawImage(){}};}convertToBlob(){return mocks.encode();}});
});
afterEach(async()=>{vi.unstubAllGlobals();for(const comic of await catalog.list('comics',{limit:10000}))await removeComic(comic.id);});
describe('dedicated source covers',()=>{
  it.each(['javascript:alert(1)','data:image/png;base64,AA','file:///secret','https://user:pass@example.test/a','/relative',''])('rejects an untrusted catalog cover %s',url=>{
    expect(()=>validateSourceCatalog({...snapshot(),cover:{url}})).toThrow('INVALID_SOURCE_CATALOG');
  });
  it('imports artwork before any chapter is read and preserves it across indexing, refresh and position recovery',async()=>{
    const first=snapshot(),comic=await importCatalog(first),key=coverReference(comic)!;
    expect(comic.cover).toBeUndefined();expect(await catalog.count('pageDescriptors')).toBe(0);
    expect(await (await readThumbnail(key)).text()).toBe('thumbnail');
    await readThumbnail(key);expect(mocks.read).toHaveBeenCalledTimes(1);expect(mocks.acquire).not.toHaveBeenCalled();
    const imported=await importManifest({id:'cover-manifest',revision:1,title:'Chapter',url:first.entries[0].url,adapter:first.sourceId,direction:'ltr',discoveryComplete:true,knownTotal:1,note:'',items:[{id:'page',url:'https://images.example/body.jpg',width:800,height:1200,order:0}]});
    const entry=(await catalog.get('entries',imported.id))!;
    const [page]=await catalog.listPages(entry.contentId),position={id:entry.id,comicId:comic.id,entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.42,updatedAt:Date.now()};
    await catalog.savePosition(position);
    expect(coverReference((await catalog.get('comics',comic.id))!)).toBe(key);
    const refreshed={...first,observedAt:first.observedAt+1,cover:{url:'https://sg.mangafunb.fun/new-cover.jpg'}};
    await applyCatalogRefresh(comic.id,1,refreshed);
    const next=(await catalog.get('comics',comic.id))!;
    expect(coverReference(next)).not.toBe(key);expect(next.catalogUpdates).toBeUndefined();
    expect(await catalog.get('positions',entry.id)).toEqual(position);expect(await catalog.listPages(entry.contentId)).toEqual([page]);
    await expect(readThumbnail(key)).rejects.toThrow('来源已变化');
    await readThumbnail(coverReference(next)!);expect(mocks.read).toHaveBeenCalledTimes(2);
    await removeComic(comic.id);expect((await thumbnailCache.usage()).count).toBe(0);
    await expect(readThumbnail(coverReference(next)!)).rejects.toThrow('来源已变化');
  });
  it('uses the first-page cover when a website supplies no dedicated artwork',async()=>{
    const comic=await importCatalog({...snapshot(),cover:undefined});
    const cover={entryId:'file',contentId:'content',pageId:'first'};
    expect(coverReference({...comic,cover})).toBe(pageReference({...cover,renderProfileId:RENDER_PROFILE}));
    expect(coverReference(comic)).toBeUndefined();
  });
  it('does not poison the thumbnail cache after a failed cover request',async()=>{
    const comic=await importCatalog(snapshot()),key=coverReference(comic)!;
    mocks.read.mockRejectedValueOnce(Error('HTTP 503'));
    await expect(readThumbnail(key)).rejects.toThrow('503');expect(await thumbnailCache.get(key)).toBeUndefined();
    await expect(readThumbnail(key)).resolves.toBeInstanceOf(Blob);expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it.each(['clear','remove','revoke','refresh'] as const)('fences in-flight cover writes after %s',async action=>{
    const first=snapshot(),comic=await importCatalog(first),key=coverReference(comic)!,ready=Promise.withResolvers<void>(),encoded=Promise.withResolvers<Blob>();
    mocks.encode.mockImplementationOnce(()=>{ready.resolve();return encoded.promise;});
    const loading=readThumbnail(key);void loading.catch(()=>{});await ready.promise;
    if(action==='clear')await thumbnailCache.clear();
    if(action==='remove')await removeComic(comic.id);
    if(action==='revoke')await invalidateSourceAccess({connectionId:comic.source.connectionId,itemId:comic.source.providerItemId});
    if(action==='refresh')await applyCatalogRefresh(comic.id,1,{...first,observedAt:first.observedAt+1,cover:{url:'https://sg.mangafunb.fun/new.jpg'}});
    encoded.resolve(new Blob(['late']));
    if(action==='clear')await expect(loading).resolves.toBeInstanceOf(Blob);else await expect(loading).rejects.toThrow('来源已变化');
    expect(await thumbnailCache.get(key)).toBeUndefined();
  });
});
