import {hashFile} from '../importers/hash';
import {pageSource} from '../reader/recovery';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page,ModeEntitlement,PlanItem} from '../types';
import type {LocalOperation} from './store';

export type ReadingTarget={copyId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string;retryable?:boolean;retryLabel?:string};
export const targetKey=(copyId:string,page:Page,mode:Mode)=>JSON.stringify([copyId,page.id,mode]);
export const exhausted=(rights:ModeEntitlement)=>!rights.allowed||!rights.unlimited&&(rights.quota?.available??0)<=0;
export const quotaErrors=new Set(['DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','PLUS_REQUIRED','QUOTA_BOUND_EXCEEDED','ENTITLEMENT_CHANGED']);
export const operationId=(scope:string,language:string,target:ReadingTarget)=>JSON.stringify([scope,language,targetKey(target.copyId,target.page,target.mode)]);

/** Page snapshots and same-page scrolling never reset the local reading clock. */
export class ReadingWindow {
  targets:ReadingTarget[]=[];readyAt=0;prefetchAt=0;private signature='';private burstAt=0;
  update(targets:ReadingTarget[],now=performance.now(),immediate=false){
    this.targets=targets.slice(0,3);const signature=JSON.stringify(this.targets.map(t=>targetKey(t.copyId,t.page,t.mode)));
    if(signature===this.signature)return false;
    const first=!this.signature;this.signature=signature;
    if(now>=this.readyAt)this.burstAt=now;
    this.readyAt=first||immediate?now:Math.min(now+80,this.burstAt+200);this.prefetchAt=now+150;return true;
  }
  ready(now=performance.now()){return now<this.readyAt?[]:this.targets.slice(0,now<this.prefetchAt?1:3);}
}
export function needsTranslation(page:Page,mode:Mode,language:string,userId:string,origin:string){const t=pageTranslation(page,mode,language,userId,origin);return !t.pending&&!t.ready&&!t.latest;}
export async function makeOperation(target:ReadingTarget,scope:string,language:string,rights:ModeEntitlement|undefined,getBlob:(key:string)=>Promise<Blob|undefined>,manual?:{action:'ensure'|'retry'|'regenerate';sourceJobId?:string}):Promise<LocalOperation>{
  const {page,copyId,mode}=target;
  const blob=(!page.imageSha256||!page.imageByteSize)&&page.blobKey?await getBlob(page.blobKey):undefined;
  const sha=page.imageSha256??(blob?await hashFile(blob):undefined),size=page.imageByteSize??blob?.size;
  if(!sha||!size)throw Error('原图尚未就绪，请完成采集或重新导入。');
  const item:PlanItem={page_key:targetKey(copyId,page,mode),operation_key:crypto.randomUUID(),role:'current',mode,target_language:language,max_quota_pages:rights&&exhausted(rights)?0:1,...(rights?{expected_kind:rights.quota_kind}:{}),image:{client_item_id:page.id,...pageSource(page),image_sha256:sha,byte_size:size,content_type:page.imageMime||blob?.type||'image/png',name:page.name,...(page.assetId?{asset_id:page.assetId}:{})},...(manual?{action:manual.action,source_job_id:manual.sourceJobId}:{})};
  return {id:operationId(scope,language,target),scope,copyId,pageId:page.id,blobKey:page.blobKey,item,state:'local',createdAt:Date.now()};
}
