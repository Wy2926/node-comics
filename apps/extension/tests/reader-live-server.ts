import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {RequestPool} from '../src/concurrency';
import type {SourceNetwork} from '../src/sources/contracts/network';

export const liveOrigin = 'http://127.0.0.1:5199';
export const asuraWork = 'https://asurascans.com/comics/return-of-the-mount-hua-sect-11fe7da3';
const chapters = ['1', '2', '3'];
const htmlLimit = 8 * 1024 ** 2, imageLimit = 32 * 1024 ** 2;
export interface LiveCatalog {title:string;url:string;entries:{id:string;title:string;chapter:string}[]}
export interface LivePage {id:string;name:string;width:number;height:number;key:string;url:string}
export interface LiveManifest {title:string;pages:LivePage[]}
export interface LivePair {id:string;title:string;language:string;width:number;height:number;original:string;translated:string}
// Already-generated website examples, not Asura results and not a translation-service simulation.
const pairs = [
  {id:'mono',title:'黑白 · 日文原图 → 简体中文实测译图',language:'zh-Hans',width:836,height:1189,original:'mono-original.png',translated:'mono-zh-CN.webp'},
  {id:'color',title:'彩色 · 繁中原图 → 英文实测译图',language:'en',width:1129,height:1602,original:'color-original.jpg',translated:'color-en.webp'},
] satisfies LivePair[];

function allowedImage(value:string) {
  const url = new URL(value);
  return url.origin === 'https://cdn.asurascans.com' && !url.username && !url.password && !url.hash &&
    /^\/asura-images\/chapters\/.+\.(png|jpe?g|webp|avif)$/i.test(url.pathname);
}

/** Only this test's four HTML URLs and parser-bound CDN images can leave loopback.
 * No browser cookies/auth, redirect following, challenge handling or translation APIs.
 */
export function createReaderLiveHandler(loadNetwork:()=>Promise<SourceNetwork>, fetcher:typeof fetch = fetch) {
  let catalog:Promise<LiveCatalog>|undefined;
  const upstream = new RequestPool(2);
  const manifests = new Map<string,Promise<LiveManifest>>(), images = new Map<string,string>();
  async function remote(url:string, kind:'html'|'image', signal?:AbortSignal) {
    if (kind === 'html' ? ![asuraWork,...chapters.map(chapter=>`${asuraWork}/chapter/${chapter}`)].includes(url) : !allowedImage(url))
      throw Error('Outside the fixed public-source scope');
    const requestSignal = signal ? AbortSignal.any([signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    return upstream.run(async()=>{
      requestSignal.throwIfAborted();
      const response = await fetcher(url, {method:'GET',redirect:'manual',
        headers:{Accept:kind==='html'?'text/html':'image/avif,image/webp,image/*',Referer:asuraWork},
        signal:requestSignal});
      const type = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!response.ok || response.headers.get('cf-mitigated') === 'challenge' ||
          !(kind==='html' ? type==='text/html' : /^image\/(png|jpeg|webp|avif)$/.test(type)))
        throw Error('Source unavailable or challenge refused');
      const limit = kind==='html' ? htmlLimit : imageLimit;
      if (Number(response.headers.get('content-length')) > limit) throw Error('Source byte limit');
      const reader = response.body?.getReader();
      if (!reader) throw Error('Source body missing');
      const chunks:Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const {done,value} = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) throw Error('Source byte limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(()=>{}); }
      return {body:Buffer.concat(chunks,size),type};
    });
  }
  function getCatalog(signal?:AbortSignal):Promise<LiveCatalog> {
    return catalog ??= (async()=>{
      const network = await loadNetwork();
      const snapshot = await network.catalog!(asuraWork,{signal,request:async url=>(await remote(url,'html',signal)).body.toString('utf8')});
      const entries = chapters.map(chapter=>{
        const entry = snapshot.entries.find(entry=>entry.url===`${asuraWork}/chapter/${chapter}`);
        if (!entry) throw Error('Selected public chapter missing');
        return {id:entry.id,title:entry.title,chapter};
      });
      return {title:snapshot.title,url:snapshot.url,entries};
    })().catch(error=>{catalog=undefined;throw error;});
  }
  function getManifest(chapter:string, signal?:AbortSignal):Promise<LiveManifest> {
    if (!chapters.includes(chapter)) throw Error('Chapter outside the three-chapter sample');
    let pending = manifests.get(chapter);
    if (!pending) {
      pending = (async()=>{
        await getCatalog(signal);
        const network = await loadNetwork();
        const snapshot = await network.pages!(`${asuraWork}/chapter/${chapter}`,{signal,request:async url=>(await remote(url,'html',signal)).body.toString('utf8')});
        if (!snapshot.discoveryComplete || snapshot.items.length > 1500) throw Error('Incomplete or excessive manifest');
        const pages = snapshot.items.map(page=>{
          if (page.resource.kind!=='http' || !allowedImage(page.resource.url)) throw Error('Unsupported source image');
          const path = `/__reader_live/image/${chapter}/${page.order}`;
          images.set(path,page.resource.url);
          const digest = createHash('sha256').update(page.resource.url).digest('hex').slice(0,24);
          return {id:page.id,name:`第 ${page.order+1} 页`,width:page.width,height:page.height,
            key:`inline-original:reader-live:asura:${chapter}:${digest}`,url:path};
        });
        return {title:snapshot.title,pages};
      })().catch(error=>{manifests.delete(chapter);throw error;});
      manifests.set(chapter,pending);
    }
    return pending;
  }
  return async(request:Request):Promise<Response>=>{
    const url = new URL(request.url), origin = request.headers.get('origin');
    const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    const json = (value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json'}});
    if (request.method!=='GET' || url.origin!==liveOrigin || url.search || origin && origin!==liveOrigin)
      return json({error:'仅允许隔离本地入口的固定 GET。'},403);
    try {
      if (url.pathname==='/__reader_live/catalog') return json(await getCatalog(request.signal));
      const chapter = url.pathname.match(/^\/__reader_live\/pages\/([123])$/)?.[1];
      if (chapter) return json(await getManifest(chapter,request.signal));
      const image = images.get(url.pathname);
      if (image) {
        const result = await remote(image,'image',request.signal);
        return new Response(new Uint8Array(result.body),{headers:{...headers,'Content-Type':result.type}});
      }
      if (url.pathname==='/__reader_live/pairs') return json(pairs.map(pair=>({...pair,
        original:`/__reader_live/sample/${pair.id}/original`,translated:`/__reader_live/sample/${pair.id}/translated`})));
      const sample = url.pathname.match(/^\/__reader_live\/sample\/(mono|color)\/(original|translated)$/);
      if (sample) {
        const pair = pairs.find(pair=>pair.id===sample[1])!, file = pair[sample[2] as 'original'|'translated'];
        const body = await readFile(new URL(`../../../backend/website/src/assets/home/${file}`,import.meta.url));
        if (body.length>imageLimit) throw Error('Sample byte limit');
        const type = file.endsWith('.png')?'image/png':file.endsWith('.jpg')?'image/jpeg':'image/webp';
        return new Response(new Uint8Array(body),{headers:{...headers,'Content-Type':type}});
      }
      return json({error:'该路径不在所选三章或已有译图白名单中。'},403);
    } catch {
      // Do not print upstream bodies, image URLs, authentication or challenge data.
      return json({error:'公开源或本地样本读取失败；请重试。挑战、重定向、超时及超限响应均拒绝，不尝试绕过。'},502);
    }
  };
}
