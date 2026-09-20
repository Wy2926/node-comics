import {msg} from '../i18n/runtime';
import type {TranslationState} from '../translation/automatic';
import {TaskActivity} from './TaskActivity';
import {Icon} from '../icons';
import {useEffect,useRef,useState} from 'react';
import {translationNotice} from '../translation/notice';

export function ImageTranslationStatus({state,onUpgrade,onLogin,onRetry}:{state?:TranslationState;onUpgrade:()=>void;onLogin:()=>void;onRetry:()=>void|Promise<void>}){
  const [retrying,setRetrying]=useState(false),[failure,setFailure]=useState<TranslationState>();
  const locked=useRef(false);
  useEffect(()=>setFailure(undefined),[state?.kind,state?.message]);
  async function retry(){
    if(locked.current)return;locked.current=true;setFailure(undefined);setRetrying(true);
    try{await onRetry();}catch(error){setFailure({kind:'error',message:error instanceof Error?error.message:msg("重试失败")});}
    finally{locked.current=false;setRetrying(false);}
  }
  if(retrying)return <button className="nc-image-translation translating" disabled aria-busy="true" aria-label={msg("重试中")}><TaskActivity/><span>{msg("重试中…")}</span></button>;
  state=failure??state;
  if(!state)return null;
  const action=state.kind==='upgrade'?onUpgrade:state.kind==='login'?onLogin:state.kind==='error'&&state.retryable!==false?retry:undefined;
  const notice=translationNotice(state);
  const content=<>{(state.kind==='waiting'||state.kind==='translating')&&<TaskActivity waiting={state.kind==='waiting'}/>}<span className="nc-translation-message">{notice.message}</span>{notice.action&&action&&<span className="nc-translation-retry">{state.kind==='error'&&<Icon name="refresh" size={14}/>}{notice.action}</span>}</>;
  return action?<button className={`nc-image-translation ${state.kind}`} title={notice.detail} aria-label={notice.label} onClick={e=>{e.stopPropagation();void action();}}>{content}</button>:<div className={`nc-image-translation ${state.kind}`} title={notice.detail} role="status">{content}</div>;
}
