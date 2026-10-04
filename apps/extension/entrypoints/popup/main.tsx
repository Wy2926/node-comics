import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeUiLanguage } from '../../src/i18n/load';
import { msg } from '../../src/i18n/runtime';
import { requireHostAccess } from '../../src/host-permissions';
import { Icon } from '../../src/icons';
import { connectReaderSettings } from '../../src/inline/settings';
import { saveSettings, settings } from '../../src/comics/application/preferences';
import '../../src/redesign.css';
import { sourceFor, sourceMessage } from '../../src/sources';
import '../../src/styles.css';
import { useAppearance } from '../../src/ui/Appearance';
import { AutoTranslateTabs } from '../../src/ui/AutoTranslateTabs';
import { BrandLogo } from '../../src/ui/BrandLogo';
import { TargetLanguage } from '../../src/ui/TargetLanguage';
import './popup.css';
import {Scrollbars} from '../../src/ui/Scrollbars';
import {useShortcutPreferences,useShortcuts} from '../../src/shortcuts/react';
import type {ShortcutId} from '../../src/shortcuts/catalog';
import {activeBindings,resolveBindings} from '../../src/shortcuts/model';
import {formatBinding} from '../../src/shortcuts/keys';
import {browserShortcutBinding,readBrowserShortcuts,type BrowserShortcuts} from '../../src/shortcuts/native';

type Discovery={kind:'catalog'|'pages';id:string};
function Popup({initialError=''}:{initialError?:string}){
 const [source,setSource]=useState<chrome.tabs.Tab>(),[sourceNotice,setSourceNotice]=useState(msg("正在读取当前标签页…"));
 const [error,setError]=useState(initialError),[discoveryError,setDiscoveryError]=useState('');
 const [busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[translating,setTranslating]=useState<'tab'|'region'>(),[saving,setSaving]=useState(false);
 const lock=useRef(false),openLock=useRef(false),saveLock=useRef(false);
 const [preferences,setPreferences]=useState(settings);useAppearance(preferences);
 const shortcuts=useShortcutPreferences(),[browserShortcuts,setBrowserShortcuts]=useState<BrowserShortcuts>({});
 const nativeBindings=Object.values(browserShortcuts).map(browserShortcutBinding);
 const bindings=useMemo(()=>activeBindings(shortcuts.overrides),[shortcuts.overrides]);
 const disabled=busy||opening||!!translating||saving;
 const resolved=source?.url?sourceFor(source.url):undefined;
 const adapted=!!resolved&&resolved.definition.id!=='generic';
 const importable=!!resolved?.definition.capabilities.importable&&resolved.location.kind!=='other';
 async function readSource(){
  if(!source?.url||!importable||disabled||lock.current)return;lock.current=true;setBusy(true);setDiscoveryError('');
  try{await requireHostAccess();
   const discovered=await sourceMessage<Discovery>({type:'NC_DISCOVER_TAB',tabId:source.id});
   await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html?'+(discovered.kind==='catalog'?'catalog':'manifest')+'='+discovered.id)});window.close();
  }catch(e){setDiscoveryError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 async function findComic(){
  if(!source?.url||source.id==null||!importable||disabled||lock.current)return;
  lock.current=true;setBusy(true);setDiscoveryError('');
  try{
   await requireHostAccess();
   await sourceMessage({type:'NC_SEARCH_TAB',tabId:source.id,url:source.url});window.close();
  }catch(e){setDiscoveryError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 useEffect(()=>{
  let active=true;void readBrowserShortcuts().then(value=>{if(active)setBrowserShortcuts(value);}).catch(()=>{});
  void chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}).catch(()=>{});
  void chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>{
   if(tab?.id==null||!tab.url||!['https:','http:'].includes(new URL(tab.url).protocol)){setSourceNotice(msg("请切换到普通漫画网页，再打开插件。"));return;}
   setSource(tab);setSourceNotice('');
  }).catch(()=>setSourceNotice(msg("无法读取当前标签页，请重新打开插件。")));
  const changed=(event:StorageEvent)=>{if(event.key==='nc-settings'||event.key===null)setPreferences(settings());};
  window.addEventListener('storage',changed);return()=>{active=false;window.removeEventListener('storage',changed);};
 },[]);
 async function changeLanguage(language:string){
  if(saveLock.current)return;saveLock.current=true;setSaving(true);setError('');
  const next={...settings(),language};setPreferences(next);
  try{await saveSettings(next);}catch{setError(msg("语言未能同步，请重新选择后再翻译。"));}
  finally{saveLock.current=false;setSaving(false);}
 }
 async function translate(kind:'tab'|'region'='tab'){
  if(source?.id==null||lock.current||openLock.current||saveLock.current)return;
  openLock.current=true;setTranslating(kind);setError('');
  try{
   await requireHostAccess();
   await saveSettings(settings());
   await sourceMessage({type:kind==='region'?'NC_TRANSLATE_REGION':'NC_TRANSLATE_TAB',tabId:source.id,url:source.url});window.close();
  }catch(e){setError((e as Error).message);}
  finally{openLock.current=false;setTranslating(undefined);}
 }
 async function openSettings(){if(disabled||openLock.current)return;openLock.current=true;setOpening(true);try{await chrome.runtime.openOptionsPage();window.close();}catch{setError(msg("设置未能打开，请重试。"));}finally{openLock.current=false;setOpening(false);}}
 async function openPage(hash=''){
  if(disabled||openLock.current)return;openLock.current=true;setOpening(true);
  try{
   const page=new URL(chrome.runtime.getURL('/reader.html'));page.hash=hash;
   if(hash==='sites/request'){
    const tab=source??(await chrome.tabs.query({active:true,currentWindow:true}).catch(()=>[]))[0];
    if(tab?.url){
     const url=new URL(tab.url);
     if(['https:','http:'].includes(url.protocol)){
      const definition=sourceFor(tab.url).definition;
      let name=(definition.id!=='generic'?definition.sites?.find(site=>new URL(site.url).hostname===url.hostname)?.name??definition.name:tab.title)||url.hostname;
      if(tab.id!=null)try{
       const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({
        origin:location.origin,
        title:document.title.trim(),
        name:document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim()
         ||document.querySelector('meta[name="application-name"]')?.getAttribute('content')?.trim(),
       })});
       if(result?.origin===url.origin)name=result.name||(definition.id==='generic'?result.title||url.hostname:name);
      }catch{/* The tab title and adapter name remain available when page access is restricted. */}
      page.search=new URLSearchParams({site_url:url.origin+'/',site_name:(name.replace(/\s+/g,' ').trim()||url.hostname).slice(0,100)}).toString();
     }
    }
   }
   await chrome.tabs.create({url:page.href});window.close();
  }catch(e){setError((e as Error).message);}finally{openLock.current=false;setOpening(false);}
 }
 const handlers={
  'web.shortcuts':()=>{void openPage('settings/shortcuts');},
  'app.library':()=>{void openPage();},
  'app.settings':()=>{void openSettings();},
 };
 useShortcuts(handlers,{enabled:!disabled});
 function shortcutHint(id:ShortcutId){
  const visible=shortcuts.ready?resolveBindings(id,shortcuts.overrides).filter(binding=>!nativeBindings.includes(binding)&&bindings.get(binding)?.find(candidate=>Object.hasOwn(handlers,candidate))===id):[];
  return visible.length?<span className="nc-popup-shortcut" aria-hidden="true">{visible.map(binding=><kbd key={binding}>{formatBinding(binding)}</kbd>)}</span>:null;
 }
 function nativeShortcutHint(name:keyof BrowserShortcuts){
  const binding=browserShortcutBinding(browserShortcuts[name]);
  return binding?<span className="nc-popup-shortcut" aria-hidden="true"><kbd>{formatBinding(binding)}</kbd></span>:null;
 }
 return <main className="nc-app nc-popup"><Scrollbars/>
  <header className="nc-popup-header"><button className="nc-popup-brand" disabled={disabled} onClick={()=>void openPage()} aria-label={msg('打开我的漫画')}><BrandLogo/></button><span className="nc-popup-tagline">{msg('随读随译')}</span></header>
  <div className="nc-popup-scroll">
   <section className="nc-popup-translation" aria-label={msg("网页翻译")}>
    <div className="nc-popup-section-heading"><h1>{msg('网页翻译')}</h1>{adapted&&<span className="nc-comic-tag nc-popup-adapted"><Icon name="check" size={14}/>{msg('已适配')}</span>}<button className="nc-popup-request" disabled={disabled} onClick={()=>void openPage('sites/request')}>{msg('申请适配网站')}<Icon name="external" size={13}/></button></div>
    {sourceNotice&&<p className="nc-popup-notice" role="status">{sourceNotice}</p>}
    <div className="nc-popup-language"><div><b>{msg("翻译成")}</b><p id="popup-language-hint">{msg("与设置中的默认目标语言同步")}</p></div><TargetLanguage value={preferences.language} onChange={language=>void changeLanguage(language)} disabled={disabled} describedBy="popup-language-hint"/></div>
    <AutoTranslateTabs enabled={preferences.autoTranslateTabs} onSaved={setPreferences} disabled={disabled}/>
    <button className="button primary full nc-comic-action" disabled={!source||disabled} onClick={()=>void translate()}><span className="nc-popup-action-label">{translating==='tab'?<><span className="spinner"/>{msg("正在启动翻译…")}</>:<><Icon name="spark" size={20}/>{msg("翻译当前标签页")}</>}</span>{nativeShortcutHint('nc-translate-tab')}</button>
    <p className="nc-popup-hint">{msg("留在原网页，当前图片与后三张随读随译。")}</p>
    {error&&<div className="nc-popup-error" role="alert">{error}</div>}
   </section>
   {importable&&<section className="nc-popup-import" aria-label={msg('漫画阅读')}>
    <h2>{msg('漫画阅读')}</h2><div className="nc-popup-reading-actions">
    <button className="nc-popup-tool" disabled={disabled} onClick={()=>void readSource()}><Icon name="book" size={22}/><span>{busy?msg('正在打开漫画'):msg('开始阅读')}</span><Icon name="arrow" size={16}/></button>
    {resolved?.definition.capabilities.findAlternatives!==false&&<button className="nc-popup-tool" disabled={disabled} onClick={()=>void findComic()}><Icon name="translate" size={22}/><span>{msg('寻找其他语言')}</span></button>}
    </div>
    {discoveryError&&<div className="nc-popup-error" role="alert">{discoveryError}</div>}
   </section>}
   <section className="nc-popup-tools" aria-label={msg('我的漫画')}>
    <div className="nc-popup-tool-grid">
     <button className="nc-popup-tool nc-popup-region" disabled={!source||disabled} onClick={()=>void translate('region')}><Icon name="expand" size={23}/><span>{translating==='region'?msg('正在启动翻译…'):msg('划图翻译')}</span>{nativeShortcutHint('nc-translate-region')}</button>
     <button className="nc-popup-tool nc-popup-library nc-comic-paper" disabled={disabled} onClick={()=>void openPage()}><Icon name="folder" size={23}/><span>{msg('我的漫画')}</span>{shortcutHint('app.library')}</button>
     <button className="nc-popup-tool" disabled={disabled} onClick={()=>void openSettings()}><Icon name="settings" size={23}/><span>{msg('设置')}</span>{shortcutHint('app.settings')}</button>
     <button className="nc-popup-tool" disabled={disabled} onClick={()=>void openPage('settings/shortcuts')}><Icon name="keyboard" size={23}/><span>{msg('键盘快捷键')}</span>{shortcutHint('web.shortcuts')}</button>
    </div>
    {source&&!adapted&&<p className="nc-popup-hint nc-popup-site-hint">{msg('此网站尚未专门适配，不能导入漫画。')}</p>}
    {adapted&&!importable&&resolved?.definition.capabilities.importable&&<p className="nc-popup-hint nc-popup-site-hint">{msg('进入漫画详情页或章节页后，可开始阅读。')}</p>}
   </section>
  </div>
 </main>;
}
void connectReaderSettings(settings()).then(()=>'',()=> msg("偏好暂未同步，请重新打开插件重试。")).then(async initialError=>{await initializeUiLanguage();return initialError;}).then(initialError=>createRoot(document.getElementById('root')!).render(<Popup initialError={initialError}/>));
