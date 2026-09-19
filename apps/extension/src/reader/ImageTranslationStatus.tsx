import type {TranslationState} from '../translation/automatic';
import {TaskActivity} from './TaskActivity';
import {Icon} from '../icons';

export function ImageTranslationStatus({state,onUpgrade,onLogin,onRetry}:{state?:TranslationState;onUpgrade:()=>void;onLogin:()=>void;onRetry:()=>void}){
  if(!state)return null;
  const action=state.kind==='upgrade'?onUpgrade:state.kind==='login'?onLogin:state.kind==='error'&&state.retryable!==false?onRetry:undefined;
  const retryLabel=state.retryLabel??'点击重新生成';
  const content=<>{(state.kind==='waiting'||state.kind==='translating')&&<TaskActivity waiting={state.kind==='waiting'}/>}<span className="nc-translation-message">{state.message}</span>{state.kind==='error'&&action&&<span className="nc-translation-retry"><Icon name="refresh" size={14}/>{retryLabel}</span>}</>;
  return action?<button className={`nc-image-translation ${state.kind}`} title={state.message} aria-label={state.kind==='error'?`${state.message} · ${retryLabel}`:state.message} onClick={e=>{e.stopPropagation();action();}}>{content}</button>:<div className={`nc-image-translation ${state.kind}`} role="status">{content}</div>;
}
