import { useEffect, useState } from 'react';
import { msg } from '../i18n/runtime';
import type { SourceCatalog } from '../library/types';
import { inExtension, prepareImageOrigins } from '../sources';

/** Resolve the first CDN before enabling the click that opens Chrome's prompt. */
export function useImagePermissions(targets:{catalog:SourceCatalog;entryId:string}[]){
 const key=targets.map(t=>t.catalog.id+':'+t.entryId).join('|');
 const [retry,setRetry]=useState(0);
 const [result,setResult]=useState<{key:string;origins:string[];error?:string}>({key:'',origins:[]});
 useEffect(()=>{
  const controller=new AbortController();
  if(!key||!inExtension()){setResult({key,origins:[]});return;}
  void (async()=>{
   const origins:string[]=[];
   for(const target of targets)origins.push(...await prepareImageOrigins(target.catalog,target.entryId,controller.signal));
   if(!controller.signal.aborted)setResult({key,origins:[...new Set(origins)]});
  })().catch(e=>{if(!controller.signal.aborted)setResult({key,origins:[],error:e instanceof Error?e.message:msg("图片域名读取失败，请重试。")});});
  return()=>controller.abort();
 },[key,retry]);
 return {origins:result.key===key?result.origins:[],preparing:inExtension()&&result.key!==key,error:result.key===key?result.error:undefined,retry:()=>{setResult({key:'',origins:[]});setRetry(n=>n+1);}};
}
