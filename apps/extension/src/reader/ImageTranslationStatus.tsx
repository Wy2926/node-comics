import {msg} from '../i18n/runtime';
import type {TranslationState} from '../translation/automatic';
import {TaskActivity} from './TaskActivity';
import {Icon} from '../icons';
import {useEffect,useRef,useState} from 'react';
import {translationNotice} from '../translation/notice';
import './image-notices.css';

export function ImageTranslationStatus({state,onUpgrade,onLogin,onRetry}:{state?:TranslationState;onUpgrade:()=>void;onLogin:()=>void;onRetry:()=>void|Promise<void>}){
  const [retrying,setRetrying]=useState(false),[failure,setFailure]=useState<TranslationState>();
  const [dismissed,setDismissed]=useState<string>();
  const locked=useRef(false),compact=useRef<HTMLButtonElement>(null);
  const upstream=JSON.stringify(state&&[state.kind,state.message,state.retryable,state.retryLabel,state.retryAction]);
  useEffect(()=>setFailure(undefined),[upstream]);
  const current=failure??state;
  const signature=JSON.stringify(current&&[current.kind,current.message,current.retryable,current.retryLabel,current.retryAction]);
  useEffect(()=>setDismissed(undefined),[signature]);
  useEffect(()=>{if(dismissed===signature)compact.current?.focus({preventScroll:true});},[dismissed,signature]);
  async function retry(){
    if(locked.current)return;locked.current=true;setDismissed(undefined);setFailure(undefined);setRetrying(true);
    try{await onRetry();}catch(error){setFailure({kind:'error',message:error instanceof Error?error.message:msg("重试失败")});}
    finally{locked.current=false;setRetrying(false);}
  }
  if(retrying)return <button className="nc-image-translation translating" disabled aria-busy="true" aria-label={msg("重试中")}><TaskActivity/><span>{msg("重试中…")}</span></button>;
  state=current;
  if(!state)return null;
  const action=state.kind==='upgrade'?onUpgrade:state.kind==='login'?onLogin:state.kind==='error'&&state.retryable!==false?retry:undefined;
  const notice=translationNotice(state);
  const content=<>{(state.kind==='waiting'||state.kind==='translating')&&<TaskActivity waiting={state.kind==='waiting'}/>}<span className="nc-translation-message">{notice.message}</span>{notice.action&&action&&<span className="nc-translation-retry">{state.kind==='error'&&<Icon name="refresh" size={14}/>}{notice.action}</span>}</>;
  if(state.kind==='error'||state.kind==='login'||state.kind==='upgrade'){
    if(dismissed===signature)return <button ref={compact} className={`nc-image-translation ${state.kind} is-collapsed`} title={notice.detail} aria-label={notice.label} aria-expanded={action?undefined:false} onClick={e=>{e.stopPropagation();if(action)void action();else setDismissed(undefined);}}><Icon name={state.kind==='error'&&action?'refresh':'info'} size={16}/></button>;
    return <div className={`nc-image-translation ${state.kind} is-dismissible`} title={notice.detail}>
      {action?<button className="nc-image-translation-action" aria-label={notice.label} onClick={e=>{e.stopPropagation();void action();}}>{content}</button>:<div className="nc-image-translation-body" role="status">{content}</div>}
      <button className="nc-image-translation-dismiss" aria-label={msg('关闭错误提示')} onClick={e=>{e.stopPropagation();setDismissed(signature);}}><Icon name="close" size={14}/></button>
    </div>;
  }
  return action?<button className={`nc-image-translation ${state.kind}`} title={notice.detail} aria-label={notice.label} onClick={e=>{e.stopPropagation();void action();}}>{content}</button>:<div className={`nc-image-translation ${state.kind}`} title={notice.detail} role="status">{content}</div>;
}
