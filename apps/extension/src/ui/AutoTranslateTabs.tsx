import {msg} from '../i18n/runtime';
import {useEffect,useId,useState} from 'react';
import type {Settings} from '../types';
import {automaticTabUrl,matchAutomaticTab} from '../inline/auto-tab-rules';
import {runAutoTabRegex} from '../inline/auto-tab-regex';
import {autoTranslateScopeLabel,useAutoTranslateSettings} from './useAutoTranslateSettings';
import './auto-translate-tabs.css';

export function AutoTranslateTabs({preferences,tab,onSaved,onEdit,disabled=false}:{preferences:Settings;tab?:chrome.tabs.Tab;onSaved:(value:Settings)=>void;onEdit:()=>void;disabled?:boolean}){
  const {pending,error,update}=useAutoTranslateSettings(onSaved),hint=useId();
  const url=automaticTabUrl(tab?.url),site=preferences.autoTranslateSites.find(site=>site.hostname===url?.hostname);
  const enabled=site?.enabled===true,[matched,setMatched]=useState<boolean>();
  useEffect(()=>{
    setMatched(undefined);if(!url||!site?.enabled)return;
    const match=matchAutomaticTab(site,url),controller=new AbortController();
    if(match!==undefined)setMatched(match);
    else void runAutoTabRegex(site.value,url.href,controller.signal).then(result=>{if(!controller.signal.aborted)setMatched(result.matches);});
    return()=>controller.abort();
  },[tab?.url,site]);
  async function toggle(){
    if(!url||disabled)return;
    await update(async previous=>{
      if(tab?.id==null||(await chrome.tabs.get(tab.id)).url!==tab.url)throw Error(msg('网页已变化，请重新启动翻译。'));
      const sites=[...previous.autoTranslateSites],index=sites.findIndex(site=>site.hostname===url.hostname);
      const next=index<0?{hostname:url.hostname,enabled:true,scope:'domain' as const,value:''}:{...sites[index],enabled:!sites[index].enabled};
      if(index<0)sites.push(next);else sites[index]=next;
      return {...previous,autoTranslateTabs:previous.autoTranslateTabs||previous.autoTranslateSites.length===0,autoTranslateSites:sites};
    });
  }
  const status=!preferences.autoTranslateTabs?msg('已全局暂停'):matched===undefined?msg('正在检查…'):matched?msg('本页匹配'):msg('本页不匹配');
  return <div className="nc-auto-tabs">
    <div className="nc-auto-tabs-row"><div className="nc-auto-tabs-heading"><b>{msg('在此网站自动翻译')}</b><span id={hint} title={url?.hostname}>{url?.hostname??msg('请切换到普通漫画网页，再打开插件。')}</span></div><button type="button" className={'switch '+(enabled?'on':'')} role="switch" aria-label={msg('在此网站自动翻译')} aria-checked={enabled} aria-describedby={hint} disabled={!url||disabled||pending} onClick={()=>void toggle()}><i/></button></div>
    {enabled&&site&&<div className="nc-auto-tabs-scope"><span title={autoTranslateScopeLabel(site)}>{autoTranslateScopeLabel(site)}</span><span role="status" title={status}>{status}</span><button type="button" disabled={disabled||pending} onClick={onEdit}>{msg('调整范围')}</button></div>}
    {pending&&<p role="status">{msg('正在保存…')}</p>}
    {error&&<p className="nc-auto-tabs-error" role="alert">{error}</p>}
  </div>;
}
