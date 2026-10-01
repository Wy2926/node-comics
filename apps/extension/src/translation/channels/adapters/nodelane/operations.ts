import {msg} from '../../../../i18n/runtime';
import {Sha256} from '../../../../importers/hash';
import {parsePageReference} from '../../../../comics/pages/identity';
import type {ModeEntitlement,TranslationInput} from '../../../../types';
import {targetKey,type ReadingTarget} from '../../../automatic';
import type {LocalOperation} from './store';
import type {PreparedInput} from '../../../input/prepare';

const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export const exhausted=(rights:ModeEntitlement)=>!rights.allowed||!rights.unlimited&&(rights.quota?.available??0)<=0;
export const quotaErrors=new Set(['DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','PLUS_REQUIRED']);
export const operationId=(scope:string,language:string,target:ReadingTarget)=>digest([scope,language,targetKey(target.entryId,target.page,target.mode)]);

export function makeOperation(target:ReadingTarget,scope:string,language:string,prepared:PreparedInput,action?:{retry_of:string}|{regenerate_of:string}):LocalOperation{
  const {page,entryId,mode}=target;
  const {image,sourceSha256,profile,width,height}=prepared;
  if(!sourceSha256||!image.byte_size)throw Error(msg('原图尚未就绪，请完成采集或重新导入。'));
  const request:TranslationInput=action??{image,mode,target_language:language};
  return {id:operationId(scope,language,target),requestId:crypto.randomUUID(),scope,entryId,pageId:page.id,mode,language,image,sourceSha256,inputProfile:profile,inputSize:profile?{width,height}:undefined,blobKey:page.entryId?undefined:page.blobKey,pageRef:page.blobKey?parsePageReference(page.blobKey):undefined,request,state:'local',createdAt:Date.now()};
}
