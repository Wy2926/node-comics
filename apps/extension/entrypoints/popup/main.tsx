import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeUiLanguage } from '../../src/i18n/load';
import { msg } from '../../src/i18n/runtime';
import { requireHostAccess } from '../../src/host-permissions';
import { Icon } from '../../src/icons';
import { connectReaderSettings } from '../../src/inline/settings';
import { saveSettings, settings } from '../../src/comics/application/preferences';
import type { SourceCatalog } from '../../src/comics/application/types';
import '../../src/redesign.css';
import type { PageManifest } from '../../src/sources';
import { sourceFor, sourceMessage } from '../../src/sources';
import '../../src/styles.css';
import { useAppearance } from '../../src/ui/Appearance';
import { AutoTranslateTabs } from '../../src/ui/AutoTranslateTabs';
import { BrandLogo } from '../../src/ui/BrandLogo';
import { TargetLanguage, withTargetLanguage } from '../../src/ui/TargetLanguage';
import './popup.css';

type Discovery={kind:'catalog';id:string;catalog:SourceCatalog}|{kind:'pages';id:string;manifest:PageManifest};
function Popup({initialError=''}:{initialError?:string}){
 const [source,setSource]=useState<chrome.tabs.Tab>(),[sourceNotice,setSourceNotice]=useState(msg("正在读取当前标签页…"));
 const [error,setError]=useState(initialError),[discoveryError,setDiscoveryError]=useState('');
 const [busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[translating,setTranslating]=useState(false),[saving,setSaving]=useState(false);
 const lock=useRef(false),openLock=useRef(false),saveLock=useRef(false);
 const [preferences,setPreferences]=useState(settings);useAppearance(preferences);
 const disabled=busy||opening||translating||saving;
 const resolved=source?.url?sourceFor(source.url):undefined;
 const importable=!!resolved?.definition.capabilities.importable&&resolved.location.kind!=='other';
 async function readSource(){
  if(!source?.url||!importable||disabled)return;lock.current=true;setBusy(true);setDiscoveryError('');
  try{await requireHostAccess();
   const discovered=await sourceMessage<Discovery>({type:'NC_DISCOVER_TAB',tabId:source.id});
   await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html?'+(discovered.kind==='catalog'?'catalog':'manifest')+'='+discovered.id)});window.close();
  }catch(e){setDiscoveryError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 async function findComic(){
  if(!source?.url||source.id==null||!importable||disabled)return;
  lock.current=true;setBusy(true);setDiscoveryError('');
  try{
   await requireHostAccess();
   await sourceMessage({type:'NC_SEARCH_TAB',tabId:source.id,url:source.url});window.close();
  }catch(e){setDiscoveryError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 useEffect(()=>{
  void chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}).catch(()=>{});
  void chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>{
   if(tab?.id==null||!tab.url||!['https:','http:'].includes(new URL(tab.url).protocol)){setSourceNotice(msg("请切换到普通漫画网页，再打开插件。"));return;}
   setSource(tab);setSourceNotice('');
  }).catch(()=>setSourceNotice(msg("无法读取当前标签页，请重新打开插件。")));
  const changed=(event:StorageEvent)=>{if(event.key==='nc-settings'||event.key===null)setPreferences(settings());};
  window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
 },[]);
 async function changeLanguage(language:string){
  if(saveLock.current)return;saveLock.current=true;setSaving(true);setError('');
  const next=withTargetLanguage(settings(),language);setPreferences(next);
  try{await saveSettings(next);}catch{setError(msg("语言未能同步，请重新选择后再翻译。"));}
  finally{saveLock.current=false;setSaving(false);}
 }
 async function translate(){
  if(source?.id==null||lock.current||openLock.current||saveLock.current)return;
  openLock.current=true;setTranslating(true);setError('');
  try{
   await requireHostAccess();
   await saveSettings(settings());
   await sourceMessage({type:'NC_TRANSLATE_TAB',tabId:source.id,url:source.url});window.close();
  }catch(e){setError((e as Error).message);}
  finally{openLock.current=false;setTranslating(false);}
 }
 async function open(){if(disabled)return;setOpening(true);try{await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html')});window.close();}catch(e){setError((e as Error).message);}finally{setOpening(false);}}
 async function openSettings(){try{await chrome.runtime.openOptionsPage();window.close();}catch{setError(msg("设置未能打开，请重试。"));}}
 return <main className="nc-app nc-popup">
  <header className="nc-popup-header"><button className="nc-popup-brand" disabled={disabled} onClick={()=>void open()} aria-label={msg('打开我的漫画')}><BrandLogo/></button><button className="nc-popup-settings" aria-label={msg("设置")} title={msg("设置")} disabled={disabled} onClick={()=>void openSettings()}><Icon name="settings" size={19}/></button></header>
  <div className="nc-popup-scroll">
   <section className="nc-popup-cover nc-comic-paper">
    <div className="nc-popup-kicker"><Icon name="spark" size={14}/>{msg("YOUR NEXT CHAPTER")}<span>{msg("随读随译")}</span></div>
    <h1>{msg("好故事，")}<br/><em>{msg("用你的语言继续。")}</em></h1>
    <span className="nc-popup-star" aria-hidden="true">✳</span>
    <div className="nc-popup-source"><Icon name="globe" size={16}/><div><b title={source?.title}>{source?.title||msg("当前标签页")}</b><span>{source?.url?new URL(source.url).hostname:sourceNotice}</span></div></div>
   </section>
   <section className="nc-popup-translation" aria-label={msg("网页翻译")}>
    <div className="nc-popup-language"><div><b>{msg("翻译成")}</b><p id="popup-language-hint">{msg("与设置中的默认目标语言同步")}</p></div><TargetLanguage value={preferences.language} onChange={language=>void changeLanguage(language)} disabled={disabled} describedBy="popup-language-hint"/></div>
    <AutoTranslateTabs enabled={preferences.autoTranslateTabs} onSaved={setPreferences} disabled={disabled}/>
    <button className="button primary full nc-comic-action" disabled={!source||disabled} onClick={()=>void translate()}>{translating?<><span className="spinner"/>{msg("正在启动翻译…")}</>:<><Icon name="spark" size={18}/>{msg("翻译当前标签页")}<Icon name="arrow" size={18}/></>}</button>
    <p className="nc-popup-hint">{msg("留在原网页，当前图片与后三张随读随译。")}</p>
    {error&&<div className="nc-popup-error" role="alert">{error}</div>}
   </section>
   <section className="nc-popup-import" aria-label={msg('漫画阅读')}>
    {importable&&<button className="button secondary full" disabled={disabled} onClick={()=>void findComic()}><Icon name="globe"/>{msg('寻找其他语言')}</button>}
    {importable?<button className="button secondary full" disabled={disabled} onClick={()=>void readSource()}><Icon name="book"/>{busy?msg('正在打开漫画'):msg('开始阅读')}</button>:<p className="nc-popup-hint">{msg('此网站尚未专门适配，不能导入漫画。')}</p>}
    {discoveryError&&<div className="nc-popup-error" role="alert">{discoveryError}</div>}
   </section>
  </div>
  <footer className="nc-popup-footer"><button disabled={disabled} onClick={()=>void open()}><Icon name="folder" size={18}/><span>{msg('我的漫画')}<small>{msg("继续阅读 / 导入本地漫画")}</small></span><Icon name="arrow" size={16}/></button></footer>
 </main>;
}
void connectReaderSettings(settings()).then(()=>'',()=> msg("偏好暂未同步，请重新打开插件重试。")).then(async initialError=>{await initializeUiLanguage();return initialError;}).then(initialError=>createRoot(document.getElementById('root')!).render(<Popup initialError={initialError}/>));
