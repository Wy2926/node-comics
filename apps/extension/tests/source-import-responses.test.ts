import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {rememberImportResponses,takeImportResponses,forgetImportResponses} from '../src/sources/runtime/import-responses';
import {sourceFor} from '../src/sources';
import {readImportCatalog} from '../src/sources/runtime/import';
import {readNetworkPages} from '../src/sources/runtime/network';
import {catalogHtml,readerHtml,reader,url} from '../src/sources/sites/guazimanhua/tests/fixtures';
const location=sourceFor(reader).location,bound=sourceFor(reader+'#nodelane-guazimanhua=123').location;
const responses=[{url:reader,body:readerHtml()}];
let data:Record<string,unknown>;
let permission:ReturnType<typeof vi.fn<()=>Promise<boolean>>>;
beforeEach(()=>{
  data={};
  permission=vi.fn(async()=>true);
  vi.stubGlobal('navigator',{locks:{request:async(_key:string,run:()=>Promise<unknown>)=>run()}});
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{contains:permission},storage:{
    session:{get:async(key:string)=>structuredClone({[key]:data[key]}),set:async(value:object)=>{Object.assign(data,structuredClone(value));},remove:async(key:string)=>{delete data[key];}},
    local:{set:vi.fn()},
  }});
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

it('hands validated reader HTML from parent discovery to page loading exactly once',async()=>{
  const fetcher=vi.fn(async(target:string)=>new Response(target===reader?readerHtml():catalogHtml()));vi.stubGlobal('fetch',fetcher);
  const source=await readImportCatalog(reader),current=source.entries.find(entry=>entry.id===source.defaultEntryId)!;
  expect(source.url).toBe(url);expect(await readNetworkPages(current.url)).toMatchObject({knownTotal:2});
  expect(fetcher.mock.calls.filter(([target])=>target===reader)).toHaveLength(1);
  await readNetworkPages(current.url);expect(fetcher.mock.calls.filter(([target])=>target===reader)).toHaveLength(2);
});
it('requires the exact source, page and parent identity and expires after thirty seconds',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  await rememberImportResponses(location,bound.catalog!.key,responses);
  for(const wrong of [location,{...bound,sourceId:'foreign'},{...bound,pageKey:'foreign'},{...bound,catalog:{...bound.catalog!,key:'foreign'}}])expect(await takeImportResponses(wrong)).toEqual([]);
  expect(await takeImportResponses(bound)).toEqual(responses);expect(await takeImportResponses(bound)).toEqual([]);
  await rememberImportResponses(location,bound.catalog!.key,responses);vi.setSystemTime(Date.now()+30_000);
  // Expiration prevents reuse; physical deletion happens on the next handoff operation.
  expect(data['nc-import-responses']).toBeDefined();expect(await takeImportResponses(bound)).toEqual([]);expect(data).toEqual({});
});
it('drops permission-revoked responses and honors cancellation without consuming a pending handoff',async()=>{
  await rememberImportResponses(location,bound.catalog!.key,responses);
  const controller=new AbortController();controller.abort();
  await expect(takeImportResponses(bound,controller.signal)).rejects.toThrow();
  permission.mockResolvedValueOnce(false);
  expect(await takeImportResponses(bound)).toEqual([]);expect(await takeImportResponses(bound)).toEqual([]);
});
it('bounds entries and total retained response data, replacing repeated requests',async()=>{
  const large=[{url:reader,body:'x'.repeat(600_000)}];
  for(let i=0;i<5;i++)await rememberImportResponses({...location,pageKey:String(i)},bound.catalog!.key,large);
  expect(JSON.stringify(data).length*2).toBeLessThan(4*1024*1024);
  expect(await takeImportResponses({...bound,pageKey:'0'})).toEqual([]);
  expect(await takeImportResponses({...bound,pageKey:'4'})).toEqual(large);
  await rememberImportResponses(location,bound.catalog!.key,responses);
  await rememberImportResponses(location,bound.catalog!.key,[{url:reader,body:'replacement'}]);
  expect(await takeImportResponses(bound)).toEqual([{url:reader,body:'replacement'}]);
  await rememberImportResponses(location,bound.catalog!.key,[{url:reader,body:'x'.repeat(2*1024*1024)}]);expect(await takeImportResponses(bound)).toEqual([]);
});
it('requires matching URL and Referer for reuse',async()=>{
  const fetcher=vi.fn(async()=>new Response(readerHtml()));vi.stubGlobal('fetch',fetcher);
  for(const response of [{url:reader+'&other=1',body:'invalid'}, {url:reader,referer:url,body:'invalid'}]){
    await rememberImportResponses(location,bound.catalog!.key,[response]);
    await expect(readNetworkPages(bound.url)).resolves.toMatchObject({knownTotal:2});
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('discards pending HTML on failed directory membership or explicit discard',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(readerHtml())));
  const {parseCatalog}=await import('../src/sources/sites/guazimanhua/network');
  await expect(readImportCatalog(reader,async()=>parseCatalog(catalogHtml(['7']),url))).rejects.toThrow();
  expect(await takeImportResponses(bound)).toEqual([]);
  await rememberImportResponses(location,bound.catalog!.key,responses);await forgetImportResponses(location);expect(data).toEqual({});
});
it('falls back to HTTP when session storage is unavailable without masking an import failure',async()=>{
  vi.spyOn(chrome.storage.session,'set').mockRejectedValue(Error('Session quota exceeded'));
  const fetcher=vi.fn(async(target:string)=>new Response(target===reader?readerHtml():catalogHtml()));vi.stubGlobal('fetch',fetcher);
  const source=await readImportCatalog(reader);await readNetworkPages(source.entries.find(entry=>entry.id===source.defaultEntryId)!.url);
  expect(fetcher.mock.calls.filter(([target])=>target===reader)).toHaveLength(2);
  vi.spyOn(chrome.storage.session,'get').mockRejectedValue(Error('Session unavailable'));
  await expect(readImportCatalog(reader,async()=>{throw Error('Catalog offline');})).rejects.toThrow('Catalog offline');
});
