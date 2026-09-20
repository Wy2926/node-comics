import {initializeUiLanguage} from '../../src/i18n/load';
import {msg} from '../../src/i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Icon} from '../../src/icons';
import type {PageManifest} from '../../src/sources/adapters';
import type {SourceCatalog} from '../../src/library/types';
import {initialChoices,refreshChoices,type ImageChoice} from '../../src/sources/selection';
import {sourceMessage} from '../../src/sources/client';
import {SourceImagePicker} from '../../src/ui/SourceImagePicker';
import {AutoTranslateTabs} from '../../src/ui/AutoTranslateTabs';
import {TargetLanguage,withTargetLanguage} from '../../src/ui/TargetLanguage';
import {useAppearance} from '../../src/ui/Appearance';
import {settings,saveSettings} from '../../src/library/store';
import {connectReaderSettings} from '../../src/inline/settings';
import '../../src/styles.css';
import '../../src/redesign.css';
import './popup.css';

type Discovery={kind:'catalog';id:string;catalog:SourceCatalog}|{kind:'pages';id:string;manifest:PageManifest};
type Draft={discovery:Discovery;choices:ImageChoice[];url:string};
function Popup({initialError=''}:{initialError?:string}){
 const [discovery,setDiscovery]=useState<Discovery>(),[choices,setChoices]=useState<ImageChoice[]>([]);
 const [source,setSource]=useState<chrome.tabs.Tab>(),[sourceNotice,setSourceNotice]=useState(msg("正在读取当前标签页…"));
 const [error,setError]=useState(initialError),[discoveryError,setDiscoveryError]=useState('');
 const [busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[translating,setTranslating]=useState(false),[saving,setSaving]=useState(false);
 const previous=useRef<Discovery>(undefined),selection=useRef<ImageChoice[]>([]),lock=useRef(false),openLock=useRef(false),saveLock=useRef(false);
 const [preferences,setPreferences]=useState(settings);useAppearance(preferences);
 const disabled=busy||opening||translating||saving;
 const count=choices.filter(item=>item.selected).length;
 function accept(next:Discovery){
  const last=previous.current;
  const same=last?.kind==='pages'&&next.kind==='pages'&&last.manifest.url===next.manifest.url&&last.manifest.navigationId===next.manifest.navigationId;
  const items=next.kind==='pages'?(same?refreshChoices(selection.current,next.manifest):initialChoices(next.manifest)):[];
  previous.current=next;selection.current=items;setDiscovery(next);setChoices(items);
 }
 async function discover(tab:chrome.tabs.Tab){
  if(lock.current||openLock.current||saveLock.current)return;lock.current=true;setBusy(true);setDiscoveryError('');
  try{
   // Restore a selection only after an explicit discovery request, never on popup open.
   if(!previous.current){const key='nc-popup:'+tab.id,data=await chrome.storage.session.get(key),draft=data[key] as Draft|undefined;if(draft&&draft.url===tab.url){previous.current=draft.discovery;selection.current=draft.choices;}}
   accept(await sourceMessage<Discovery>({type:'NC_DISCOVER_TAB',tabId:tab.id}));
  }catch(e){setDiscoveryError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 useEffect(()=>{
  void chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>{
   if(tab?.id==null||!tab.url||!['https:','http:'].includes(new URL(tab.url).protocol)){setSourceNotice(msg("请切换到普通漫画网页，再打开插件。"));return;}
   setSource(tab);setSourceNotice('');
  }).catch(()=>setSourceNotice(msg("无法读取当前标签页，请重新打开插件。")));
  const changed=(event:StorageEvent)=>{if(event.key==='nc-settings'||event.key===null)setPreferences(settings());};
  window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
 },[]);
 useEffect(()=>{if(discovery&&source?.id!=null&&source.url)void chrome.storage.session.set({['nc-popup:'+source.id]:{discovery,choices,url:source.url} satisfies Draft}).catch(()=>setDiscoveryError(msg("图片选择暂未保存，关闭弹窗后需重新选择。")));},[discovery,choices,source]);
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
   // Keep permission acquisition inside the click gesture, matching the context menu.
   if(!await chrome.permissions.request({origins:['https://*/*','http://*/*']}))throw Error(msg("未获得网页与图片访问权限，可再次点击翻译并授权。"));
   await saveSettings(settings());
   await sourceMessage({type:'NC_TRANSLATE_TAB',tabId:source.id,url:source.url});window.close();
  }catch(e){setError((e as Error).message);}
  finally{openLock.current=false;setTranslating(false);}
 }
 async function grant(){
  if(!source?.url||disabled)return;
  try{if(!await chrome.permissions.request({origins:[new URL(source.url).origin+'/*']}))throw Error(msg("未取得本站权限，可再次授权后发现。"));await discover(source);}
  catch(e){setDiscoveryError((e as Error).message);}
 }
 async function open(useDiscovery=false){
  if(lock.current||openLock.current||saveLock.current)return;openLock.current=true;setOpening(true);setError('');
  try{
   let query='';
   if(useDiscovery&&discovery){
    if(discovery.kind==='catalog')query='?catalog='+discovery.id;
    else{const result=await sourceMessage<{id:string}>({type:'NC_SELECT_MANIFEST',manifestId:discovery.id,itemIds:choices.filter(item=>item.selected).map(item=>item.id)});query='?manifest='+result.id;}
   }
   await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html'+query)});window.close();
  }catch(e){setError((e as Error).message);}finally{openLock.current=false;setOpening(false);}
 }
 async function openSettings(){try{await chrome.runtime.openOptionsPage();window.close();}catch{setError(msg("设置未能打开，请重试。"));}}
 return <main className="nc-app nc-popup">
  <header className="nc-popup-header"><button className="nc-popup-brand" disabled={disabled} onClick={()=>void open()} aria-label={msg("漫译 · 打开漫画管理器")}><span><Icon name="book"/></span><b>{msg("brand.short")}<small>NODELANE COMICS</small></b></button><button className="nc-popup-settings" aria-label={msg("设置")} title={msg("设置")} disabled={disabled} onClick={()=>void openSettings()}><Icon name="settings" size={19}/></button></header>
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
    <p className="nc-popup-hint">{msg("留在原网页，当前图片与后两张随读随译。")}</p>
    {error&&<div className="nc-popup-error" role="alert">{error}</div>}
   </section>
   <section className="nc-popup-import" aria-label={msg("网页图片导入")}>
    <button className="nc-popup-discover" disabled={!source||disabled} onClick={()=>source&&void discover(source)}><Icon name={discovery?'refresh':'layers'} size={18}/><span><b>{busy?msg("正在发现网页图片…"):discovery?msg("刷新网页图片"):msg("发现网页图片")}</b><small>{msg("选择图片，加入漫画管理器")}</small></span><Icon name="arrow" size={17}/></button>
    {busy&&<p className="nc-popup-loading" role="status">{discovery?msg("正在刷新，保留已有选择与顺序…"):msg("正在读取网页图片…")}</p>}
    {discoveryError&&<div className="nc-popup-error" role="alert"><p>{discoveryError}</p>{source&&<button disabled={disabled} onClick={()=>void grant()}>{msg("授权本站并重试")}</button>}</div>}
    {discovery?.kind==='pages'&&<div className="nc-popup-results"><SourceImagePicker choices={choices} disabled={disabled} onChange={items=>{selection.current=items;setChoices(items);}}/><p className="nc-popup-note">{discovery.manifest.note}</p></div>}
    {discovery?.kind==='catalog'&&<div className="nc-popup-catalog"><Icon name="layers" size={24}/><h2>{discovery.catalog.title}</h2><p>{msg("{0} 个来源条目 · {1} 个分组", {"0": discovery.catalog.entries.length, "1": discovery.catalog.groups.length})}</p><small>{discovery.catalog.note}</small></div>}
    {discovery&&<button className="button secondary full nc-popup-add" disabled={disabled||discovery.kind==='pages'&&!count} onClick={()=>void open(true)}>{opening?msg("正在打开…"):discovery.kind==='catalog'?msg("选择目录导入范围"):msg("加入漫画 · {0} 张", {"0": count})}<Icon name="arrow" size={16}/></button>}
   </section>
  </div>
  <footer className="nc-popup-footer"><button disabled={disabled} onClick={()=>void open()}><Icon name="folder" size={18}/><span>{msg("漫画管理器")}<small>{msg("继续阅读 / 导入本地漫画")}</small></span><Icon name="arrow" size={16}/></button></footer>
 </main>;
}
void connectReaderSettings(settings()).then(()=>'',()=> msg("偏好暂未同步，请重新打开插件重试。")).then(async initialError=>{await initializeUiLanguage();return initialError;}).then(initialError=>createRoot(document.getElementById('root')!).render(<Popup initialError={initialError}/>));
