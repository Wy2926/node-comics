import {assertCurrent} from '../../concurrency';
import {msg} from '../../i18n/runtime';
import type {Job} from '../../types';
import type {TranslationScope} from '../../translation/channels/contracts';
import {translationCache} from './index';
import {SourceDatabaseSchemaError} from '../database';
import type {CacheToken} from '../cache';
import {resultInMemory,retainResult,readResultFromContexts} from './memory';
export {resultInMemory} from './memory';

interface ResultRequest {scope:TranslationScope;job:Job;isCurrent:()=>boolean}
const downloads=new Map<string,Promise<Blob>>();
function cacheUnavailable(error:unknown):undefined{if(error instanceof SourceDatabaseSchemaError)throw error;return undefined;}
export const resultBlobKey=(scope:TranslationScope,job:Job)=>'result:'+JSON.stringify([scope.key,job.id,job.result?.key]);
export class LocalResultUnavailableError extends Error {
  readonly code='RESULT_NOT_CACHED';
  constructor(){super(msg('本地译图缓存已清理，请手动重新翻译。'));this.name='LocalResultUnavailableError';}
}
function assertResult({job,isCurrent}:ResultRequest){
  assertCurrent(isCurrent);
  if(job.status!=='succeeded'||!job.result?.key||job.result_expired||job.result_available===false)
    throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
}
async function validate(blob:Blob){
  if(!blob.size||blob.size>128*1024*1024)throw Error(msg('图片尺寸超过翻译服务限制。'));
  let bitmap:ImageBitmap;
  try{bitmap=await createImageBitmap(blob);}catch{throw Error(msg('{0} 无法解码，请检查图片是否损坏。',{'0':msg('译图')}));}
  try{if(!bitmap.width||!bitmap.height||Math.max(bitmap.width,bitmap.height)>32768||bitmap.width*bitmap.height>100_000_000)throw Error(msg('图片尺寸超过翻译服务限制。'));}
  finally{bitmap.close();}
}
async function publish(request:ResultRequest,blob:Blob,token:CacheToken|undefined){
  const key=resultBlobKey(request.scope,request.job);
  if(token){
    await translationCache.put(key,blob,{owner:request.scope.key,token}).catch(cacheUnavailable);
  }
  return retainCurrent(request,key,blob,token);
}
async function retainCurrent(request:ResultRequest,key:string,blob:Blob,token:CacheToken|undefined){
  if(token){
    const current=await translationCache.token(request.scope.key).catch(cacheUnavailable);
    if(current&&(current.epoch!==token.epoch||current.ownerGeneration!==token.ownerGeneration))throw new LocalResultUnavailableError();
  }
  assertCurrent(request.isCurrent);retainResult(key,blob,token);return blob;
}
/** Validate before publishing; disk budget zero still permits bounded current-session display. */
export async function saveResultBlob(request:ResultRequest&{blob:Blob;cacheToken?:CacheToken}):Promise<Blob>{
  assertResult(request);const {scope,blob,isCurrent}=request;
  const token=request.cacheToken??await translationCache.token(scope.key).catch(cacheUnavailable);
  if(token&&token.owner!==scope.key)throw new LocalResultUnavailableError();
  await validate(blob);assertCurrent(isCurrent);
  return publish(request,blob,token);
}
/** Read a delivered result only. Missing local bytes never submit another translation. */
export async function loadResultBlob(request:ResultRequest&{download?:()=>Promise<Blob>}):Promise<Blob>{
  assertResult(request);const {scope,job,download,isCurrent}=request,key=resultBlobKey(scope,job);
  let pending=downloads.get(key);
  if(!pending){
    const read=async()=>{
      assertCurrent(isCurrent);
      const token=await translationCache.token(scope.key).catch(cacheUnavailable);
      const cached=await translationCache.get(key).catch(cacheUnavailable);
      const retained=cached??resultInMemory(key,token)??(!job.result!.recoverable?await readResultFromContexts(key,token):undefined);
      if(retained)return retainCurrent(request,key,retained,token);
      if(!job.result!.recoverable||!download)throw new LocalResultUnavailableError();
      const blob=await download();assertCurrent(isCurrent);await validate(blob);assertCurrent(isCurrent);
      return publish(request,blob,token);
    };
    pending=(async()=>typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('nc-result:'+key,read):await read())();
    downloads.set(key,pending);
    void pending.finally(()=>{if(downloads.get(key)===pending)downloads.delete(key);}).catch(()=>{});
  }
  const blob=await pending;assertCurrent(isCurrent);return blob;
}
