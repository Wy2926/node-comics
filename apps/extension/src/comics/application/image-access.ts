import { acquirePage, pageAccess, promotePage, type PageLease } from '../pages/service';
import { parsePageReference } from '../pages/identity';
import { resultInMemory,readMaterializedResult,validateMaterializedResult } from '../../storage/translations/results';
import type {ProcessingInput} from '../../image-processing/contracts';
import { translationCache } from '../../storage/translations';
import { sourcePageCache } from '../../storage/source-pages';
import { thumbnailCache } from '../../storage/thumbnails';
import { RequestPool } from '../../concurrency';
import {openSourceCover} from './cover-access';
import {createImageCanvas, imageCanvasBlob} from '../../../../../backend/shared/translation-images/canvas';

const thumbnails=new RequestPool(2);
export function promoteImage(key:string){
  // Acquisition reports malformed identities through the page error UI; scheduling must not crash an effect.
  let reference;try{reference=parsePageReference(key);}catch{return;}
  if(reference)promotePage(reference);
}
export function processingInput(key:string,owner:string,sourceKey=key):ProcessingInput{
  const reference=parsePageReference(sourceKey);
  let access:Promise<()=>Promise<void>>|undefined;
  return {key,owner,load:signal=>acquireImage(key,signal),async validate(){
    if(reference)await(await(access??=pageAccess(reference)))();
    if(key.startsWith('result:'))await validateMaterializedResult(key);
  }};
}
export async function acquireImage(key:string,signal?:AbortSignal,priority:'current'|'prefetch'|'background'='current'):Promise<Pick<PageLease,'blob'|'release'>>{
  const reference=parsePageReference(key);
  if(reference)return acquirePage({...reference,signal,priority,purpose:'reading'});
  signal?.throwIfAborted();
  const blob=key.startsWith('inline-original:')?await sourcePageCache.get(key)
    :key.startsWith('result:')?await readMaterializedResult(key,signal):resultInMemory(key)??await translationCache.get(key);
  signal?.throwIfAborted();
  if(!blob)throw Error('图片缓存已清理，请重新加载。');
  return {blob,release(){}};
}
export async function readImage(key:string,signal?:AbortSignal):Promise<Blob|undefined>{const lease=await acquireImage(key,signal);try{return lease.blob;}finally{lease.release();}}
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
