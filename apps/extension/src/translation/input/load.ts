import {assertCurrent} from '../../concurrency';
import {readInput,cacheInput} from './cache';
import {InputChangedError,restoreTranslationInput,type PreparedInput} from './prepare';

interface FrozenInput {sha256:string;sourceSha256?:string;profile?:PreparedInput['profile'];size?:{width:number;height:number};}
/** Shared by upload and result composition; the caller owns source leases and task state. */
export async function loadTranslationInput(scope:string,input:FrozenInput,readSource:()=>Promise<Blob|undefined>,current:()=>boolean):Promise<Blob|undefined>{
  assertCurrent(current);
  const cached=input.profile?await readInput(scope,input.sha256):undefined;
  assertCurrent(current);
  if(cached)return cached;
  const source=await readSource();assertCurrent(current);
  if(!source||!input.profile)return source;
  if(!input.size)throw new InputChangedError();
  const blob=await restoreTranslationInput(source,input.size.width,input.size.height,input.sourceSha256,input.sha256,current);
  await cacheInput(scope,input.sha256,blob);assertCurrent(current);
  return blob;
}
