import type {SourceImageReference} from '../contracts/image';
import {sourceImages} from '../registry/images';
import {fetchSourceImage} from './image-fetch';
import {sourceMessage} from './client';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {safeImageUrl} from '../shared/urls';

/** Called after inline activation/document validation, for an HTTP original selected in that page. */
export async function readInlineSourceImage(url:string,pageUrl:string,signal?:AbortSignal,referrerPolicy?:ReferrerPolicy):Promise<Blob> {
  signal?.throwIfAborted();
  const {definition,location}=resolveSource(pageUrl,definitions);
  if(!definition.capabilities.inline||location.kind!=='reader'||safeImageUrl(url,pageUrl)!==url)
    throw Error('SOURCE_RESOURCE_EXPIRED');
  const adapter=sourceImages[definition.id];
  const headers=typeof adapter?.headers==='function'?adapter.headers(url):adapter?.headers;
  // Canvas targets already supply decoded pixels through their document-bound read callback.
  return (await fetchSourceImage(url,signal,headers,{pageUrl,referrerPolicy})).blob;
}

/** The application sees a resource reference and decoded bytes, never a site's image recipe. */
export async function readSourceImage(reference:SourceImageReference,signal?:AbortSignal):Promise<Blob> {
  signal?.throwIfAborted();
  const valid=await sourceMessage<{url:string;pageUrl:string;data?:string;sourceId?:string;processing?:string}>({type:'NC_SOURCE_IMAGE',manifestId:reference.manifestId,pageId:reference.pageId});
  signal?.throwIfAborted();
  if(valid.url!==reference.expectedUrl)throw Error('图片来源已变化，请重新发现。');
  const adapter=valid.sourceId?sourceImages[valid.sourceId]:undefined;
  if(valid.processing&&!adapter?.decode)throw Error('来源图片处理器不可用。');
  const headers=valid.data?undefined:typeof adapter?.headers==='function'?adapter.headers(valid.url):adapter?.headers;
  const response=await fetchSourceImage(valid.data??valid.url,signal,headers,valid.data?undefined:{pageUrl:valid.pageUrl});
  signal?.throwIfAborted();
  const blob=adapter?.decode?await adapter.decode(response.blob,response.headers,valid.processing,signal):response.blob;
  signal?.throwIfAborted();
  return blob;
}
