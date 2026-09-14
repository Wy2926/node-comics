/** A source response must stay bounded even when Content-Length is missing. */
export async function sourceImage(url:string,signal?:AbortSignal):Promise<Blob>{
 const max=40*1024*1024;const response=await fetch(url,{credentials:'omit',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
 if(!response.ok)throw Error('来源图片获取失败（HTTP '+response.status+'），可重新解析后补齐。');
 if(Number(response.headers.get('content-length'))>max)throw Error('单图超过 40 MB 限制。');
 if(!response.body)throw Error('图片响应为空。');const reader=response.body.getReader();const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw Error('单图超过 40 MB 限制。');chunks.push(value as Uint8Array<ArrayBuffer>);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 return new Blob(chunks,{type:response.headers.get('content-type')??'application/octet-stream'});
}
