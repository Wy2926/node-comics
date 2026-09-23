import type {SourceImageReference} from '../contracts/image';
import {sourceImages} from '../registry/images';
import {fetchSourceImage} from './image-fetch';
import {sourceMessage} from './client';
import {requireImagePermissions} from './permissions';

/** The application sees a resource reference and decoded bytes, never a site's image recipe. */
export async function readSourceImage(reference:SourceImageReference,signal?:AbortSignal):Promise<Blob> {
  signal?.throwIfAborted();
  const valid=await sourceMessage<{url:string;data?:string;sourceId?:string;processing?:string}>({type:'NC_SOURCE_IMAGE',manifestId:reference.manifestId,pageId:reference.pageId});
  signal?.throwIfAborted();
  if(valid.url!==reference.expectedUrl)throw Error('图片来源已变化，请重新发现。');
  if(!valid.data)await requireImagePermissions([valid.url]);
  const adapter=valid.sourceId?sourceImages[valid.sourceId]:undefined;
  if(valid.processing&&!adapter?.decode)throw Error('来源图片处理器不可用。');
  const response=await fetchSourceImage(valid.data??valid.url,signal,valid.data?undefined:adapter?.headers);
  signal?.throwIfAborted();
  const blob=adapter?.decode?await adapter.decode(response.blob,response.headers,valid.processing,signal):response.blob;
  signal?.throwIfAborted();
  return blob;
}
