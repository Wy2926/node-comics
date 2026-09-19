import {pageTranslation} from '../reader/presentation';
import {supportsLanguage,type Page,type Mode,type Capabilities,type Entitlements} from '../types';
import {quotaErrors,exhausted,type TranslationState} from './automatic';
import type {LocalOperation} from './store';

export function translationState({page,mode,language,userId,origin,active,caps,rights,error='',operation}:{page:Page;mode:Mode;language:string;userId?:string;origin:string;active:boolean;caps?:Capabilities;rights?:Entitlements|null;error?:string;operation?:LocalOperation}):TranslationState|undefined{
  const t=pageTranslation(page,mode,language,userId,origin);
  if(t.pending)return {kind:t.pending.status==='queued'?'waiting':'translating',message:t.pending.status==='outcome_unknown'?'结果核实中':t.pending.status==='queued'?'等待翻译':'翻译中'};
  if(operation?.state==='uncertain')return {kind:'translating',message:'正在恢复翻译请求'};
  if(t.latest?.status==='unknown_released')return {kind:'error',message:'原请求结果待核实',retryable:false};
  if(active&&error&&!t.ready)return {kind:'error',message:error};
  if(operation?.state==='blocked'){
    const code=operation.result?.code??'';
    if(quotaErrors.has(code))return {kind:'upgrade',message:'升级权益，继续翻译'};
    return {kind:'error',message:operation.result?.message??operation.error??'此页暂不能翻译',retryable:!['IDEMPOTENCY_CONFLICT','OPERATION_ARCHIVED','ASSET_DELETED','OUTCOME_UNKNOWN'].includes(code)};
  }
  if(operation?.state==='local'||operation?.state==='deferred')return {kind:'waiting',message:'等待翻译'};
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
