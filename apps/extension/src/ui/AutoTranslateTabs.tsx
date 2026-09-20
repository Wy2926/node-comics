import {msg} from '../i18n/runtime';
import {useId,useRef,useState} from 'react';
import {settings,saveSettings} from '../library/store';
import type {Settings} from '../types';
import {inlineOrigins} from '../inline/auto-tabs';
import './auto-translate-tabs.css';

export function AutoTranslateTabs({enabled,onSaved,disabled=false}:{enabled:boolean;onSaved:(value:Settings)=>void;disabled?:boolean}){
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const lock=useRef(false),hint=useId();
  async function toggle(){
    if(lock.current||disabled)return;lock.current=true;setPending(true);setError('');
    try{
      if(typeof chrome==='undefined'||!chrome.runtime?.id)throw Error(msg("请在浏览器插件中开启标签页自动翻译。"));
      const next=!enabled;
      // Request inside the user's click, before any other asynchronous operation.
      if(next&&!await chrome.permissions.request({origins:[...inlineOrigins]}))throw Error(msg("未获得网站访问权限，自动翻译未开启。可再次点击授权。"));
      const previous=settings(),value={...previous,autoTranslateTabs:next};
      try{await saveSettings(value);}catch(error){await saveSettings(previous).catch(()=>{});throw error;}
      onSaved(value);
    }catch(error){setError(error instanceof Error?error.message:msg("设置未保存，请重试。"));}
    finally{lock.current=false;setPending(false);}
  }
  return <div className="nc-auto-tabs">
    <div className="nc-auto-tabs-row"><div><b>{msg("标签页自动翻译")}</b><p id={hint}>{msg("按大图尺寸筛选候选，使用默认语言随读随译。")}</p></div><button className={'switch '+(enabled?'on':'')} role="switch" aria-label={msg("标签页自动翻译")} aria-checked={enabled} aria-describedby={hint} disabled={disabled||pending} onClick={()=>void toggle()}><i/></button></div>
    {pending&&<p role="status">{enabled?msg("正在关闭…"):msg("正在开启…")}</p>}
    {error&&<p className="nc-auto-tabs-error" role="alert">{error}</p>}
  </div>;
}
