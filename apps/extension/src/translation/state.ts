import {pageTranslation} from '../reader/presentation';
import {supportsLanguage,type Page,type Mode,type Capabilities,type Entitlements} from '../types';
import {quotaErrors,capacityErrors,exhausted,type TranslationState} from './automatic';
import type {UploadManifest} from './store';

/** Shared by the reader and in-page translation. */
export function translationState({page,mode,language,userId,origin,active,caps,rights,error='',manifest}:{page:Page;mode:Mode;language:string;userId?:string;origin:string;active:boolean;caps?:Capabilities;rights?:Entitlements|null;error?:string;manifest?:UploadManifest}):TranslationState|undefined{
  const t=pageTranslation(page,mode,language,userId,origin);
  if(t.pending)return {kind:t.pending.status==='queued'?'waiting':'translating',message:t.pending.status==='outcome_unknown'?'结果核实中':t.pending.status==='queued'?'等待翻译':'翻译中'};
  if(manifest?.pending&&!manifest.paused)return {kind:'translating',message:manifest.error?'正在恢复提交':'翻译中'};
  if(t.latest?.status==='unknown_released')return {kind:'error',message:'原请求结果待核实',retryable:false};
  if(active&&error&&!t.ready)return {kind:'error',message:error};
  if(manifest&&!manifest.paused&&manifest.items.some(i=>i.state==='local'))return {kind:'waiting',message:'等待翻译'};
  if(manifest?.error){
   if(quotaErrors.has(manifest.errorCode??''))return {kind:'upgrade',message:'升级权益，继续翻译'};
   if(capacityErrors.has(manifest.errorCode??''))return {kind:'waiting',message:'等待翻译'};
   return {kind:'error',message:manifest.error};
  }
  if(t.latest?.status==='failed')return {kind:'error',message:t.latest.error?.message??'翻译失败'};
  if(t.ready)return;
  if(t.result?.output_asset_id&&!t.expired)return {kind:page.translationError?'error':'translating',message:page.translationError??'正在读取译图',retryLabel:'点击重新加载'};
  if(t.latest?.status==='no_text')return;
  if(t.latest)return {kind:'error',message:t.expired?'译图已失效':t.latest.error?.message??'翻译已停止'};
  if(!active)return;
  if(page.translationError)return {kind:'error',message:page.translationError};
  if(!userId)return {kind:'login',message:'登录后自动翻译'};
  if(!caps)return {kind:error?'error':'waiting',message:error||'正在连接翻译服务'};
  if(!caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(caps,mode,language))return {kind:'error',message:'此翻译方式暂不可用',retryable:false};
  if(rights&&exhausted(rights.modes[mode]))return {kind:'upgrade',message:'升级权益，继续翻译'};
  if(error)return {kind:'error',message:error};
  return {kind:'waiting',message:'等待翻译'};
}
