import {hashFile} from '../importers/hash';
import {pageSource} from '../reader/recovery';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page,ModeEntitlement,ModeQueue} from '../types';
import type {UploadManifest} from './store';

export type ReadingTarget={copyId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string};
export const targetKey=(copyId:string,page:Page,mode:Mode)=>JSON.stringify([copyId,page.id,mode]);
export const exhausted=(rights:ModeEntitlement)=>!rights.allowed||!rights.unlimited&&(rights.quota?.available??0)<=0;
export const quotaErrors=new Set(['DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','PLUS_REQUIRED','QUOTA_BOUND_EXCEEDED','ENTITLEMENT_CHANGED']);
export const capacityErrors=new Set(['QUEUE_FULL','QUEUE_CAPACITY_EXCEEDED','READING_UPLOAD_RESERVED','TOO_MANY_JOBS']);
export function availableSlots(queues:ModeQueue[],plus:boolean){return Math.max(0,(plus?10:3)-queues.reduce((sum,q)=>sum+q.in_flight,0));}

/** Updating page snapshots does not restart debounce; moving the reading window does. */
export class ReadingWindow {
  targets:ReadingTarget[]=[];
  readyAt=0;
  private signature='';
  update(targets:ReadingTarget[],now=Date.now()){
    this.targets=targets.slice(0,3);
    const signature=JSON.stringify(this.targets.map(t=>targetKey(t.copyId,t.page,t.mode)));
    if(signature===this.signature)return false;
    this.signature=signature;this.readyAt=now+450;return true;
  }
  ready(now=Date.now()){return now>=this.readyAt?this.targets:[];}
}

export function needsTranslation(page:Page,mode:Mode,language:string,userId:string,origin:string){
  const t=pageTranslation(page,mode,language,userId,origin);
  // Failed, cancelled and uncertain requests require an explicit retry, never a scroll loop.
  return !t.pending&&!t.ready&&!t.latest;
}

export async function automaticManifest(target:ReadingTarget,scope:string,language:string,rights:ModeEntitlement,getBlob:(key:string)=>Promise<Blob|undefined>,rerunJobId?:string):Promise<UploadManifest>{
  const {page,copyId,mode}=target;
  const blob=page.blobKey?await getBlob(page.blobKey):undefined;
  const sha=page.imageSha256??(blob?await hashFile(blob):undefined);
  if(!sha||!(blob?.size??page.imageByteSize))throw Error('原图尚未就绪，请完成采集或重新导入。');
  const id=targetKey(copyId,page,mode);
  return {id:JSON.stringify([scope,language,id]),scope,title:page.name,mode,language,quotaKind:rights.quota_kind,
    automatic:true,maxQuotaPages:exhausted(rights)?0:1,regenerate:!!rerunJobId,rerunJobId,continuous:true,paused:false,createdAt:Date.now(),
    items:[{id:page.id,copyId,pageId:page.id,blobKey:page.blobKey,state:'local',image:{client_item_id:page.id,...pageSource(page),image_sha256:sha,byte_size:blob?.size??page.imageByteSize!,content_type:blob?.type||page.imageMime||'image/png',name:page.name,...(page.assetId?{asset_id:page.assetId}:{})}}]};
}
