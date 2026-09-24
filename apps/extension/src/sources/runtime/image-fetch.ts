import { msg } from '../../i18n/runtime';
import { maxInlineBytes } from '../shared/bytes';
import {withImageHeaders} from './image-headers';
import {requireImagePermissions} from './permissions';
import {safeImageUrl} from '../shared/urls';
import {imageReferer} from '../shared/referrer';
import {observeImageRedirect} from './image-redirect';
export interface ImageRequestContext {pageUrl:string;referrerPolicy?:ReferrerPolicy;}
/** A source response must stay bounded even when Content-Length is missing. */
export async function fetchSourceImage(url:string,signal?:AbortSignal,headers?:Readonly<Record<string,string>>,context?:ImageRequestContext) {
  const lifetime=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)]);
  if(!/^https?:/.test(url))return readResponse(await fetch(url,{signal:lifetime}),lifetime);
  const initial=new URL(url);initial.hash='';let current=initial.href;
  const visited=new Set<string>();
  while(true){
    lifetime.throwIfAborted();
    if(!safeImageUrl(current,current)||visited.has(current)||visited.size>=6)throw Error(msg('图片重定向无效或次数过多，请刷新来源页面后重试。'));
    visited.add(current);await requireImagePermissions([current]);lifetime.throwIfAborted();
    const requestHeaders:Record<string,string>={};
    if(context){const referer=imageReferer(context.pageUrl,current,context.referrerPolicy);if(referer)requestHeaders.referer=referer;}
    // Site overrides are trusted packaged code, but cannot cross an origin boundary.
    if(new URL(current).origin===initial.origin)for(const [key,value] of Object.entries(headers??{}))requestHeaders[key.toLowerCase()]=value;
    const result=await withImageHeaders(current,requestHeaders,lifetime,async()=>{
      const redirect=observeImageRedirect(current);
      try{
        let response:Response;
        try{response=await fetch(current,{credentials:'include',cache:'no-store',redirect:'manual',referrerPolicy:'no-referrer',signal:lifetime});}
        catch(error){lifetime.throwIfAborted();throw Error(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'),{cause:error});}
        if(response.type==='opaqueredirect'||[301,302,303,307,308].includes(response.status)){
          const target=redirect.location()??response.headers.get('location');
          await response.body?.cancel();
          const next=target&&safeImageUrl(target,current);
          if(!next)throw Error(msg('图片重定向无效或次数过多，请刷新来源页面后重试。'));
          const normalized=new URL(next);normalized.hash='';return {next:normalized.href};
        }
        return {image:await readResponse(response,lifetime)};
      }finally{redirect.dispose();}
    });
    if(result.image)return result.image;
    current=result.next!;
  }
}
export async function sourceImage(url:string,signal?:AbortSignal):Promise<Blob> {
  return (await fetchSourceImage(url,signal)).blob;
}
async function readResponse(response:Response,signal:AbortSignal) {
  const max = maxInlineBytes;
  if (!response.ok){
    await response.body?.cancel();
    throw Error(msg('来源图片获取失败（HTTP {0}），可重新解析后补齐。', { '0': response.status }));
  }
  if (Number(response.headers.get('content-length')) > max){await response.body?.cancel();throw Error(msg('单图超过 40 MB 限制。'));}
  if (!response.body) throw Error(msg('图片响应为空。'));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw Error(msg('单图超过 40 MB 限制。'));
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const blob=new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
  return {blob,headers:response.headers};
}
