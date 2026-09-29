import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({records: new Map<string, unknown>(), cache: new Map<string, Blob>(),
  sourceImage: vi.fn(), refresh:vi.fn(), prepare: vi.fn(), put: vi.fn(),
  token: vi.fn(), cacheGet: vi.fn(), cachePut: vi.fn(), downloadGet:vi.fn(), openContainer:vi.fn(),
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
vi.mock('../../storage/downloads', () => ({downloadStore: {get: mocks.downloadGet}}));
vi.mock('../../storage/source-pages', () => ({sourcePageCache: {
  token: mocks.token, get: mocks.cacheGet, put: mocks.cachePut,
}}));
import {acquirePage} from './service';
import {RENDER_PROFILE} from './identity';
import {SourceDatabaseSchemaError} from '../../storage/database';
import {registerSourceDriver} from '../sources/registry';
import {ImagePermissionsRequired} from '../../sources';
let unregisterLocal: (()=>void)|undefined;
const request = {entryId: 'document', contentId: 'revision', pageId: 'page', renderProfileId: RENDER_PROFILE};
const put = (table: string, id: unknown, value: unknown) => mocks.records.set(JSON.stringify([table,id]), value);
const renewable=()=>{
  const page={contentId:'revision',pageId:'page',name:'1',ordinal:0,locator:{url:'https://image.example/page.png',sourceId:'source-page',manifestId:'manifest',contentKey:'stable-content'}};
  put('pageDescriptors',['revision','page'],page);return page;
};
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
  it('validates manifest membership and reuses normalized cached pixels without decoding or hashing again', async () => {
    renewable();
    const first = await acquirePage(request); first.release();
    expect(mocks.sourceImage).toHaveBeenCalledWith({manifestId:'manifest',pageId:'source-page',expectedUrl:'https://image.example/page.png'},expect.any(AbortSignal));
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
    expect(mocks.sourceImage).toHaveBeenLastCalledWith({manifestId:'renewed',pageId:'source-page',expectedUrl:'https://new.example/page.png'},expect.any(AbortSignal));
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
    const first = acquirePage({...request,signal:controller.signal});
    const second = acquirePage(request);
    await vi.waitFor(() => expect(mocks.sourceImage).toHaveBeenCalledOnce());
    controller.abort(); await expect(first).rejects.toThrow();
    expect(mocks.sourceImage.mock.calls[0][1].aborted).toBe(false);
    resolve(new Blob(['pixels'],{type:'image/png'})); const lease = await second; lease.release();
    expect(mocks.prepare).toHaveBeenCalledOnce();
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
    const lease=await acquirePage(request);
    put('comics','comic',{id:'comic',source:{generation:2,connectionId:'connection',status:'revoked'}});
    await expect(acquirePage(request)).rejects.toThrow('访问被撤销');expect(mocks.sourceImage).toHaveBeenCalledOnce();lease.release();
  });
});
