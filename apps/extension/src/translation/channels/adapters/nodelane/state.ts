import {msg} from '../../../../i18n/runtime';
import {pageTranslation,taskText} from '../../../../reader/presentation';
import {supportsLanguage,type Page,type Mode,type Capabilities,type Entitlements} from '../../../../types';
import type {TranslationState} from '../../../automatic';
import {quotaErrors,exhausted} from './operations';
import {translationScope,type LocalOperation} from './store';
import {selectedModelAvailable} from '../../../../../../../backend/shared/translation-models';
import {selectedFontAvailable} from '../../../fonts';

const upgradeState=(reason:'not_allowed'|'quota_exhausted'):TranslationState=>({kind:'upgrade',message:reason==='not_allowed'?msg('当前权益不支持'):msg('额度不足')});

export function translationState({page,mode,language,modelId,fontId,userId,origin,active,caps,rights,error='',operation}:{page:Page;mode:Mode;language:string;modelId?:string;fontId?:string;userId?:string;origin:string;active:boolean;caps?:Capabilities;rights?:Entitlements|null;error?:string;operation?:LocalOperation}):TranslationState|undefined{
  if(!userId)return active?{kind:'login',message:msg("登录后自动翻译")}:undefined;
  const t=pageTranslation(page,mode,language,translationScope(origin,userId));
  if(operation?.state==='blocked'){
    const code=operation.errorCode??'';
    if(quotaErrors.has(code))return upgradeState(code==='TRANSLATION_MODEL_NOT_ALLOWED'?'not_allowed':'quota_exhausted');
    return {kind:'error',message:operation.error??msg("此页暂不能翻译"),retryable:!['IDEMPOTENCY_CONFLICT','TRANSLATION_UNAVAILABLE','TRANSLATION_MODE_UNAVAILABLE','SOURCE_CHANGED','OUTCOME_UNKNOWN'].includes(code)};
  }
  if(operation?.state==='uncertain')return {kind:'translating',message:msg("正在恢复翻译请求")};
  if(t.pending)return {kind:t.pending.status==='queued'?'waiting':'translating',message:t.pending.status==='outcome_unknown'?msg("结果核实中"):taskText(t.pending)};
  if(t.latest?.status==='unknown_released')return {kind:'error',message:msg("原请求结果待核实"),retryable:false};
  if(active&&error&&!t.ready)return {kind:'error',message:error};
  if(operation?.state==='local'||operation?.state==='deferred')return {kind:'waiting',message:operation.state==='local'?msg('准备翻译…'):msg('等待翻译')};
  if(t.latest?.status==='failed')return {kind:'error',message:t.latest.error?.message??msg("翻译失败"),retryable:t.latest.error?.code!=='TRANSLATION_UNAVAILABLE'};
  if(t.ready)return;
  if(t.result?.result&&!t.expired)return {kind:page.translationError?'error':'translating',message:page.translationError??msg("正在读取译图"),retryLabel:msg("点击重新加载")};
  if(t.latest?.status==='no_text')return;
  if(t.latest)return {kind:'error',message:t.expired?msg("译图已失效"):t.latest.error?.message??msg("翻译已停止")};
  if(!active)return;
  if(page.translationError)return {kind:'error',message:page.translationError};
  // Baseline capabilities are for local recovery, not evidence of denied access.
  if(!caps||!rights)return {kind:'waiting',message:msg('准备翻译…')};
  if(!selectedFontAvailable(caps.translation_fonts,language,fontId))return {kind:'error',message:msg('此字体暂不可用，请选择其他字体。'),retryable:false};
  if(!selectedModelAvailable(caps.translation_models,modelId)){
    const models=caps.translation_models?.filter(model=>!modelId||model.id===modelId);
    if(models?.some(model=>model.unavailable_reason==='quota_exhausted'))return upgradeState('quota_exhausted');
    if(models?.length&&models.every(model=>model.unavailable_reason==='not_allowed'))return upgradeState('not_allowed');
    return {kind:'error',message:msg('此翻译方式暂不可用'),retryable:false};
  }
  if(!caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(caps,mode,language))return {kind:'error',message:msg("此翻译方式暂不可用"),retryable:false};
  if(exhausted(rights.modes[mode]))return upgradeState(rights.modes[mode].allowed?'quota_exhausted':'not_allowed');
  return {kind:'waiting',message:msg('准备翻译…')};
}
