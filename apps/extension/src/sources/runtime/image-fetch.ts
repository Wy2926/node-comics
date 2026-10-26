import { msg } from '../../i18n/runtime';
import {withImageHeaders} from './image-headers';
import {requireImagePermissions} from './permissions';
import {safeImageUrl} from '../shared/urls';
import {imageReferer} from '../shared/referrer';
import {observeImageRedirect} from './image-redirect';
import {SourceHttpError,sourceRetryAfter,sourceVerificationError} from './http';
import {isSafariExtension} from '../../platform';
import {withSafariPublicResponse} from './safari-public-request';
import type {SourceImageProgressListener} from '../contracts/image';
export interface ImageRequestContext {pageUrl:string;referrerPolicy?:ReferrerPolicy;safariTransport?:'public-native';}
/** Source reads are cancellable; translation input limits belong to the translation entry point. */
export async function fetchSourceImage(url:string,signal?:AbortSignal,headers?:Readonly<Record<string,string>>,context?:ImageRequestContext,onProgress?:SourceImageProgressListener) {
  const deadline=new AbortController(),lifetime=AbortSignal.any([...(signal?[signal]:[]),deadline.signal]);
  let timer:ReturnType<typeof setTimeout>;
  const progressed=()=>{clearTimeout(timer);timer=setTimeout(()=>deadline.abort(new DOMException(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'),'TimeoutError')),30000);};
  progressed();
  try{
    lifetime.throwIfAborted();
    if(!/^https?:/.test(url))return await readResponse(await fetch(url,{signal:lifetime}),lifetime,onProgress,progressed);
    const initial=new URL(url);initial.hash='';let current=initial.href;
    const visited=new Set<string>();
    while(true){
      lifetime.throwIfAborted();
      if(!safeImageUrl(current,current)||visited.has(current))throw Error(msg('图片重定向无效或次数过多，请刷新来源页面后重试。'));
      visited.add(current);await requireImagePermissions([current]);lifetime.throwIfAborted();
      const requestHeaders:Record<string,string>={};
      if(context){const referer=imageReferer(context.pageUrl,current,context.referrerPolicy);if(referer)requestHeaders.referer=referer;}
      // Site overrides are trusted packaged code, but cannot cross an origin boundary.
      if(new URL(current).origin===initial.origin)for(const [key,value] of Object.entries(headers??{}))requestHeaders[key.toLowerCase()]=value;
      const consume=async(response:Response,location?:string)=>{
        if(response.type==='opaqueredirect'||[301,302,303,307,308].includes(response.status)){
          const target=location??response.headers.get('location');
          await response.body?.cancel();
          const next=target&&safeImageUrl(target,current);
          if(!next)throw Error(msg('图片重定向无效或次数过多，请刷新来源页面后重试。'));
          const normalized=new URL(next);normalized.hash='';return {next:normalized.href};
        }
        return {image:await readResponse(response,lifetime,onProgress,progressed)};
      };
      const result=context?.safariTransport==='public-native'&&isSafariExtension()
        ?await withSafariPublicResponse(current,requestHeaders,lifetime,consume)
        :await withImageHeaders(current,requestHeaders,lifetime,async()=>{
        const redirect=observeImageRedirect(current);
        try{
          let response:Response;
          try{response=await fetch(current,{credentials:'include',redirect:'manual',referrerPolicy:'no-referrer',signal:lifetime});}
          catch(error){lifetime.throwIfAborted();throw Error(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'),{cause:error});}
          return consume(response,redirect.location());
        }finally{redirect.dispose();}
      });
      if(result.image)return result.image;
      current=result.next!;
    }
  }finally{clearTimeout(timer!);}
}
export async function sourceImage(url:string,signal?:AbortSignal):Promise<Blob> {
  return (await fetchSourceImage(url,signal)).blob;
}
async function readResponse(response:Response,signal:AbortSignal,onProgress?:SourceImageProgressListener,progressed?:()=>void) {
  if(response.headers.get('cf-mitigated')==='challenge'){
    await response.body?.cancel();
    throw sourceVerificationError(response.status);
  }
  if (!response.ok){
    await response.body?.cancel();
    throw new SourceHttpError('http',msg('来源图片获取失败（HTTP {0}），可重新解析后补齐。', { '0': response.status }),
      {status:response.status,retryAfter:sourceRetryAfter(response.headers.get('retry-after'))});
  }
  if (!response.body) throw Error(msg('图片响应为空。'));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  // The original collector is also the preview buffer: no second fetch, tee or partial Blob copies.
  const publish=(done:boolean|undefined)=>{try{onProgress?.(done===undefined?undefined:{chunks,done});}catch{/* Presentation cannot fail a source read. */}};
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if(!value.byteLength)continue;
      progressed?.();
      chunks.push(value as Uint8Array<ArrayBuffer>);
      publish(false);
    }
    signal.throwIfAborted();publish(true);
  } catch (e) {
    publish(undefined);
    await reader.cancel().catch(() => {});
    if(!signal.aborted&&e instanceof TypeError)throw Error(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'),{cause:e});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const blob=new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
  return {blob,headers:response.headers};
}
