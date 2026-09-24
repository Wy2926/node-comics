import {msg} from '../i18n/runtime';
import {hashFile,Sha256} from '../importers/hash';
import {parsePageReference} from '../comics/pages/identity';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page,ModeEntitlement,TranslationInput} from '../types';
import type {LocalOperation} from './store';

export type ReadingTarget={entryId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string;retryable?:boolean;retryLabel?:string};
const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export const targetKey=(entryId:string,page:Page,mode:Mode)=>digest([entryId,page.contentId??null,page.id,mode]);
export const exhausted=(rights:ModeEntitlement)=>!rights.allowed||!rights.unlimited&&(rights.quota?.available??0)<=0;
export const quotaErrors=new Set(['DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','PLUS_REQUIRED']);
export const operationId=(scope:string,language:string,target:ReadingTarget)=>digest([scope,language,targetKey(target.entryId,target.page,target.mode)]);
export const advancesReadingWindow=(previous:readonly string[],next:string|undefined)=>next!==undefined&&previous.indexOf(next)>0;

/** Page snapshots and same-page scrolling never reset the local reading clock. */
export class ReadingWindow {
  targets:ReadingTarget[]=[];readyAt=0;prefetchAt=0;private signature='';private burstAt=0;
  update(targets:ReadingTarget[],now=performance.now(),immediate=false){
    const advancing=advancesReadingWindow(this.targets.map(t=>targetKey(t.entryId,t.page,t.mode)),targets[0]&&targetKey(targets[0].entryId,targets[0].page,targets[0].mode));
    this.targets=targets.slice(0,4);const signature=JSON.stringify(this.targets.map(t=>targetKey(t.entryId,t.page,t.mode)));
    if(signature===this.signature)return false;
    const first=!this.signature;this.signature=signature;
    if(now>=this.readyAt)this.burstAt=now;
    this.readyAt=first||immediate?now:Math.min(now+80,this.burstAt+200);this.prefetchAt=advancing?this.readyAt:now+150;return true;
  }
  ready(now=performance.now()){return now<this.readyAt?[]:this.targets.slice(0,now<this.prefetchAt?1:4);}
}
export function needsTranslation(page:Page,mode:Mode,language:string,userId:string,origin:string){const t=pageTranslation(page,mode,language,userId,origin);return !t.pending&&!t.ready&&!t.latest;}
export async function makeOperation(target:ReadingTarget,scope:string,language:string,getBlob:(key:string)=>Promise<Blob|undefined>,action?:{retry_of:string}|{regenerate_of:string}):Promise<LocalOperation>{
  const {page,entryId,mode}=target;
  const blob=(!page.imageSha256||!page.imageByteSize)&&page.blobKey?await getBlob(page.blobKey):undefined;
  const sha=page.imageSha256??(blob?await hashFile(blob):undefined),size=page.imageByteSize??blob?.size;
  if(!sha||!size)throw Error(msg("原图尚未就绪，请完成采集或重新导入。"));
  const image={sha256:sha,byte_size:size,content_type:page.imageMime||blob?.type||'image/png'};
  const request:TranslationInput=action??{image,mode,target_language:language};
  return {id:operationId(scope,language,target),requestId:crypto.randomUUID(),scope,entryId,pageId:page.id,mode,language,image,blobKey:page.entryId?undefined:page.blobKey,pageRef:page.blobKey?parsePageReference(page.blobKey):undefined,request,state:'local',createdAt:Date.now()};
}
