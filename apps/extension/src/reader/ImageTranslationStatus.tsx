import type {TranslationState} from '../translation/automatic';
import {TaskActivity} from './TaskActivity';

export function ImageTranslationStatus({state,onUpgrade,onLogin,onRetry}:{state?:TranslationState;onUpgrade:()=>void;onLogin:()=>void;onRetry:()=>void}){
  if(!state)return null;
  const action=state.kind==='upgrade'?onUpgrade:state.kind==='login'?onLogin:state.kind==='error'?onRetry:undefined;
  const content=<>{(state.kind==='waiting'||state.kind==='translating')&&<TaskActivity waiting={state.kind==='waiting'}/>}<span>{state.message}</span></>;
  return action?<button className={`nc-image-translation ${state.kind}`} title={state.message} onClick={e=>{e.stopPropagation();action();}}>{content}</button>:<div className={`nc-image-translation ${state.kind}`} role="status">{content}</div>;
}
