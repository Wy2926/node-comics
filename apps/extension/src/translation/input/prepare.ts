import {msg} from '../../i18n/runtime';
import {assertCurrent} from '../../concurrency';
import type {Capabilities,Page,TranslationImage} from '../../types';
import {hashFile} from '../../importers/hash';
import {INPUT_PROFILE,TRANSLATION_MAX_BYTES,TRANSLATION_MAX_DIMENSION,TRANSLATION_MAX_PIXELS,TRANSLATION_REENCODE_BYTES,translationSize} from './limits';
import {imageWork} from './work';
import {resizeInput} from './resize';
import ResizeWorker from './resize.worker?worker';

export interface PreparedInput {image:TranslationImage;sourceSha256:string;width:number;height:number;profile?:typeof INPUT_PROFILE;blob?:Blob;}
export class InputChangedError extends Error {
  readonly code='SOURCE_CHANGED';
  constructor(){super(msg('原图内容已变化，请重新加载后翻译。'));}
}
function resized(blob:Blob,width:number,height:number):Promise<{blob:Blob;sha256:string}> {
  // An extension service worker is already off the UI thread and has no Worker constructor.
  if(typeof Worker==='undefined')return resizeInput(blob,width,height);
  return new Promise((resolve,reject)=>{
    const worker=new ResizeWorker();
    const fail=()=>{clearTimeout(timer);worker.terminate();reject(Error(msg('{0} 无法解码，请检查图片是否损坏。',{'0':msg('原图')})));};
    const timer=setTimeout(fail,120000);
    worker.onerror=fail;
    worker.onmessage=(event:MessageEvent<{blob?:Blob;sha256?:string}>)=>{
      if(!event.data.blob||!event.data.sha256){fail();return;}
      clearTimeout(timer);worker.terminate();resolve({blob:event.data.blob,sha256:event.data.sha256});
    };
    worker.postMessage({blob,width,height});
  });
}
/** Recovery never trusts re-encoding determinism: only the frozen uploaded hash is accepted. */
export async function restoreTranslationInput(source:Blob,width:number,height:number,sourceSha:string|undefined,expectedSha:string,current:()=>boolean){
  return imageWork(async()=>{
    assertCurrent(current);
    if(!sourceSha||await hashFile(source)!==sourceSha)throw new InputChangedError();
    assertCurrent(current);
    const result=await resized(source,width,height);assertCurrent(current);
    if(result.sha256!==expectedSha)throw new InputChangedError();
    return result.blob;
  });
}
export async function prepareTranslationInput(page:Page,read:()=>Promise<Blob|undefined>,current:()=>boolean,limits?:Capabilities['limits']):Promise<PreparedInput> {
  const size=translationSize(page.width,page.height);
  if(!Number.isFinite(page.width*page.height)||page.width<1||page.height<1||page.width*page.height>40_000_000||Math.max(page.width,page.height)>30000
    ||size.width*size.height>Math.min(TRANSLATION_MAX_PIXELS,limits?.max_pixels??Infinity)
    ||Math.max(size.width,size.height)>Math.min(TRANSLATION_MAX_DIMENSION,limits?.max_dimension??Infinity))throw Error(msg('图片尺寸超过翻译服务限制。'));
  const changed=size.width!==page.width||size.height!==page.height;
  const maxBytes=Math.min(TRANSLATION_MAX_BYTES,limits?.max_bytes??Infinity);
  if(!changed&&page.imageSha256&&page.imageByteSize&&page.imageByteSize<=TRANSLATION_REENCODE_BYTES){
    if(page.imageByteSize>maxBytes)throw Error(msg('图片超过翻译服务的大小限制。'));
    assertCurrent(current);
    return {...size,sourceSha256:page.imageSha256,image:{sha256:page.imageSha256,byte_size:page.imageByteSize,content_type:page.imageMime||'image/png',normalization_version:1}};
  }
  return imageWork(async()=>{
    assertCurrent(current);const source=await read();assertCurrent(current);
    if(!source)throw Error(msg('原图不可用，请恢复所属来源或本地原图缓存。'));
    const sourceSha256=await hashFile(source);
    assertCurrent(current);
    if(page.imageSha256&&page.imageSha256!==sourceSha256)throw Error(msg('原图内容已变化，请重新加载后翻译。'));
    const encoded=changed||source.size>TRANSLATION_REENCODE_BYTES?await resized(source,size.width,size.height):undefined;
    // Keep original bytes if re-encoding an unchanged-sized image saves no space.
    const result=encoded&&(changed||encoded.blob.size<source.size)?encoded:{blob:source,sha256:sourceSha256};
    const prepared=result.blob!==source;
    assertCurrent(current);
    if(result.blob.size>maxBytes)throw Error(msg('图片超过翻译服务的大小限制。'));
    return {...size,sourceSha256,profile:prepared?INPUT_PROFILE:undefined,blob:prepared?result.blob:undefined,
      image:{sha256:result.sha256,byte_size:result.blob.size,content_type:result.blob.type,normalization_version:1}};
  });
}
