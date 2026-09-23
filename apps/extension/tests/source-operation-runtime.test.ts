import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceNetwork} from '../src/sources/contracts/network';
import type {SourceImageAdapter} from '../src/sources/contracts/image';
import type {SourceCatalogSnapshot,SourceSnapshot} from '../src/sources/contracts/source';
const fixture=vi.hoisted(()=>({networks:{} as Record<string,SourceNetwork>,images:{} as Record<string,SourceImageAdapter>}));
vi.mock('../src/sources/registry/networks',()=>({sourceNetworks:fixture.networks}));
vi.mock('../src/sources/registry/images',()=>({sourceImages:fixture.images}));
vi.mock('../src/sources/registry/definitions',()=>({definitions:[{
  id:'fixture',name:'Fixture',capabilities:{importable:true,pages:true,catalog:true,inline:false},installation:{requiredOrigins:[],autoContentMatches:[]},
  identify:(url:URL)=>url.hostname==='fixture.test'?{sourceId:'fixture',url:url.href,pageKey:url.pathname,kind:url.pathname==='/book'?'catalog':'reader',catalog:{key:'fixture:book',url:'https://fixture.test/book'}}:null,
}]}));
import {networkOperation,readNetworkCatalog,readNetworkPages} from '../src/sources/runtime/network';
import {readSourceCatalog} from '../src/sources/runtime/catalog-reader';
import {discoverPage} from '../src/sources/runtime/client';
import {readSourceImage} from '../src/sources/runtime/source-image';
import {authorizeCatalogImport} from '../src/sources/runtime/import';
import {registerDocumentManifest} from '../src/sources/runtime/manifests';

const book='https://fixture.test/book',url='https://fixture.test/1';
const pages=():SourceSnapshot=>({adapter:'fixture',url,title:'Fixture',direction:'ltr',note:'',discoveryComplete:true,knownTotal:1,
  items:[{id:'one',order:0,width:800,height:1200,resource:{kind:'http',url:'https://images.test/one.png',processing:'recipe-1'}}]});
const source=():SourceCatalogSnapshot=>({id:'fixture:book',sourceId:'fixture',url:book,title:'Fixture',note:'',complete:true,observedAt:1,
  groups:[{id:'main',title:'Main',complete:true,entryIds:['one']}],entries:[{id:'one',catalogId:'fixture:book',remoteId:'1',url,title:'One',groupIds:['main'],rawTypes:[],order:0,related:false}]});
let saved:Record<string,unknown>,send:ReturnType<typeof vi.fn>,set:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  saved={};delete fixture.networks.fixture;delete fixture.images.fixture;
  send=vi.fn();set=vi.fn(async(values:object)=>Object.assign(saved,values));
  vi.stubGlobal('chrome',{runtime:{id:'fixture',sendMessage:send},permissions:{request:vi.fn(async()=>true),contains:vi.fn(async()=>true)},storage:{local:{get:async(k:string)=>({[k]:saved[k]}),set},session:{set:vi.fn(),remove:vi.fn()}},
    tabs:{create:vi.fn(async()=>({id:7})),get:vi.fn(async()=>({id:7,url:book,status:'complete'})),remove:vi.fn(async()=>{}),sendMessage:vi.fn(async()=>source())},scripting:{executeScript:vi.fn()}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('independent discovery operations and common manifest authority',()=>{
  it('supports network catalogs with document page discovery',async()=>{
    fixture.networks.fixture={catalog:async()=>source()};
    expect(networkOperation(url,'pages')).toBeUndefined();
    expect(await readSourceCatalog(book)).toEqual(source());
    const manifest={...pages(),id:'document',items:[],revision:1,knownTotal:0};
    send.mockImplementation(async(m:{type:string})=>({ok:true,data:m.type==='NC_OPEN_PAGE'?{tabId:7}:m.type==='NC_POLL_SOURCE'?manifest:true}));
    expect(await discoverPage(url,new AbortController().signal,async()=>{})).toEqual(manifest);
    expect(send).toHaveBeenCalledWith({type:'NC_CLOSE_SOURCE',tabId:7});
  });
  it('supports document catalogs with network page discovery',async()=>{
    fixture.networks.fixture={pages:async()=>pages()};vi.useFakeTimers();
    const catalog=readSourceCatalog(book);await vi.advanceTimersByTimeAsync(500);expect(await catalog).toEqual(source());
    const manifest=await readNetworkPages(url);expect(manifest).not.toHaveProperty('pageContext');
    expect(manifest).not.toHaveProperty('sourceTabId');expect(manifest.items[0].processing).toBe('recipe-1');
  });
  it.each(['width','total','id','processing','page-resource'] as const)('rejects invalid %s before registering any manifest',async(mode)=>{
    const value=pages();if(mode==='width')value.items[0].width=-1;if(mode==='total')value.knownTotal=99;if(mode==='id')value.items[0].id='';
    if(mode==='processing')value.items[0].resource={kind:'http',url:'https://images.test/one.png',processing:''};
    if(mode==='page-resource')value.items[0].resource={kind:'page',resourceKey:'page-image:forged'};
    fixture.networks.fixture={pages:async()=>value};await expect(readNetworkPages(url)).rejects.toThrow();expect(set).not.toHaveBeenCalled();
  });
  it('applies the same dimension/total checks to document observations and owns their navigation context',async()=>{
    const observation={...pages(),navigationId:'nav',revision:2,items:[{id:'one',order:0,width:-1,height:1200,url:'https://images.test/one.png'}]};
    await expect(registerDocumentManifest(observation,7)).rejects.toThrow();observation.items[0].width=800;
    const manifest=await registerDocumentManifest({...observation,...{id:'forged',sourceTabId:99,pageContext:{tabId:99,navigationId:'forged'}}},7,'trusted');
    expect(manifest.id).toBe('trusted');expect(manifest.pageContext).toEqual({tabId:7,navigationId:'nav'});expect(manifest).not.toHaveProperty('sourceTabId');
  });
  it('takes previous state only from the caller and does not commit discovery',async()=>{
    const previous=source(),read=vi.fn<NonNullable<SourceNetwork['catalog']>>(async()=>source());fixture.networks.fixture={catalog:read};saved['nc-source:fixture:book']={invalid:'unaccepted'};
    await readNetworkCatalog(book,{previous});expect(read.mock.calls[0][1].previous).toEqual(previous);expect(set).not.toHaveBeenCalled();
  });
  it('requests link permissions in the user gesture without requiring a network implementation',async()=>{
    const promise=authorizeCatalogImport(book);expect(chrome.permissions.request).toHaveBeenCalledWith({origins:['https://fixture.test/*']});
    expect(await promise).toEqual({url:book,catalogId:'fixture:book'});expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('source image facade',()=>{
  const ref={manifestId:'manifest',pageId:'one',expectedUrl:'https://images.test/one.png'};
  it('decodes an adapter image independently of network discovery',async()=>{
    const decode=vi.fn(async()=>new Blob(['decoded']));fixture.images.fixture={decode};
    send.mockResolvedValue({ok:true,data:{url:ref.expectedUrl,sourceId:'fixture',processing:'recipe-1'}});
    const fetch=vi.fn(async()=>new Response('encoded',{headers:{'x-format':'fixture'}}));vi.stubGlobal('fetch',fetch);
    expect(await(await readSourceImage(ref)).text()).toBe('decoded');
    expect(decode).toHaveBeenCalledWith(expect.any(Blob),expect.any(Headers),'recipe-1',undefined);expect(fixture.networks.fixture).toBeUndefined();
  });
  it('rejects changed URLs and missing permission before fetching',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);send.mockResolvedValue({ok:true,data:{url:'https://other.test/1.png'}});
    await expect(readSourceImage(ref)).rejects.toThrow('来源已变化');
    send.mockResolvedValue({ok:true,data:{url:ref.expectedUrl}});vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    await expect(readSourceImage(ref)).rejects.toThrow('授权');expect(fetch).not.toHaveBeenCalled();
  });
  it('reads a canvas handle without asking for a pseudo-origin permission',async()=>{
    send.mockResolvedValue({ok:true,data:{url:'page-image:canvas',data:'data:image/png;base64,YQ=='}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('pixels')));
    expect(await(await readSourceImage({...ref,expectedUrl:'page-image:canvas'})).text()).toBe('pixels');expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });
});
