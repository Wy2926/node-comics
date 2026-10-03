import {catalog} from '../repositories';
import {blockTranslationBindingEntry,readImageTranslationBindings,removeImageTranslationBindings} from '../repositories/translation-bindings';
import {blockLocalTranslationEntry,inspectLocalTranslationEntry,removeLocalTranslationEntry} from '../../translation/channels';
import type {LocalTranslationResultReference} from '../../translation/channels/contracts';
import {translationCache} from '../../storage/translations';
import {resultBlobKey} from '../../storage/translations/results';
import type {Job} from '../../types';
import {sourceLock} from './locks';

export type SourceTranslationResultReference=LocalTranslationResultReference;

async function sharedDirectOwner(entryId:string,imageSha256:string):Promise<{entryId:string;pageId:string}|undefined>{
  for(let offset=0;;offset+=100){
    const pages=await catalog.list('materializations',{index:'imageSha256',range:imageSha256,offset,limit:100});
    for(const page of pages){
      const [entry]=await catalog.list('entries',{index:'contentId',range:page.contentId,limit:1});
      if(!entry||entry.id===entryId||entry.sourceRemoved)continue;
      const comic=await catalog.get('comics',entry.comicId);
      if(!comic||comic.source.status!=='active')continue;
      const connection=await catalog.get('connections',comic.source.connectionId);
      if(!connection||['disconnected','revoked'].includes(connection.status))continue;
      return {entryId:entry.id,pageId:page.pageId};
    }
    if(pages.length<100)return;
  }
}

/** Freeze writers before taking the deletion journal's local result snapshot. */
export async function blockSourceTranslationEntry(entryId:string):Promise<void>{
  await sourceLock(async()=>{
    await blockTranslationBindingEntry(entryId);
    const owners=new Map<string,{entryId:string;pageId:string}|undefined>();
    await blockLocalTranslationEntry(entryId,async(hash)=>{
      if(!owners.has(hash))owners.set(hash,await sharedDirectOwner(entryId,hash));
      return owners.get(hash);
    });
  });
}
export const inspectSourceTranslationEntry=inspectLocalTranslationEntry;
/** The caller durably records inspected references before releasing local operations. */
export const removeSourceTranslationEntry=removeLocalTranslationEntry;

/** Shared image bindings survive while another materialization still references their hash. */
export async function removeSourceTranslationImages(hashes:readonly string[],resultRefs:readonly SourceTranslationResultReference[]=[]):Promise<void>{
  const referenced=new Set<string>(),deletedKeys=new Set<string>();
  const removeResult=async(key:string)=>{if(!deletedKeys.has(key)){await translationCache.delete(key);deletedKeys.add(key);}};
  for(const hash of new Set([...hashes,...resultRefs.flatMap(ref=>ref.imageSha256?[ref.imageSha256]:[])])){
    if((await catalog.list('materializations',{index:'imageSha256',range:hash,limit:1})).length){referenced.add(hash);continue;}
    let count:number;
    do{
      const bindings=await readImageTranslationBindings(hash);count=bindings.length;
      for(const binding of bindings){
        const payload=binding.payload as {jobs?:Job[]}|undefined;
        if(Array.isArray(payload?.jobs))for(const job of payload.jobs)if(job.result?.key)await removeResult(resultBlobKey({key:binding.scope},job));
      }
      await removeImageTranslationBindings(hash,bindings.map(binding=>binding.id));
    }while(count===100);
  }
  for(const ref of new Map(resultRefs.map(ref=>[ref.key,ref])).values())if(!ref.imageSha256||!referenced.has(ref.imageSha256))await removeResult(ref.key);
}
