import {msg} from '../i18n/runtime';
import type {TranslationState} from '../translation/automatic';
import {TaskActivity} from './TaskActivity';
import {Icon} from '../icons';
import {useEffect,useId,useRef,useState} from 'react';
import {translationNotice} from '../translation/notice';
import './image-notices.css';

export function ImageTranslationStatus({state,onUpgrade,onLogin,onRetry,onManageResources}:{state?:TranslationState;onUpgrade:()=>void;onLogin:()=>void;onRetry:()=>void|Promise<void>;onManageResources?:()=>void}){
  const [retrying,setRetrying]=useState(false),[failure,setFailure]=useState<TranslationState>();
  const [dismissed,setDismissed]=useState<string>();
  const locked=useRef(false),compact=useRef<HTMLButtonElement>(null);
  const detailId=useId(),upstream=JSON.stringify(state);
  useEffect(()=>setFailure(undefined),[upstream]);
  const current=failure??state;
  const signature=JSON.stringify(current);
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
    const manage=notice.resourceAction?onManageResources:undefined;
    if(dismissed===signature)return <button ref={compact} className={`nc-image-translation ${state.kind} is-collapsed`} title={notice.detail} aria-label={manage?notice.resourceAction:notice.label} aria-haspopup={manage?'dialog':undefined} aria-expanded={action||manage?undefined:false} onClick={e=>{e.stopPropagation();if(manage)manage();else if(action)void action();else setDismissed(undefined);}}><Icon name={manage?'download':state.kind==='error'&&action?'refresh':'info'} size={16}/></button>;
    const showDetail=notice.detail!==notice.message;
    return <div className={`nc-image-translation ${state.kind} is-dismissible`} title={notice.detail} onClick={e=>e.stopPropagation()}>
      {action?<button className="nc-image-translation-action" aria-label={notice.label} aria-describedby={showDetail?detailId:undefined} onClick={()=>void action()}>{content}</button>:<div className="nc-image-translation-body" role="status">{content}</div>}
      <button className="nc-image-translation-dismiss" aria-label={msg('关闭错误提示')} onClick={e=>{e.stopPropagation();setDismissed(signature);}}><Icon name="close" size={14}/></button>
      {showDetail&&<div id={detailId} className="nc-translation-detail" role="status">{notice.detail}</div>}
      {manage&&<button type="button" className="nc-image-translation-action nc-translation-resources" aria-haspopup="dialog" aria-describedby={showDetail?detailId:undefined} onClick={manage}><Icon name="download" size={14}/>{notice.resourceAction}</button>}
    </div>;
  }
  return action?<button className={`nc-image-translation ${state.kind}`} title={notice.detail} aria-label={notice.label} onClick={e=>{e.stopPropagation();void action();}}>{content}</button>:<div className={`nc-image-translation ${state.kind}`} title={notice.detail} role="status">{content}</div>;
}
