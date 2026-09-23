import { acquirePage, type PageLease } from '../pages/service';
import { parsePageReference } from '../pages/identity';
import { resultInMemory } from '../../storage/translations/results';
import { translationCache } from '../../storage/translations';
import { sourcePageCache } from '../../storage/source-pages';
import { thumbnailCache } from '../../storage/thumbnails';
import { RequestPool } from '../../concurrency';

const thumbnails=new RequestPool(2);
export async function acquireImage(key:string,signal?:AbortSignal):Promise<Pick<PageLease,'blob'|'release'>>{
  const reference=parsePageReference(key);
  if(reference)return acquirePage({...reference,signal,purpose:'reading'});
  signal?.throwIfAborted();
  const blob=key.startsWith('inline-original:')?await sourcePageCache.get(key):resultInMemory(key)??await translationCache.get(key);
  if(!blob)throw Error('图片缓存已清理，请重新加载。');
  return {blob,release(){}};
}
export async function readImage(key:string):Promise<Blob|undefined>{const lease=await acquireImage(key);try{return lease.blob;}finally{lease.release();}}
export async function readThumbnail(key:string,signal?:AbortSignal):Promise<Blob>{
  const reference=parsePageReference(key);
  const token=await thumbnailCache.token(reference?.documentId).catch(()=>undefined);
  const cached=await thumbnailCache.get(key);if(cached)return cached;
  return thumbnails.run(async()=>{
    const lease=reference?await acquirePage({...reference,signal,priority:'background',purpose:'thumbnail'}):await acquireImage(key,signal);
    try{signal?.throwIfAborted();const bitmap=await createImageBitmap(lease.blob,{resizeWidth:240,resizeQuality:'medium'});
      try{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d')!.drawImage(bitmap,0,0);const blob=await canvas.convertToBlob({type:'image/webp',quality:.75});signal?.throwIfAborted();if(token)await thumbnailCache.put(key,blob,{owner:reference?.documentId,revisionId:reference?.revisionId,token});return blob;}finally{bitmap.close();}
    }finally{lease.release();}
  });
}
