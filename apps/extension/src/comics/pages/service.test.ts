import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({records: new Map<string, unknown>(), cache: new Map<string, Blob>(),
  sourceImage: vi.fn(), refresh:vi.fn(), prepare: vi.fn(), put: vi.fn(),
  token: vi.fn(), cacheGet: vi.fn(), cachePut: vi.fn(), downloadGet:vi.fn(), openContainer:vi.fn(), epubImage:vi.fn(),
}));
vi.mock('../repositories', () => ({catalog: {
  get: async (table: string, id: unknown) => mocks.records.get(JSON.stringify([table,id])),
  putMaterialization: (value: {id: string}, generation: number) => mocks.put(value,generation),
}}));
vi.mock('../../sources', () => ({readSourceImage: mocks.sourceImage,ImagePermissionsRequired:class extends Error{}}));
vi.mock('../application/website-content',()=>({refreshWebsitePage:mocks.refresh}));
vi.mock('./normalize', () => ({prepareComicPage: mocks.prepare}));
vi.mock('../sources/local', () => ({openContainer: mocks.openContainer}));
vi.mock('../formats', () => ({openDocument: vi.fn()}));
vi.mock('../formats/epub', () => ({readEpubImage: mocks.epubImage}));
vi.mock('../../storage/downloads', async original => ({...await original<typeof import('../../storage/downloads')>(),downloadStore: {get: mocks.downloadGet}}));
vi.mock('../../storage/source-pages', () => ({sourcePageCache: {
  token: mocks.token, get: mocks.cacheGet, put: mocks.cachePut,
}}));
import {acquirePage,promotePage,downloadKey,materializationId,onPageImageMetadata,type PageLease} from './service';
import {PagePreview,type PagePreviewTarget} from './preview';
import {PDF_RENDER_PROFILE,RENDER_PROFILE,pageReference,parsePageReference} from './identity';
import {ReaderImagePrefetch} from '../../reader/image-prefetch';
import {SourceDatabaseSchemaError} from '../../storage/database';
import {registerSourceDriver} from '../sources/registry';
import {ImagePermissionsRequired} from '../../sources';
import {openDocument} from '../formats';
let unregisterLocal: (()=>void)|undefined;
const request = {entryId: 'document', contentId: 'revision', pageId: 'page', renderProfileId: RENDER_PROFILE};
const put = (table: string, id: unknown, value: unknown) => mocks.records.set(JSON.stringify([table,id]), value);
const renewable=()=>{
  const page={contentId:'revision',pageId:'page',name:'1',ordinal:0,locator:{url:'https://image.example/page.png',sourceId:'source-page',manifestId:'manifest',contentKey:'stable-content'}};
  put('pageDescriptors',['revision','page'],page);return page;
};
function queuedPage(pageId:string){
  put('pageDescriptors',['revision',pageId],{name:pageId,ordinal:0,locator:{url:`https://image.example/${pageId}.png`,sourceId:pageId,manifestId:'manifest'}});
  return {...request,pageId};
}
function controlledReads(){
  const waiting=new Map<string,{resolve:(blob:Blob)=>void;signal:AbortSignal}>(),started:string[]=[];
  let active=0,maximum=0;
  mocks.sourceImage.mockImplementation(({pageId}:{pageId:string},signal:AbortSignal)=>{
    started.push(pageId);maximum=Math.max(maximum,++active);
    return new Promise<Blob>((resolve,reject)=>{
      waiting.set(pageId,{resolve,signal});
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }).finally(()=>{active--;});
  });
  return {started,waiting,get maximum(){return maximum;},finish(pageId:string){waiting.get(pageId)!.resolve(new Blob([pageId],{type:'image/png'}));}};
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.records.clear(); mocks.cache.clear();
  unregisterLocal=registerSourceDriver({id:'local',label:'Local test source',cachePages:false,cacheRanges:false,
    open:({containerId})=>mocks.openContainer(containerId)});
  mocks.token.mockResolvedValue({epoch:1});mocks.cacheGet.mockImplementation(async(key:string)=>mocks.cache.get(key));
  mocks.cachePut.mockImplementation(async(key:string,blob:Blob)=>{mocks.cache.set(key,blob);return true;});
  mocks.downloadGet.mockResolvedValue(undefined);
  put('entries','document',{id:'document',comicId:'comic',contentId:'revision',generation:1,format:'website'});

  put('pageDescriptors',['revision','page'],{name: '1', ordinal: 0, locator: {url: 'https://image.example/page.png', sourceId: 'source-page', manifestId: 'manifest', kind: 'image'}});
  put('comics','comic',{id:'comic',source:{generation:1,connectionId:'connection',status:'active'}}); put('connections','connection',{id: 'connection',generation:1,provider: 'website',status: 'connected'});
  mocks.sourceImage.mockResolvedValue(new Blob(['pixels'],{type:'image/png'}));
  mocks.prepare.mockImplementation(async ({blob}: {blob: Blob}) => ({blob,width:100,height:200,imageSha256:'a'.repeat(64)}));
  mocks.put.mockImplementation(async (value: {id:string}) => {put('materializations',value.id,value);return true;});
});
afterEach(()=>{unregisterLocal?.();});
describe('page leases and trusted source routing', () => {
  it('publishes preview dimensions before pixels without persisting or inventing a materialized identity',async()=>{
    const download=Promise.withResolvers<Blob>(),metadata=vi.fn(),preview:PagePreviewTarget={active:()=>true,draw:vi.fn(),clear:vi.fn()};
    const unsubscribe=onPageImageMetadata(metadata),brokenSubscriber=onPageImageMetadata(()=>{throw Error('Detached UI');});
    vi.stubGlobal('ImageDecoder',class {
      completed=Promise.resolve();close=vi.fn();
      decode=async()=>({image:{displayWidth:100,displayHeight:200,close:vi.fn()},complete:true});
    });
    mocks.sourceImage.mockImplementationOnce((_request,_signal,progress)=>{progress({chunks:[new Uint8Array([255,216,255,224,0,0,0,0,0,0,0,0])],done:false});return download.promise;});
    let lease:PageLease|undefined;
    try{
      const reading=acquirePage({...request,purpose:'reading',preview});
      await vi.waitFor(()=>expect(preview.draw).toHaveBeenCalledOnce());
      expect(metadata).toHaveBeenCalledExactlyOnceWith({contentId:request.contentId,pageId:request.pageId,renderProfileId:request.renderProfileId,width:100,height:200});
      expect(metadata.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(preview.draw).mock.invocationCallOrder[0]);
      expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
      download.resolve(new Blob(['pixels'],{type:'image/png'}));lease=await reading;
      expect(metadata).toHaveBeenCalledTimes(2);expect(metadata).toHaveBeenLastCalledWith(lease.identity);
      expect(mocks.sourceImage).toHaveBeenCalledOnce();expect(mocks.put).toHaveBeenCalledOnce();
    }finally{lease?.release();unsubscribe();brokenSubscriber();vi.unstubAllGlobals();}
  });
  it('shares a live preview with an authorized reader joining prefetch and keeps the download after that reader cancels',async()=>{
    let resolve!:(blob:Blob)=>void;const waiting=new Promise<Blob>(done=>{resolve=done;});mocks.sourceImage.mockReturnValueOnce(waiting);
    const add=vi.spyOn(PagePreview.prototype,'add');
    const background=acquirePage({...request,priority:'prefetch'});await vi.waitFor(()=>expect(mocks.sourceImage).toHaveBeenCalledOnce());
    const controller=new AbortController(),preview:PagePreviewTarget={active:()=>true,draw:vi.fn(),clear:vi.fn()};
    const visible=acquirePage({...request,purpose:'reading',signal:controller.signal,preview});const rejected=expect(visible).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(add).toHaveBeenCalledWith(preview));controller.abort();await rejected;
    expect(mocks.sourceImage.mock.calls[0][1].aborted).toBe(false);
    resolve(new Blob(['pixels'],{type:'image/png'}));const lease=await background;lease.release();expect(mocks.sourceImage).toHaveBeenCalledOnce();add.mockRestore();
  });
  it('does not attach a joining preview after source access is revoked',async()=>{
    let resolve!:(blob:Blob)=>void;mocks.sourceImage.mockReturnValueOnce(new Promise<Blob>(done=>{resolve=done;}));
    const add=vi.spyOn(PagePreview.prototype,'add'),background=acquirePage({...request,priority:'prefetch'});const failedBackground=expect(background).rejects.toThrow('来源');
    await vi.waitFor(()=>expect(mocks.sourceImage).toHaveBeenCalledOnce());
    put('connections','connection',{id:'connection',generation:2,provider:'website',status:'revoked'});
    const preview:PagePreviewTarget={active:()=>true,draw:vi.fn(),clear:vi.fn()},visible=acquirePage({...request,purpose:'reading',preview});const failedVisible=expect(visible).rejects.toThrow('来源');
    for(let n=0;n<12;n++)await Promise.resolve();expect(add).not.toHaveBeenCalled();
    resolve(new Blob(['pixels'],{type:'image/png'}));await Promise.all([failedBackground,failedVisible]);expect(preview.draw).not.toHaveBeenCalled();add.mockRestore();
  });
  it('routes EPUB artwork through the shared original pipeline without rasterizing text or storing fake page descriptors', async () => {
    const image = new Blob(['epub pixels'], {type: 'image/png'});
    put('entries', 'document', {id:'document',comicId:'comic',contentId:'revision',containerId:'container',generation:1,format:'epub',document:{kind:'epub',images:[{href:'OPS/art.png',mediaType:'image/png'}]}});
    put('connections', 'connection', {id:'connection',generation:1,provider:'local',status:'connected'});
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.openContainer.mockResolvedValue({snapshot:{identity:'source',version:'1',size:100,local:true},close});
    mocks.epubImage.mockResolvedValue(image);
    const ref = {...request, pageId:'epub-image:OPS/art.png'};
    const lease = await acquirePage(ref);
    expect(lease.blob).toBe(image);
    expect(mocks.epubImage).toHaveBeenCalledWith(expect.objectContaining({snapshot:expect.any(Object)}), 'OPS/art.png', expect.any(AbortSignal));
    expect(mocks.prepare).toHaveBeenCalledWith({name:'art.png',blob:image},expect.any(AbortSignal));
    expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({pageId:ref.pageId,imageSha256:'a'.repeat(64)}),1);
    expect(openDocument).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    lease.release();
    for (const pageId of ['epub-image:OPS/chapter.xhtml','epub-image:https://outside.test/art.png','epub-image:OPS/missing.png'])
      await expect(acquirePage({...request,pageId})).rejects.toThrow('页面已移除');
    expect(mocks.epubImage).toHaveBeenCalledOnce();
    put('connections', 'connection', {id:'connection',generation:2,provider:'local',status:'revoked'});
    await expect(acquirePage(ref)).rejects.toThrow('来源访问已断开');
  });
  it('materializes the current PDF profile without reusing retained bytes or metadata from the old profile',async()=>{
    put('entries','document',{id:'document',comicId:'comic',contentId:'revision',containerId:'container',generation:1,format:'pdf'});
    put('connections','connection',{id:'connection',generation:1,provider:'local',status:'connected'});
    const current={...request,renderProfileId:PDF_RENDER_PROFILE},oldBlob=new Blob(['old'],{type:'image/png'}),newBlob=new Blob(['new'],{type:'image/png'});
    const oldId=materializationId(request),oldIdentity={id:oldId,imageSha256:'b'.repeat(64),width:100,height:200,byteSize:oldBlob.size,mime:oldBlob.type};
    put('materializations',oldId,oldIdentity);mocks.cache.set(pageReference(request),oldBlob);
    mocks.downloadGet.mockImplementation(async key=>key===downloadKey(request.contentId,request.pageId)?oldBlob:undefined);
    const close=vi.fn().mockResolvedValue(undefined),materialize=vi.fn().mockResolvedValue(newBlob);
    mocks.openContainer.mockResolvedValue({snapshot:{identity:'source',version:'1',size:100,local:true},close});
    vi.mocked(openDocument).mockResolvedValue({capabilities:{access:'random',remote:false,encrypted:false,multiVolume:false,indexComplete:true},index:vi.fn(),materialize,close:vi.fn().mockResolvedValue(undefined)});
    const lease=await acquirePage(current);try{expect(lease.blob).toBe(newBlob);expect(lease.identity.renderProfileId).toBe(PDF_RENDER_PROFILE);expect(materialize).toHaveBeenCalledOnce();}
    finally{lease.release();}
    expect(mocks.downloadGet).toHaveBeenCalledWith(downloadKey(request.contentId,request.pageId,PDF_RENDER_PROFILE));
    expect(mocks.records.get(JSON.stringify(['materializations',oldId]))).toBe(oldIdentity);expect(mocks.cache.get(pageReference(request))).toBe(oldBlob);
    expect(mocks.records.get(JSON.stringify(['materializations',materializationId(current)]))).toMatchObject({imageSha256:'a'.repeat(64)});
    await expect(acquirePage(request)).rejects.toThrow('渲染版本');
  });
  it('validates manifest membership and reuses normalized cached pixels without decoding or hashing again', async () => {
    renewable();
    const first = await acquirePage(request); first.release();
    expect(mocks.sourceImage).toHaveBeenCalledWith({manifestId:'manifest',pageId:'source-page',expectedUrl:'https://image.example/page.png'},expect.any(AbortSignal),expect.any(Function));
    const second = await acquirePage(request); second.release();
    expect(mocks.sourceImage).toHaveBeenCalledTimes(1); expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('reads retained renewable pages without contacting the source or renewing its manifest',async()=>{
    renewable();mocks.downloadGet.mockResolvedValueOnce(new Blob(['retained'],{type:'image/png'}));
    const lease=await acquirePage(request);lease.release();
    expect(mocks.sourceImage).not.toHaveBeenCalled();expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('renews a failed renewable image once and retries the same page with its fresh locator',async()=>{
    const page=renewable(),next={...page,locator:{...page.locator,manifestId:'renewed',url:'https://new.example/page.png'}};
    mocks.sourceImage.mockRejectedValueOnce(Error('expired CDN'));
    mocks.refresh.mockResolvedValueOnce(next);
    const lease=await acquirePage(request);lease.release();
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({id:'document',contentId:'revision'}),page,expect.any(AbortSignal));
    expect(mocks.sourceImage).toHaveBeenCalledTimes(2);
    expect(mocks.sourceImage).toHaveBeenLastCalledWith({manifestId:'renewed',pageId:'source-page',expectedUrl:'https://new.example/page.png'},expect.any(AbortSignal),expect.any(Function));
  });
  it('does not loop when the renewed image also fails',async()=>{
    const page=renewable();mocks.refresh.mockResolvedValueOnce(page);
    mocks.sourceImage.mockRejectedValueOnce(Error('expired')).mockRejectedValueOnce(Error('still unavailable'));
    await expect(acquirePage(request)).rejects.toThrow('still unavailable');
    expect(mocks.refresh).toHaveBeenCalledOnce();expect(mocks.sourceImage).toHaveBeenCalledTimes(2);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('does not read or publish a changed page when renewal fails',async()=>{
    renewable();mocks.sourceImage.mockRejectedValueOnce(Error('expired'));
    mocks.refresh.mockRejectedValueOnce(Error('来源内容已变化'));
    await expect(acquirePage(request)).rejects.toThrow('内容已变化');
    expect(mocks.sourceImage).toHaveBeenCalledOnce();expect(mocks.put).not.toHaveBeenCalled();expect(mocks.cache.size).toBe(0);
  });
  it.each([new ImagePermissionsRequired(),Object.assign(Error('rate limited'),{details:{status:429}}),Object.assign(Error('back off'),{details:{status:503,retryAfter:60}}),new SourceDatabaseSchemaError('source','缺表')])('does not renew on permissions, rate limiting or schema failures: %s',async error=>{
    renewable();mocks.sourceImage.mockRejectedValueOnce(error);
    await expect(acquirePage(request)).rejects.toBe(error);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('does not renew a cancelled image request',async()=>{
    renewable();const controller=new AbortController();
    mocks.sourceImage.mockImplementationOnce(async()=>{controller.abort();throw controller.signal.reason;});
    await expect(acquirePage({...request,signal:controller.signal})).rejects.toThrow();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('propagates source authorization failures without publishing bytes', async()=>{
    mocks.sourceImage.mockRejectedValueOnce(Error('图片来源已变化'));
    await expect(acquirePage(request)).rejects.toThrow('来源已变化');
    expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.cache.size).toBe(0);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('does not publish cache or return a late page after its generation was removed', async () => {
    mocks.put.mockResolvedValue(false);
    await expect(acquirePage(request)).rejects.toThrow('内容已变化'); expect(mocks.cache.size).toBe(0);
  });
  it('refuses cached or newly-read pages when access is revoked before delivery', async () => {
    mocks.prepare.mockImplementation(async({blob}:{blob:Blob})=>{put('comics','comic',{id:'comic',source:{generation:2,connectionId:'connection',status:'revoked'}});return {blob,width:100,height:200,imageSha256:'a'.repeat(64)};});
    await expect(acquirePage(request)).rejects.toThrow('访问被撤销');expect(mocks.cache.size).toBe(0);expect(mocks.put).not.toHaveBeenCalled();
    await expect(acquirePage(request)).rejects.toThrow('访问已断开');
  });
  it('one consumer cancellation leaves another consumer’s shared page request alive', async () => {
    let resolve!: (blob:Blob)=>void;
    mocks.sourceImage.mockImplementation(() => new Promise<Blob>(done => {resolve=done;}));
    const controller = new AbortController();
    const first = acquirePage({...request,signal:controller.signal,priority:'prefetch'});
    const second = acquirePage({...request,priority:'current'});
    await vi.waitFor(() => expect(mocks.sourceImage).toHaveBeenCalledOnce());
    controller.abort(); await expect(first).rejects.toThrow();
    expect(mocks.sourceImage.mock.calls[0][1].aborted).toBe(false);
    resolve(new Blob(['pixels'],{type:'image/png'})); const lease = await second; lease.release();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it.each(['held','inflight'] as const)('hands off %s next-chapter prefetch through real page leases with disk caching disabled',async state=>{
    vi.useFakeTimers();
    const unregister=registerSourceDriver({id:'website',label:'Uncached test source',cachePages:false,cacheRanges:false});
    const reads=controlledReads(),requests:Promise<PageLease>[]=[];
    const foregroundController=new AbortController(),reopenController=new AbortController();
    const manager=new ReaderImagePrefetch((key,signal,priority)=>{
      const work=acquirePage({...parsePageReference(key)!,signal,priority,purpose:'reading'});
      requests.push(work);return work;
    });
    try{
      const current={...request,entryId:'chapter-a',contentId:'revision-a',pageId:'last'};
      const next={...request,entryId:'chapter-b',contentId:'revision-b',pageId:'first'};
      for(const ref of [current,next]){
        put('entries',ref.entryId,{id:ref.entryId,comicId:'comic',contentId:ref.contentId,generation:1,format:'website'});
        put('pageDescriptors',[ref.contentId,ref.pageId],{name:ref.pageId,ordinal:0,locator:{url:`https://image.example/${ref.entryId}/${ref.pageId}.png`,sourceId:`${ref.entryId}-${ref.pageId}`,manifestId:'manifest'}});
      }
      const currentKey=pageReference(current),nextKey=pageReference(next);
      const identities=new Map([current,next].map(ref=>[pageReference(ref),JSON.stringify([ref.entryId,ref.contentId,1,ref.pageId])]));
      const options={scope:'reader/comic/original',identities,current:[currentKey],next:[nextKey],ready:true,enabled:true};
      manager.update(options);await vi.advanceTimersByTimeAsync(150);
      expect(reads.started).toEqual(['chapter-b-first']);
      if(state==='held'){reads.finish('chapter-b-first');await requests[0];await vi.advanceTimersByTimeAsync(0);}
      const sourceSignal=reads.waiting.get('chapter-b-first')!.signal;
      manager.update({...options,current:[nextKey],next:[],ready:false});
      expect(sourceSignal.aborted).toBe(false);
      const foreground=acquirePage({...next,signal:foregroundController.signal,priority:'current'});requests.push(foreground);
      if(state==='inflight')reads.finish('chapter-b-first');
      const [prefetched,visible]=await Promise.all([requests[0],foreground]);
      expect(visible.blob).toBe(prefetched.blob);
      expect(mocks.sourceImage).toHaveBeenCalledOnce();expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.cacheGet).not.toHaveBeenCalled();expect(mocks.cachePut).not.toHaveBeenCalled();
      manager.update({...options,current:[nextKey],next:[],ready:true});
      manager.dispose();expect(sourceSignal.aborted).toBe(false);
      visible.release();expect(sourceSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(0);expect(vi.getTimerCount()).toBe(0);
      // A fresh read after every lease is released proves the service removed the shared pending entry.
      const reopened=acquirePage({...next,signal:reopenController.signal});requests.push(reopened);
      await vi.advanceTimersByTimeAsync(0);expect(mocks.sourceImage).toHaveBeenCalledTimes(2);
      reads.finish('chapter-b-first');const fresh=await reopened;
      expect(fresh.blob).not.toBe(visible.blob);fresh.release();
      expect(reads.waiting.get('chapter-b-first')!.signal.aborted).toBe(true);
      expect(mocks.cacheGet).not.toHaveBeenCalled();expect(mocks.cachePut).not.toHaveBeenCalled();
    }finally{
      manager.dispose();foregroundController.abort();reopenController.abort();
      for(const result of await Promise.allSettled(requests))if(result.status==='fulfilled')result.value.release();
      unregister();vi.useRealTimers();
    }
  });
  it.each(['prefetch','background'] as const)('promotes a queued %s request when a default foreground reader joins without another source read',async priority=>{
    const reads=controlledReads();
    const a=acquirePage(queuedPage('active-a')),b=acquirePage(queuedPage('active-b'));
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b']));
    const earlier=acquirePage({...queuedPage('earlier'),priority:'prefetch'});
    const target=queuedPage('target'),speculative=acquirePage({...target,priority}),foreground=acquirePage(target);
    expect(reads.started).toHaveLength(2);
    reads.finish('active-a');const aLease=await a;
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b','target']));
    reads.finish('target');const [speculativeLease,foregroundLease]=await Promise.all([speculative,foreground]);
    expect(speculativeLease.blob).toBe(foregroundLease.blob);
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b','target','earlier']));
    reads.finish('earlier');reads.finish('active-b');const [earlierLease,bLease]=await Promise.all([earlier,b]);
    expect(reads.maximum).toBe(2);
    for(const lease of [aLease,bLease,earlierLease,speculativeLease,foregroundLease])lease.release();
    expect(reads.started.filter(id=>id==='target')).toHaveLength(1);
  });
  it('never downgrades a queued foreground request when a background consumer joins',async()=>{
    const reads=controlledReads(),a=acquirePage(queuedPage('active-a')),b=acquirePage(queuedPage('active-b'));
    await vi.waitFor(()=>expect(reads.started).toHaveLength(2));
    const earlier=acquirePage({...queuedPage('earlier'),priority:'prefetch'}),target=queuedPage('target');
    const foreground=acquirePage({...target,priority:'current'}),background=acquirePage({...target,priority:'background'});
    reads.finish('active-a');const aLease=await a;
    await vi.waitFor(()=>expect(reads.started[2]).toBe('target'));
    reads.finish('target');const leases=await Promise.all([foreground,background]);
    await vi.waitFor(()=>expect(reads.started[3]).toBe('earlier'));
    reads.finish('active-b');reads.finish('earlier');leases.push(aLease,...await Promise.all([b,earlier]));
    for(const lease of leases)lease.release();
  });
  it('promotes a mounted queued page without another lease, source read or concurrency slot',async()=>{
    const reads=controlledReads(),a=acquirePage(queuedPage('active-a')),b=acquirePage(queuedPage('active-b'));
    await vi.waitFor(()=>expect(reads.started).toHaveLength(2));
    const earlier=acquirePage({...queuedPage('earlier'),priority:'prefetch'}),target=queuedPage('target');
    const visible=acquirePage({...target,priority:'prefetch'});
    promotePage(queuedPage('absent'));promotePage(target);promotePage(target);
    reads.finish('active-a');const aLease=await a;
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b','target']));
    reads.finish('target');const lease=await visible;lease.release();
    expect(reads.waiting.get('target')!.signal.aborted).toBe(true);
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b','target','earlier']));
    reads.finish('earlier');reads.finish('active-b');for(const value of [aLease,...await Promise.all([earlier,b])])value.release();
    expect(reads.maximum).toBe(2);
  });
  it.each(['prefetch','current'] as const)('keeps a promoted shared read alive after its %s consumer cancels while queued',async canceled=>{
    const reads=controlledReads(),a=acquirePage(queuedPage('active-a')),b=acquirePage(queuedPage('active-b'));
    await vi.waitFor(()=>expect(reads.started).toHaveLength(2));
    const prefetchController=new AbortController(),currentController=new AbortController(),target=queuedPage('target');
    const speculative=acquirePage({...target,priority:'prefetch',signal:prefetchController.signal});
    const foreground=acquirePage({...target,priority:'current',signal:currentController.signal});
    const rejected=canceled==='prefetch'?speculative:foreground,surviving=canceled==='prefetch'?foreground:speculative;
    const abortResult=expect(rejected).rejects.toMatchObject({name:'AbortError'});
    (canceled==='prefetch'?prefetchController:currentController).abort();await abortResult;
    reads.finish('active-a');const aLease=await a;
    await vi.waitFor(()=>expect(reads.started[2]).toBe('target'));
    expect(reads.waiting.get('target')!.signal.aborted).toBe(false);
    reads.finish('target');const targetLease=await surviving;
    reads.finish('active-b');const bLease=await b;
    expect(reads.started.filter(id=>id==='target')).toHaveLength(1);expect(reads.maximum).toBe(2);
    for(const lease of [aLease,bLease,targetLease])lease.release();
    expect(reads.waiting.get('target')!.signal.aborted).toBe(true);
  });
  it('does not read a promoted queued page after all consumers cancel and still drains following work',async()=>{
    const reads=controlledReads(),a=acquirePage(queuedPage('active-a')),b=acquirePage(queuedPage('active-b'));
    await vi.waitFor(()=>expect(reads.started).toHaveLength(2));
    const controller=new AbortController(),target=queuedPage('target');
    const speculative=acquirePage({...target,priority:'prefetch',signal:controller.signal}),foreground=acquirePage({...target,signal:controller.signal});
    const first=expect(speculative).rejects.toMatchObject({name:'AbortError'}),second=expect(foreground).rejects.toMatchObject({name:'AbortError'});
    controller.abort();await Promise.all([first,second]);
    const following=acquirePage({...queuedPage('following'),priority:'background'});
    reads.finish('active-a');const aLease=await a;
    await vi.waitFor(()=>expect(reads.started).toEqual(['active-a','active-b','following']));
    reads.finish('following');reads.finish('active-b');const leases=await Promise.all([following,b]);
    for(const lease of [aLease,...leases])lease.release();
  });
  it('delivers source pixels when cache reads and token acquisition fail', async()=>{
    mocks.token.mockRejectedValue(Error('cache unavailable'));mocks.cacheGet.mockRejectedValue(Error('cache unavailable'));mocks.downloadGet.mockRejectedValue(Error('download store unavailable'));
    const lease=await acquirePage(request);
    expect(await lease.blob.text()).toBe('pixels');expect(mocks.cachePut).not.toHaveBeenCalled();lease.release();
  });
  it('delivers source pixels despite rejected cache writes and materialization quota exhaustion',async()=>{
    mocks.cachePut.mockRejectedValue(new DOMException('full','QuotaExceededError'));mocks.put.mockRejectedValue(new DOMException('full','QuotaExceededError'));
    const lease=await acquirePage(request);expect(lease.identity.imageSha256).toBe('a'.repeat(64));expect(mocks.cachePut).toHaveBeenCalledOnce();lease.release();
  });
  it.each(['token','cacheGet','downloadGet'] as const)('propagates %s schema errors before fetching source pixels',async operation=>{
    const error=new SourceDatabaseSchemaError(operation,'缺少 reservations');
    mocks[operation].mockRejectedValueOnce(error);
    await expect(acquirePage(request)).rejects.toBe(error);
    expect(mocks.sourceImage).not.toHaveBeenCalled();expect(mocks.prepare).not.toHaveBeenCalled();
    // A rejected shared request must be released so a repaired store can be retried.
    const lease=await acquirePage(request);lease.release();expect(mocks.sourceImage).toHaveBeenCalledOnce();
  });
  it('does not treat a broken retained download store as a miss during an explicit download',async()=>{
    const error=new SourceDatabaseSchemaError('downloads','缺少 reservations');mocks.downloadGet.mockRejectedValueOnce(error);
    await expect(acquirePage({...request,purpose:'download'})).rejects.toBe(error);
    expect(mocks.token).not.toHaveBeenCalled();expect(mocks.cacheGet).not.toHaveBeenCalled();expect(mocks.sourceImage).not.toHaveBeenCalled();
  });
  it('propagates schema errors from publishing newly prepared source pixels',async()=>{
    const error=new SourceDatabaseSchemaError('source-pages','缺少 reservations');mocks.cachePut.mockRejectedValueOnce(error);
    await expect(acquirePage(request)).rejects.toBe(error);expect(mocks.sourceImage).toHaveBeenCalledOnce();
  });
  it('does not hide a broken complete-source database behind a remote original replica',async()=>{
    put('entries','document',{id:'document',comicId:'comic',contentId:'revision',containerId:'container',generation:1,format:'cbz'});
    put('connections','connection',{id:'connection',generation:1,provider:'local',status:'connected'});

    put('materializations',JSON.stringify(['revision','page',RENDER_PROFILE]),{imageSha256:'a'.repeat(64)});
    const error=new SourceDatabaseSchemaError('container-bytes','缺少 references');mocks.openContainer.mockRejectedValueOnce(error);
    await expect(acquirePage(request)).rejects.toBe(error);
  });
  it('rechecks source access before sharing an already completed page lease',async()=>{
    const lease=await acquirePage({...request,priority:'prefetch'});
    put('comics','comic',{id:'comic',source:{generation:2,connectionId:'connection',status:'revoked'}});
    await expect(acquirePage({...request,priority:'current'})).rejects.toThrow('访问被撤销');expect(mocks.sourceImage).toHaveBeenCalledOnce();lease.release();
  });
});
