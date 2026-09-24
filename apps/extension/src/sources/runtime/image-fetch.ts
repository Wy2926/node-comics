import { msg } from '../../i18n/runtime';
import { maxInlineBytes } from '../shared/bytes';
import {withImageHeaders} from './image-headers';
/** A source response must stay bounded even when Content-Length is missing. */
export async function fetchSourceImage(url:string,signal?:AbortSignal,headers?:Readonly<Record<string,string>>) {
  const lifetime=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)]);
  return withImageHeaders(url,headers,lifetime,()=>readResponse(url,lifetime,!!headers));
}
export async function sourceImage(url:string,signal?:AbortSignal):Promise<Blob> {
  return (await fetchSourceImage(url,signal)).blob;
}
async function readResponse(url:string,signal:AbortSignal,customHeaders:boolean) {
  const max = maxInlineBytes;
  const response = await fetch(url, {
    credentials: 'include',
    redirect:customHeaders?'error':'follow',
    signal,
  });
  if (!response.ok)
    throw Error(msg('来源图片获取失败（HTTP {0}），可重新解析后补齐。', { '0': response.status }));
  if (Number(response.headers.get('content-length')) > max) throw Error(msg('单图超过 40 MB 限制。'));
  if (!response.body) throw Error(msg('图片响应为空。'));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
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
