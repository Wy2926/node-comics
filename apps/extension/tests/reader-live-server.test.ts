import {describe,expect,it,vi} from 'vitest';
import {network} from '../src/sources/sites/asurascans/network';
import {catalogHtml,chapter,directory,image,reader,readerHtml} from '../src/sources/sites/asurascans/tests/fixtures';
import {asuraWork,createReaderLiveHandler,liveOrigin,type LiveCatalog,type LiveManifest,type LivePair} from './reader-live-server';

// Only these unit tests use synthetic SSR; the live entry never reads these fixtures.
const bound = (html:string)=>html.replaceAll('fixture-work-1234abcd','return-of-the-mount-hua-sect-11fe7da3').replaceAll('fixture-work','return-of-the-mount-hua-sect');
const html = (body:string)=>new Response(body,{headers:{'content-type':'text/html'}});
const request = (path:string,init?:RequestInit)=>new Request(liveOrigin+'/__reader_live/'+path,init);
function harness(imageResponse=async()=>new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}})) {
  const fetcher = vi.fn(async(input:URL|RequestInfo)=>{
    const url=String(input);
    if(url===asuraWork)return html(bound(catalogHtml({...directory(),chapters:[chapter(3),chapter(2),chapter(1)]})));
    const number=url.match(/\/chapter\/([123])$/)?.[1];
    if(number)return html(bound(readerHtml({...reader(),chapterNumber:Number(number)})));
    if(url===image)return imageResponse();
    throw Error('Unexpected network request');
  });
  return {fetcher,handle:createReaderLiveHandler(async()=>network,fetcher as typeof fetch)};
}

describe('isolated live-reader transport',()=>{
  it('uses production catalog/pages parsing and registers only discovered image routes',async()=>{
    const {handle,fetcher}=harness();
    expect((await handle(request('image/1/0'))).status).toBe(403);
    const catalog=await (await handle(request('catalog'))).json() as LiveCatalog;
    expect(catalog.entries.map(entry=>entry.chapter)).toEqual(['1','2','3']);
    const manifest=await (await handle(request('pages/1'))).json() as LiveManifest;
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.pages[0]).toMatchObject({width:900,height:16000,url:'/__reader_live/image/1/0'});
    expect(manifest.pages[0].key).toMatch(/^inline-original:reader-live:asura:1:/);
    expect((await handle(request('image/1/0'))).status).toBe(200);
    expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual([asuraWork,asuraWork+'/chapter/1',image]);
  });

  it.each(['pages/4','pages/01','image/1/2000','catalog?url=https://example.com','sample/mono/../../secret','disabled-api/jobs'])('rejects unregistered route %s without external I/O',async path=>{
    const {handle,fetcher}=harness();
    expect((await handle(request(path))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects writes and foreign-origin callers, and does not forward credentials',async()=>{
    const {handle,fetcher}=harness();
    expect((await handle(request('catalog',{method:'POST'}))).status).toBe(403);
    expect((await handle(request('catalog',{headers:{Origin:'https://example.com'}}))).status).toBe(403);
    expect((await handle(request('catalog',{headers:{Cookie:'private=test',Authorization:'Bearer private'}}))).status).toBe(200);
    const options=(fetcher.mock.calls[0] as unknown as [string,RequestInit])[1];
    expect(options).toMatchObject({method:'GET',redirect:'manual',headers:{Accept:'text/html',Referer:asuraWork}});
    expect(Object.keys(options.headers!)).toEqual(['Accept','Referer']);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ()=>new Response('',{status:302,headers:{Location:'https://example.com'}}),
    ()=>new Response('challenge',{headers:{'content-type':'text/html','cf-mitigated':'challenge'}}),
    ()=>new Response('too large',{headers:{'content-type':'text/html','content-length':String(9*1024**2)}}),
  ])('refuses redirects, challenges and oversized HTML',async response=>{
    const fetcher=vi.fn(async()=>response());
    const handle=createReaderLiveHandler(async()=>network,fetcher);
    expect((await handle(request('catalog'))).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('limits actual streamed image bytes and rejects image-route HTML',async()=>{
    for(const response of [
      ()=>new Response('challenge',{headers:{'content-type':'text/html'}}),
      ()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(33*1024**2));controller.close();}}),{headers:{'content-type':'image/png'}}),
    ]) {
      const {handle}=harness(async()=>response());
      await handle(request('pages/1'));
      expect((await handle(request('image/1/0'))).status).toBe(502);
    }
  });

  it('queues ordinary reader/thumbnail demand at two requests instead of fabricating 502s',async()=>{
    let active=0,maximum=0;
    const {handle}=harness(async()=>{
      maximum=Math.max(maximum,++active);
      await new Promise(resolve=>setTimeout(resolve,2));
      active--;
      return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
    });
    await handle(request('pages/1'));
    expect((await Promise.all(Array.from({length:11},()=>handle(request('image/1/0'))))).map(response=>response.status)).toEqual(Array(11).fill(200));
    expect(maximum).toBe(2);
  });

  it('serves only the two independently paired, already-generated local samples',async()=>{
    const {handle,fetcher}=harness();
    const pairs=await (await handle(request('pairs'))).json() as LivePair[];
    expect(pairs.map(pair=>[pair.id,pair.language,pair.width,pair.height])).toEqual([['mono','zh-Hans',836,1189],['color','en',1129,1602]]);
    for(const pair of pairs)for(const path of [pair.original,pair.translated]){
      const response=await handle(new Request(liveOrigin+path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^image\//);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
