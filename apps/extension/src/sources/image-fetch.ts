import {msg} from '../i18n/runtime';
/** A source response must stay bounded even when Content-Length is missing. */
export async function sourceImage(url:string,signal?:AbortSignal):Promise<Blob>{
 const max=40*1024*1024;const response=await fetch(url,{credentials:'omit',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
 if(!response.ok)throw Error(msg("来源图片获取失败（HTTP {0}），可重新解析后补齐。", {"0": response.status}));
 if(Number(response.headers.get('content-length'))>max)throw Error(msg("单图超过 40 MB 限制。"));
 if(!response.body)throw Error(msg("图片响应为空。"));const reader=response.body.getReader();const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw Error(msg("单图超过 40 MB 限制。"));chunks.push(value as Uint8Array<ArrayBuffer>);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 return new Blob(chunks,{type:response.headers.get('content-type')??'application/octet-stream'});
}
