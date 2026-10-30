import {useEffect,useRef,useState} from 'react';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';
import {automaticTabUrl,type AutoTranslateSite} from '../inline/auto-tab-rules';
import {Icon} from '../icons';
import {SettingRow} from './components';
import {Notification} from './Notification';
import {AutoTranslateSiteEditor} from './AutoTranslateSiteEditor';
import {autoTranslateScopeLabel,useAutoTranslateSettings} from './useAutoTranslateSettings';
import './auto-translate-tabs.css';

export function AutoTranslateSites({preferences,onSaved}:{preferences:Settings;onSaved:(value:Settings)=>void}){
  const {pending,error,update}=useAutoTranslateSettings(onSaved),section=useRef<HTMLElement>(null),current=useRef(preferences);current.current=preferences;
  const [editor,setEditor]=useState<{site?:AutoTranslateSite;sourceUrl?:string}>(),[removed,setRemoved]=useState<AutoTranslateSite>(),[openError,setOpenError]=useState('');
  useEffect(()=>{
    let active=true;
    const open=()=>{
      if(!location.hash.startsWith('#settings/auto-translation'))return;
      section.current?.scrollIntoView({block:'start'});
      const params=new URLSearchParams(location.hash.split('?')[1]),id=Number(params.get('tab'));
      if(!params.has('tab'))return;
      history.replaceState(null,'',location.pathname+location.search+'#settings/auto-translation');
      if(!Number.isSafeInteger(id)||id<0||typeof chrome==='undefined'||!chrome.tabs)return;
      void chrome.tabs.get(id).then(tab=>{
        if(!active)return;
        const url=automaticTabUrl(tab.url);if(!url)return;
        setEditor({site:current.current.autoTranslateSites.find(site=>site.hostname===url.hostname)??{hostname:url.hostname,enabled:false,scope:'domain',value:''},sourceUrl:url.href});
      }).catch(()=>{if(active)setOpenError(msg('无法读取当前标签页，请重新打开插件。'));});
    };
    open();window.addEventListener('hashchange',open);return()=>{active=false;window.removeEventListener('hashchange',open);};
  },[]);
  async function save(site:AutoTranslateSite){
    if(await update(previous=>({...previous,autoTranslateTabs:previous.autoTranslateTabs||previous.autoTranslateSites.length===0,
      autoTranslateSites:[...previous.autoTranslateSites.filter(value=>value.hostname!==site.hostname),site]}))){setEditor(undefined);setRemoved(undefined);}
  }
  return <section ref={section} className="settings-card nc-auto-sites" id="automatic-translation">
    <h3><Icon name="globe"/>{msg('自动翻译网站')}</h3>
    <SettingRow title={msg('标签页自动翻译')} description={msg('仅在已开启的网站内随读随译，关闭后保留网站与范围。')}>
      <button type="button" className={'switch '+(preferences.autoTranslateTabs&&preferences.autoTranslateSites.length?'on':'')} role="switch" aria-label={msg('标签页自动翻译')} aria-checked={preferences.autoTranslateTabs&&preferences.autoTranslateSites.length>0} disabled={pending||!preferences.autoTranslateSites.length} onClick={()=>void update(previous=>({...previous,autoTranslateTabs:!previous.autoTranslateTabs}))}><i/></button>
    </SettingRow>
    <p className="nc-auto-sites-description">{msg('仅匹配标签页网址，不匹配图片地址。')}</p>
    {!preferences.autoTranslateSites.length&&<p className="nc-auto-sites-empty">{msg('还没有自动翻译的网站，请添加网站或在网页打开插件开启。')}</p>}
    {preferences.autoTranslateSites.map(site=><div className="nc-auto-sites-row" key={site.hostname}>
      <div className="nc-auto-sites-domain"><b>{site.hostname}</b>{site.enabled&&<span title={autoTranslateScopeLabel(site)}>{autoTranslateScopeLabel(site)}</span>}</div>
      <button type="button" className="nc-auto-sites-edit" disabled={pending} onClick={()=>setEditor({site})}>{msg('调整范围')}</button>
      <button type="button" className="icon-button" disabled={pending} aria-label={msg('移除网站 {0}',{0:site.hostname})} onClick={()=>void update(previous=>({...previous,autoTranslateSites:previous.autoTranslateSites.filter(value=>value.hostname!==site.hostname)})).then(saved=>{if(saved)setRemoved(site);})}><Icon name="close" size={16}/></button>
      <button type="button" className={'switch '+(site.enabled?'on':'')} role="switch" aria-label={msg('自动翻译 {0}',{0:site.hostname})} aria-checked={site.enabled} disabled={pending} onClick={()=>void update(previous=>({...previous,autoTranslateSites:previous.autoTranslateSites.map(value=>value.hostname===site.hostname?{...value,enabled:!value.enabled}:value)}))}><i/></button>
    </div>)}
    <button type="button" className="button secondary nc-auto-sites-add" disabled={pending} onClick={()=>setEditor({})}><Icon name="plus" size={16}/>{msg('添加网站')}</button>
    {(error||openError)&&!editor&&<p className="inline-error" role="alert">{error||openError}</p>}
    {removed&&<Notification message={msg('已移除网站 {0}',{0:removed.hostname})} tone="success" duration={6000} paused={pending} onClose={()=>setRemoved(undefined)} action={<button type="button" disabled={pending} onClick={()=>void update(previous=>({...previous,autoTranslateSites:previous.autoTranslateSites.some(site=>site.hostname===removed.hostname)?previous.autoTranslateSites:[...previous.autoTranslateSites,removed]})).then(saved=>{if(saved)setRemoved(undefined);})}>{msg('撤销')}</button>}/>}
    {editor&&<AutoTranslateSiteEditor {...editor} pending={pending} error={error} onSave={save} onClose={()=>setEditor(undefined)}/>}
  </section>;
}
