import { acquirePage, type PageLease } from '../pages/service';
import { parsePageReference } from '../pages/identity';
import { resultInMemory,readMaterializedResult } from '../../storage/translations/results';
import { translationCache } from '../../storage/translations';
import { sourcePageCache } from '../../storage/source-pages';
import { thumbnailCache } from '../../storage/thumbnails';
import { RequestPool } from '../../concurrency';
import {openSourceCover} from './cover-access';
import {createImageCanvas, imageCanvasBlob} from '../../../../../backend/shared/translation-images/canvas';

const thumbnails=new RequestPool(2);
export async function acquireImage(key:string,signal?:AbortSignal):Promise<Pick<PageLease,'blob'|'release'>>{
  const reference=parsePageReference(key);
  if(reference)return acquirePage({...reference,signal,purpose:'reading'});
  signal?.throwIfAborted();
  const blob=key.startsWith('inline-original:')?await sourcePageCache.get(key):resultInMemory(key)??await readMaterializedResult(key)??await translationCache.get(key);
  if(!blob)throw Error('图片缓存已清理，请重新加载。');
  return {blob,release(){}};
}
export async function readImage(key:string):Promise<Blob|undefined>{const lease=await acquireImage(key);try{return lease.blob;}finally{lease.release();}}
export async function readThumbnail(key:string,signal?:AbortSignal):Promise<Blob>{
  signal?.throwIfAborted();
  const reference=parsePageReference(key);
  const source=await openSourceCover(key);
  const owner=source?.owner??reference?.entryId;
  const token=await thumbnailCache.token(owner).catch(()=>undefined);
  const cached=await thumbnailCache.get(key);if(cached){await source?.validate();signal?.throwIfAborted();return cached;}
  return thumbnails.run(async()=>{
    signal?.throwIfAborted();
    await source?.validate();
    const lease=source?{blob:await source.read(signal),release(){}}:reference?await acquirePage({...reference,signal,priority:'background',purpose:'thumbnail'}):await acquireImage(key,signal);
    try{
      signal?.throwIfAborted();
      const bitmap=await createImageBitmap(lease.blob,{resizeWidth:240,resizeQuality:'medium'});
      try{
        const canvas=createImageCanvas(bitmap.width,bitmap.height);
        let blob:Blob;
        try{
          (canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).drawImage(bitmap,0,0);
          blob=await imageCanvasBlob(canvas,'image/webp',.75);
        }finally{canvas.width=canvas.height=1;}
        signal?.throwIfAborted();await source?.validate();
        if(token)await thumbnailCache.put(key,blob,{owner,connectionId:source?.connectionId,contentId:reference?.contentId,token});
        await source?.validate();return blob;
      }finally{bitmap.close();}
    }finally{lease.release();}
  });
}
