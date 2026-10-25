import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fetchSourceImage} from '../src/sources/runtime/image-fetch';
import {ImagePermissionsRequired} from '../src/sources/runtime/permissions';
import {createSourceNetworkContext} from '../src/sources/runtime/http';
vi.mock('../src/sources/runtime/image-headers',()=>({withImageHeaders:async(_url:string,_headers:unknown,_signal:unknown,read:()=>Promise<unknown>)=>read()}));
const page='https://reader.test/chapter/1',url='https://cdn.test/image.png';
const context={pageUrl:page,safariTransport:'public-native' as const};
let native:ReturnType<typeof vi.fn>,fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  native=vi.fn(async(_app,message)=>message.type==='source-read-open'
    ?{status:200,length:3,headers:{'content-type':'image/png'}}
    :message.type==='source-read-read'?{data:'YWJj'}:{closed:true});
  fetchMock=vi.fn(async()=>new Response('browser'));
  vi.stubGlobal('fetch',fetchMock);
  vi.stubGlobal('navigator',{locks:{request:async(_name:string,_options:unknown,callback:any)=>callback({})}});
  vi.stubGlobal('chrome',{runtime:{id:'fixture',getURL:()=> 'safari-web-extension://fixture/',sendNativeMessage:native},permissions:{contains:vi.fn(async()=>true)}});
});
afterEach(()=>vi.unstubAllGlobals());
const opened=()=>native.mock.calls.filter(([,m])=>m.type==='source-read-open').map(([,m])=>m);
const reads=()=>native.mock.calls.filter(([,m])=>m.type==='source-read-read').map(([,m])=>m);
const closes=()=>native.mock.calls.filter(([,m])=>m.type==='source-read-close').map(([,m])=>m);

it('uses native only for an explicitly configured Safari source',async()=>{
  expect(await(await fetchSourceImage(url)).blob.text()).toBe('browser');
  chrome.runtime.getURL=()=> 'chrome-extension://fixture/';
  expect(await(await fetchSourceImage(url,undefined,undefined,context)).blob.text()).toBe('browser');
  expect(native).not.toHaveBeenCalled();
});
it('transfers a multi-chunk image without cookies and releases its file',async()=>{
  const bytes=Buffer.alloc(512*1024+57,97);
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:200,length:bytes.length,headers:{'content-type':'image/png'}}:
    m.type==='source-read-read'?{data:bytes.subarray(m.offset,m.offset+512*1024).toString('base64')}:{closed:true});
  const result=await fetchSourceImage(url,undefined,undefined,context);
  expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(bytes);
  expect(opened()).toEqual([{type:'source-read-open',id:expect.any(String),url,referer:'https://reader.test/',kind:'image'}]);
  expect(reads().map(m=>m.offset)).toEqual([0,512*1024]);
  expect(closes()).toHaveLength(1);expect(fetchMock).not.toHaveBeenCalled();
});
it('checks the next host before a native redirect and drops cross-origin overrides',async()=>{
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'
    ?m.url===url?{status:302,length:0,headers:{location:'https://other.test/image'}}:{status:200,length:3,headers:{'content-type':'image/png'}}
    :m.type==='source-read-read'?{data:'YWJj'}:{closed:true});
  await fetchSourceImage(url,undefined,{referer:'https://override.test/'},context);
  expect(opened().map(m=>m.referer)).toEqual(['https://override.test/','https://reader.test/']);
  expect(chrome.permissions.contains).toHaveBeenLastCalledWith({origins:['https://other.test/*']});
  native.mockClear();
  vi.mocked(chrome.permissions.contains).mockImplementation(async p=>!p.origins?.includes('https://other.test/*'));
  await expect(fetchSourceImage(url,undefined,undefined,context)).rejects.toBeInstanceOf(ImagePermissionsRequired);
  expect(opened()).toHaveLength(1);expect(reads()).toHaveLength(0);expect(closes()).toHaveLength(1);
});
it.each([200,403])('rejects a native Cloudflare challenge at HTTP %s before reading bytes',async status=>{
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status,length:0,headers:{'cf-mitigated':'challenge'}}:{closed:true});
  await expect(fetchSourceImage(url,undefined,undefined,context)).rejects.toMatchObject({kind:'verification-required'});
  expect(reads()).toHaveLength(0);expect(opened()).toHaveLength(1);expect(closes()).toHaveLength(1);
});
it('does not retry a native 403 through another transport',async()=>{
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:403,length:0,headers:{}}:{closed:true});
  await expect(fetchSourceImage(url,undefined,undefined,context)).rejects.toMatchObject({details:{status:403}});
  expect(opened()).toHaveLength(1);expect(fetchMock).not.toHaveBeenCalled();expect(closes()).toHaveLength(1);
});
it.each(['oversize','truncated','invalid-base64'])('cleans up an invalid native response: %s',async failure=>{
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:200,length:failure==='oversize'?32*1024*1024+1:3,headers:{'content-type':'image/png'}}:
    m.type==='source-read-read'?{data:failure==='truncated'?'YQ==':'!!!!'}:{closed:true});
  await expect(fetchSourceImage(url,undefined,undefined,context)).rejects.toThrow();
  expect(closes()).toHaveLength(1);
});
it('cancels promptly and cleans up a late native open reply',async()=>{
  let finish!:(value:unknown)=>void;
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?new Promise(resolve=>{finish=resolve;}):{closed:true});
  const controller=new AbortController();
  const result=fetchSourceImage(url,controller.signal,undefined,context);
  const rejected=expect(result).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(opened()).toHaveLength(1));
  controller.abort();await rejected;
  const count=closes().length;
  finish({status:200,length:3,headers:{'content-type':'image/png'}});
  await vi.waitFor(()=>expect(closes().length).toBeGreaterThan(count));
  expect(reads()).toHaveLength(0);
});
it('does not forward unsupported credential headers to native code',async()=>{
  await expect(fetchSourceImage(url,undefined,{Cookie:'fixture'},context)).rejects.toThrow();
  expect(native).not.toHaveBeenCalled();
});

it('supports an explicit public text GET without a native POST or redirect fallback',async()=>{
  const network=createSourceNetworkContext(),options={referer:page,safariTransport:'public-native' as const};
  expect(await network.request(url,options)).toBe('abc');
  expect(opened()[0]).toMatchObject({kind:'text',referer:page});
  native.mockClear();
  await expect(network.request(url,{...options,form:{key:'value'}})).rejects.toMatchObject({kind:'request-denied'});
  expect(native).not.toHaveBeenCalled();
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:302,length:0,headers:{location:'https://elsewhere.test/'}}:{closed:true});
  await expect(network.request(url,options)).rejects.toMatchObject({details:{status:302}});
  expect(opened()).toHaveLength(1);expect(fetchMock).not.toHaveBeenCalled();
});

it('bounds native text responses to 8 MiB and preserves an empty HTTP 200 for its parser',async()=>{
  const options={safariTransport:'public-native' as const};
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:200,length:8*1024*1024+1,headers:{}}:{closed:true});
  await expect(createSourceNetworkContext().request(url,options)).rejects.toThrow();
  expect(reads()).toHaveLength(0);expect(closes()).toHaveLength(1);
  native.mockImplementation(async(_app,m)=>m.type==='source-read-open'?{status:200,length:0,headers:{}}:{closed:true});
  expect(await createSourceNetworkContext().request(url,options)).toBe('');
});
