import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceNetwork} from '../src/sources/contracts/network';
import type {SourceImageAdapter} from '../src/sources/contracts/image';
import type {SourceCatalogSnapshot,SourceSnapshot} from '../src/sources/contracts/source';
const fixture=vi.hoisted(()=>({networks:{} as Record<string,SourceNetwork>,images:{} as Record<string,SourceImageAdapter>}));
vi.mock('../src/sources/registry/networks',()=>({sourceNetworks:fixture.networks}));
vi.mock('../src/sources/registry/images',()=>({sourceImages:fixture.images}));
vi.mock('../src/sources/registry/definitions',()=>({definitions:[{
  id:'fixture',name:'Fixture',capabilities:{importable:true,pages:true,catalog:true,inline:false},installation:{requiredOrigins:[],autoContentMatches:[]},
  identify:(url:URL)=>url.hostname==='fixture.test'?{sourceId:'fixture',url:url.href,pageKey:url.pathname,kind:url.pathname==='/book'?'catalog':'reader',...(url.pathname==='/unbound'&&url.hash!=='#book'?{}:{catalog:{key:'fixture:book',url:'https://fixture.test/book'}})}:null,
}]}));
import {networkOperation,readNetworkCatalog,readNetworkPages,resolveNetworkCatalog} from '../src/sources/runtime/network';
import {readSourceCatalog} from '../src/sources/runtime/catalog-reader';
import {discoverEntry,discoverPage} from '../src/sources/runtime/client';
vi.mock('../src/sources/runtime/image-headers',()=>({withImageHeaders:async(_url:unknown,_headers:unknown,_signal:unknown,read:()=>Promise<unknown>)=>read()}));
import {readSourceImage} from '../src/sources/runtime/source-image';
import {authorizeCatalogImport,readImportCatalog} from '../src/sources/runtime/import';
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
  it('resolves missing parent identity only through the owning HTTP adapter and validates the target',async()=>{
    const unbound='https://fixture.test/unbound';
    expect(await resolveNetworkCatalog(unbound)).toBeUndefined();
    const resolve=vi.fn(async()=>book);
    fixture.networks.fixture={resolveCatalog:resolve};
    expect(await resolveNetworkCatalog(unbound)).toBe(book);
    expect(resolve).toHaveBeenCalledOnce();expect(chrome.tabs.create).not.toHaveBeenCalled();
    for(const target of ['https://other.test/book',url,'javascript:alert(1)']){
      resolve.mockResolvedValueOnce(target);
      await expect(resolveNetworkCatalog(unbound)).rejects.toThrow();
    }
    const controller=new AbortController();
    resolve.mockImplementationOnce(async()=>{controller.abort();return book;});
    await expect(resolveNetworkCatalog(unbound,controller.signal)).rejects.toThrow();
  });
  it.each([
    ['http','http'],['http','document'],['document','http'],['document','document'],
  ])('resolves a bare chapter before independent %s catalog / %s page discovery',async(catalogTransport,pageTransport)=>{
    vi.useFakeTimers();
    const unbound='https://fixture.test/unbound',bound=unbound+'#book';
    const snapshot={...source(),entries:[{...source().entries[0],url:bound}]};
    const pageSource={...pages(),url:bound};
    const readCatalog=vi.fn(async()=>snapshot),readPages=vi.fn(async()=>pageSource),resolve=vi.fn(async()=>book);
    fixture.networks.fixture={resolveCatalog:resolve,...(catalogTransport==='http'?{catalog:readCatalog}:{}),...(pageTransport==='http'?{pages:readPages}:{})};
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async()=>snapshot);
    const [imported]=await Promise.all([readImportCatalog(unbound),vi.advanceTimersByTimeAsync(500)]);
    expect(imported).toEqual(snapshot);expect(resolve).toHaveBeenCalledOnce();
    if(catalogTransport==='http'){expect(readCatalog).toHaveBeenCalledOnce();expect(chrome.tabs.create).not.toHaveBeenCalled();}
    else {expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({url:book,active:false});expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);}
    const manifest={...pageSource,id:'document',revision:1,items:[{id:'one',order:0,width:800,height:1200,url:'https://images.test/one.png'}]};
    send.mockImplementation(async(m:{type:string})=>({ok:true,data:m.type==='NC_OPEN_SOURCE'?{tabId:8}:m.type==='NC_POLL_SOURCE'?manifest:true}));
    const result=await discoverEntry(imported,'one',new AbortController().signal,async()=>{});
    expect(result.url).toBe(bound);
    if(pageTransport==='http'){expect(readPages).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();}
    else {expect(send).toHaveBeenCalledWith({type:'NC_OPEN_SOURCE',catalogId:snapshot.id,entryId:'one'});expect(send).toHaveBeenCalledWith({type:'NC_CLOSE_SOURCE',tabId:8});}
  });
  it('does not switch to a document catalog after an HTTP catalog fails',async()=>{
    fixture.networks.fixture={resolveCatalog:async()=>book,catalog:async()=>{throw Error('HTTP offline');}};
    await expect(readImportCatalog('https://fixture.test/unbound')).rejects.toThrow('HTTP offline');
    expect(chrome.tabs.create).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
  });
  it.each(['missing-chapter','incomplete','foreign'])('validates an injected %s catalog after resolving a bare reader',async mode=>{
    fixture.networks.fixture={resolveCatalog:async()=>book};
    const value=source();if(mode==='incomplete')value.complete=false;if(mode==='foreign')value.sourceId='foreign';
    const read=vi.fn(async()=>value);
    await expect(readImportCatalog('https://fixture.test/unbound',read)).rejects.toThrow();
    expect(read).toHaveBeenCalledExactlyOnceWith(book);expect(set).not.toHaveBeenCalled();
  });
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
    expect(await promise).toBe(book);expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('rejects cross-origin and foreign-source Referers before issuing a request',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const [target,referer] of [['https://other.test/api',url],['https://other.test/api','https://other.test/1']]) {
      fixture.networks.fixture={pages:async(_url,context)=>{await context.request(target,{referer});return pages();}};
      await expect(readNetworkPages(url)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
  });
});

describe('renewable HTTP manifest registration',()=>{
  const renewable=()=>{const value=pages();value.items[0].contentKey='content/one';return value;};
  it('deduplicates identical full snapshots even when adapter object keys arrive in a different order',async()=>{
    const value=renewable(),read=vi.fn(async()=>value);fixture.networks.fixture={pages:read};
    const first=await readNetworkPages(url);
    read.mockResolvedValueOnce({...value,items:value.items.map(({resource,id,order,width,height,contentKey})=>({resource,contentKey,height,width,order,id}))});
    const second=await readNetworkPages(url);
    expect(second).toEqual(first);expect(first.id).toMatch(/^network-sha256:[a-f\d]{64}$/);
    expect(Object.keys(saved)).toEqual(['manifest:'+first.id]);
  });
  it.each(['cdn','content','slot','processing','source-url','metadata'])('preserves the old registered locator when %s changes',async(change)=>{
    const value=renewable(),read=vi.fn(async()=>value);fixture.networks.fixture={pages:read};
    const first=await readNetworkPages(url),next=structuredClone(value);
    if(change==='cdn')next.items[0].resource={kind:'http',url:'https://other-cdn.test/one.png',processing:'recipe-1'};
    if(change==='content')next.items[0].contentKey='content/two';
    if(change==='slot')next.items[0].id='another-slot';
    if(change==='processing')next.items[0].resource={kind:'http',url:'https://images.test/one.png',processing:'recipe-2'};
    if(change==='source-url')next.url='https://fixture.test/2';
    if(change==='metadata')next.title='Changed title';
    read.mockResolvedValueOnce(next);
    const second=await readNetworkPages(next.url);
    expect(second.id).not.toBe(first.id);expect(saved['manifest:'+first.id]).toEqual(first);
    expect(saved['manifest:'+second.id]).toEqual(second);expect(Object.keys(saved)).toHaveLength(2);
  });
  it.each(['unkeyed','mixed'])('keeps random IDs for %s HTTP snapshots',async(kind)=>{
    const value=pages();
    if(kind==='mixed'){
      value.items.push({...value.items[0],id:'two',order:1,contentKey:'content/two'});value.knownTotal=2;
    }
    fixture.networks.fixture={pages:async()=>value};
    const first=await readNetworkPages(url),second=await readNetworkPages(url);
    expect(first.id).not.toBe(second.id);expect(first.id).not.toMatch(/^network-sha256:/);
  });
  it('keeps document observation IDs and navigation authority independent of renewable HTTP keys',async()=>{
    const value=renewable(),observation={...value,navigationId:'nav',revision:1,
      items:[{id:'one',order:0,width:800,height:1200,contentKey:'content/one',url:'https://images.test/one.png'}]};
    const first=await registerDocumentManifest(observation,7),second=await registerDocumentManifest(observation,7);
    expect(first.id).not.toBe(second.id);expect(first.pageContext).toEqual({tabId:7,navigationId:'nav'});
  });
  it.each(['empty-key','page-resource','invalid-url'])('rejects an invalid %s renewable snapshot before registration',async(kind)=>{
    const value=renewable();
    if(kind==='empty-key')value.items[0].contentKey='';
    if(kind==='page-resource')value.items[0].resource={kind:'page',resourceKey:'page-image:one'};
    if(kind==='invalid-url')value.items[0].resource={kind:'http',url:'javascript:alert(1)'};
    fixture.networks.fixture={pages:async()=>value};
    await expect(readNetworkPages(url)).rejects.toThrow();expect(set).not.toHaveBeenCalled();
  });
});

describe('source image facade',()=>{
  const ref={manifestId:'manifest',pageId:'one',expectedUrl:'https://images.test/one.png'};
  it('decodes an adapter image independently of network discovery',async()=>{
    const decode=vi.fn(async()=>new Blob(['decoded']));fixture.images.fixture={decode};
    send.mockResolvedValue({ok:true,data:{url:ref.expectedUrl,pageUrl:url,sourceId:'fixture',processing:'recipe-1'}});
    const fetch=vi.fn(async()=>new Response('encoded',{headers:{'x-format':'fixture'}}));vi.stubGlobal('fetch',fetch);
    expect(await(await readSourceImage(ref)).text()).toBe('decoded');
    expect(decode).toHaveBeenCalledWith(expect.any(Blob),expect.any(Headers),'recipe-1',undefined);expect(fixture.networks.fixture).toBeUndefined();
  });
  it('rejects changed URLs and missing permission before fetching',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);send.mockResolvedValue({ok:true,data:{url:'https://other.test/1.png'}});
    await expect(readSourceImage(ref)).rejects.toThrow('来源已变化');
    send.mockResolvedValue({ok:true,data:{url:ref.expectedUrl,pageUrl:url}});vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    await expect(readSourceImage(ref)).rejects.toThrow('授权');expect(fetch).not.toHaveBeenCalled();
  });
  it('resolves dynamic image headers only after URL and permission authorization',async()=>{
    const headers=vi.fn(()=>({}));fixture.images.fixture={headers};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('pixels')));
    send.mockResolvedValue({ok:true,data:{url:'https://other.test/1.png',sourceId:'fixture'}});
    await expect(readSourceImage(ref)).rejects.toThrow('来源已变化');expect(headers).not.toHaveBeenCalled();
    send.mockResolvedValue({ok:true,data:{url:ref.expectedUrl,pageUrl:url,sourceId:'fixture'}});
    expect(await(await readSourceImage(ref)).text()).toBe('pixels');expect(headers).toHaveBeenCalledWith(ref.expectedUrl);
  });
  it('reads a canvas handle without asking for a pseudo-origin permission',async()=>{
    send.mockResolvedValue({ok:true,data:{url:'page-image:canvas',data:'data:image/png;base64,YQ=='}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('pixels')));
    expect(await(await readSourceImage({...ref,expectedUrl:'page-image:canvas'})).text()).toBe('pixels');expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });
});
