import {msg} from './i18n/runtime';
import {useAutomaticTranslation} from './translation/useAutomaticTranslation';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Icon} from './icons';
import {Modal} from './ui/components';
import {Api} from './api';
import {type Capabilities,type ReadingCopy,type Settings,type Entitlements} from './types';
import * as store from './library/store';
import {emptyPage} from './reader/model';
import {Reader} from './reader/Reader';
import {Preferences} from './ui/Preferences';
import {Library} from './ui/Library';
import {AccountPage} from './ui/Account';
import {useAppearance} from './ui/Appearance';
import type {PageManifest} from './sources/adapters';
import {COMIC_ACCEPT} from './importers/comic';
import {LocalImportQueue} from './library/import-queue';
import {makeCopy,emptyLibrary} from './library/model';
import type {SourceCatalog} from './library/types';
import {readingSequence} from './library/reading';
import {readingDirectory} from './library/directory';
import type {TranslationEdition} from './library/translations';
import {AcquisitionCoordinator,queueCopies,pauseCopies,grantImagePermissions} from './library/acquisition';
import {CatalogImport} from './ui/CatalogImport';
import {LocalImport} from './ui/LocalImport';
import {SourceImport} from './ui/SourceImport';
import {acquireWebImages,insertWebCopy,type WebDestination} from './library/web-import';
import {discoverCatalog} from './sources/client';
import {imageIdentity} from './importers/hash';
import {RequestPool,UPLOAD_CONCURRENCY} from './concurrency';
import {API_BASE,API_ORIGIN,WEBSITE_UPGRADE_URL} from './service';
import {useLogin} from './auth/useLogin';
import {Login} from './ui/Login';
import {useSession} from './auth/useSession';
import {signOut} from './auth/storage';
import {sessionAuthorization} from './auth/session';
import {expiredMessage} from './auth/model';
type View='library'|'settings'|'account';
function viewFromHash():View {const value=location.hash.slice(1);return value==='settings'||value==='account'?value:'library';}
export function App(){
const [copies,setCopies]=useState<ReadingCopy[]>([]);const copiesRef=useRef(copies);copiesRef.current=copies;
const [library,setLibrary]=useState(emptyLibrary);const [catalog,setCatalog]=useState<SourceCatalog>();
const [importError,setImportError]=useState('');const [localImport]=useState(()=>new LocalImportQueue());const [importExpanded,setImportExpanded]=useState(false);
useEffect(()=>{localImport.activate();return()=>localImport.dispose();},[localImport]);
async function reloadLibrary(){const [state,values]=await Promise.all([store.readLibrary(),store.readCopies()]);setLibrary(state);copiesRef.current=values;setCopies(values);setCacheBytes(await store.cacheSize());}
useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>void reloadLibrary().catch(e=>setError(e.message)),60);};window.addEventListener('nc-library-change',changed);const channel=new BroadcastChannel('nc-library');channel.onmessage=changed;const broadcast=()=>channel.postMessage('change');window.addEventListener('nc-library-change',broadcast);return()=>{clearTimeout(timer);channel.close();window.removeEventListener('nc-library-change',changed);window.removeEventListener('nc-library-change',broadcast);};},[]);
async function openCopy(copyId:string,edition?:TranslationEdition,pageId?:string){setNavigationKey(n=>n+1);setReadingEdition(edition);if(edition)setSettings(s=>({...s,translationMode:edition.mode,language:edition.language}));const destination=copiesRef.current.find(c=>c.id===copyId);if(destination&&pageId&&destination.pages.some(p=>p.id===pageId)){store.savePosition(copyId,destination.manifestRevision,{pageId,relativeOffset:0});}setCurrentId(copyId);const copy=copiesRef.current.find(c=>c.id===copyId);if(copy?.sourceEntryId&&(!copy.discoveryComplete||copy.pages.some(p=>!p.blobKey)))try{await queueCopies([copyId],false);}catch(e){setError(msg("原图采集未启动：{0}", {"0": (e as Error).message}));}}
const sourceLock=useRef(false);
async function openSource(url:string,propagateError=false){if(sourceLock.current)return;sourceLock.current=true;setBusy(msg("正在发现来源目录…"));setError('');try{setCatalog(await discoverCatalog(url));setCurrentId(undefined);setView('library');}catch(e){setError((e as Error).message);if(propagateError)throw e;}finally{sourceLock.current=false;setBusy('');}}
function chooseFiles(files:File[]){if(input.current)input.current.value='';if(!files.length)return;setImportExpanded(true);void localImport.add(files).then(added=>{if(!added)notify(msg("请在当前检查或导入结束后添加文件；当前清单已保留。"));});}
const [readingEdition,setReadingEdition]=useState<TranslationEdition>();const [navigationKey,setNavigationKey]=useState(0);
const [currentId,setCurrentId]=useState<string>();const current=copies.find(c=>c.id===currentId);
const [view,setView]=useState<View>(viewFromHash);
useEffect(()=>{
  const changed=()=>{const value=viewFromHash();if(location.hash&&location.hash!==`#${value}`)history.replaceState(history.state,'',`${location.pathname}${location.search}#${value}`);setReadingEdition(undefined);setCurrentId(undefined);setView(value);};
  changed();window.addEventListener('hashchange',changed);
  return()=>window.removeEventListener('hashchange',changed);
},[]);
const [settings,setSettings]=useState<Settings>(store.settings);const auth=useSession(),account=auth.session;const accountRef=useRef(account);accountRef.current=account;
useEffect(()=>{const changed=(event:StorageEvent)=>{if(event.key==='nc-settings')setSettings(store.settings());};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
useAppearance(settings);
useEffect(()=>{const coordinator=new AcquisitionCoordinator();const tick=()=>void coordinator.run(settings.cacheLimitMb).catch(e=>setError(e.message));tick();const timer=setInterval(tick,2000);return()=>{clearInterval(timer);coordinator.stop();};},[settings.cacheLimitMb]);
const apiOrigin=API_ORIGIN;
const requestPool=useRef(new RequestPool(UPLOAD_CONCURRENCY));
const api=useMemo(()=>new Api(API_BASE,account?.token??'',requestPool.current,undefined,account?sessionAuthorization(account.id):undefined),[account?.id]);
const apiRef=useRef(api);apiRef.current=api;api.isCurrent=()=>apiRef.current===api;
const [caps,setCaps]=useState<Capabilities>();const [usage,setUsage]=useState<Entitlements>();
const [busy,setBusy]=useState('');const [toast,setToast]=useState<{message:string;id:number}>();const [error,setErrorMessage]=useState('');const [drag,setDrag]=useState(false);
const setError=useCallback((message:string)=>setErrorMessage(message),[]);
const [confirmAction,setConfirmAction]=useState<{title:string;body:string;action:()=>Promise<void>}>();
const [cacheBytes,setCacheBytes]=useState(0);
const input=useRef<HTMLInputElement>(null);const [sourceManifest,setSourceManifest]=useState<PageManifest>();
const noticeId=useRef(0);
const notify=useCallback((message:string)=>setToast({message,id:++noticeId.current}),[]);
const login=useLogin(currentId,setCurrentId,notify);
const importLock=useRef(false);
useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(undefined),6000);return()=>clearTimeout(timer);}},[toast]);
useEffect(()=>{reloadLibrary().catch(e=>setError(msg("本地书架无法读取：{0}", {"0": e.message})));store.cacheSize().then(setCacheBytes);},[]);
useEffect(()=>{store.saveSettings(settings);},[settings]);
useEffect(()=>{let live=true;setUsage(undefined);if(account)void api.entitlements().then(value=>{if(live)setUsage(value);}).catch(()=>{});return()=>{live=false};},[api]);
useEffect(()=>{
  let live=true,pending=false;
  setCaps(undefined);
  const refresh=async()=>{
    if(pending||!live||document.hidden)return;
    pending=true;
    try{const value=await api.capabilities();if(live&&api.isCurrent())setCaps(value);}
    catch{/* Keep the last known capabilities while the service reconnects. */}
    finally{pending=false;}
  };
  void refresh();
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{live=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[api]);
const updateCopy=useCallback((copy:ReadingCopy)=>{const previous=copiesRef.current;const next=previous.some(c=>c.id===copy.id)?previous.map(c=>c.id===copy.id?copy:c):[copy,...previous];copiesRef.current=next;setCopies(next);void store.saveCopy(copy).catch(e=>setError(msg("本地记录未保存：{0}", {"0": e.message})));},[]);
const refreshUsage=useCallback(()=>{if(accountRef.current)void api.entitlements().then(value=>{if(api.isCurrent()){setUsage(value);setCaps(current=>current?{...current,entitlements:value}:current);}}).catch(()=>{});},[api]);
const refreshTranslationConfiguration=useCallback(async()=>{const [capabilities,entitlements]=await Promise.all([api.capabilities(),api.entitlements()]);if(!api.isCurrent())throw Error(msg("账户已切换"));setCaps(capabilities);setUsage(entitlements);return entitlements;},[api]);
const receiveTranslationPolicy=useCallback((value:Entitlements)=>{setUsage(value);setCaps(current=>current?{...current,entitlements:value}:current);},[]);
const translation=useAutomaticTranslation({api,userId:account?.user.id,origin:apiOrigin,copies,updateCopy,language:settings.language,currentId,caps,rights:usage??caps?.entitlements,onPolicy:receiveTranslationPolicy,refreshConfiguration:refreshTranslationConfiguration});
useEffect(()=>{
  if(!account)return;
  const refresh=()=>{if(document.visibilityState==='visible')refreshUsage();};
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[account,refreshUsage]);

const directory=useMemo(()=>current?readingDirectory(library,copies,current):undefined,[library,copies,current]);
const sequence=current?readingSequence(library,copies,current):[];
const sourceTask=library.tasks.find(t=>t.copyId===currentId&&t.status!=='complete');
useEffect(()=>{const manifestId=new URLSearchParams(location.search).get('manifest');if(!manifestId||typeof chrome==='undefined'||!chrome.storage?.local)return;chrome.storage.local.get([`manifest:${manifestId}`,'pendingLanguage']).then(data=>{if(data.pendingLanguage)setSettings(s=>({...s,language:String(data.pendingLanguage)}));const m=data[`manifest:${manifestId}`] as PageManifest;if(m)setSourceManifest(m);});},[]);
useEffect(()=>{const catalogId=new URLSearchParams(location.search).get('catalog');if(!catalogId||typeof chrome==='undefined'||!chrome.storage?.local)return;chrome.storage.local.get('nc-import:'+catalogId).then(data=>{const draft=data['nc-import:'+catalogId] as {catalog:SourceCatalog}|undefined;if(draft?.catalog)setCatalog(draft.catalog);});},[]);
async function openDemo(){const existing=copiesRef.current.find(c=>c.demo);if(existing){setCurrentId(existing.id);return;}setBusy(msg("正在打开原创阅读示例…"));try{const blob=await(await fetch('/samples/starlight-bookshop.png')).blob();const bitmap=await createImageBitmap(blob);const p=emptyPage(msg("星光书店 · 原创示例.png"),bitmap.width,bitmap.height);bitmap.close();Object.assign(p,await imageIdentity(blob));p.blobKey=`original:${p.id}`;await store.putBlob(p.blobKey,blob);const c={...makeCopy(msg("星光书店"), [p],msg("原创阅读示例"),'demo:starlight'),demo:true};const result=await store.commitCopies([c],[{title:msg("星光书店"),kind:'work'}]);await reloadLibrary();setCurrentId(result.copyIds[0]);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
async function acquireManifest(manifest:PageManifest,destination:WebDestination){
 if(importLock.current)return;
 importLock.current=true;setBusy(msg("正在获取已发现的原图…"));setImportError('');
 let copy:ReadingCopy|undefined;
 try{
  copy=await acquireWebImages(manifest,settings.cacheLimitMb,setBusy,destination.mode==='insert'?destination.copyId:undefined);
  let copyId:string,message:string;
  if(destination.mode==='insert'){
   const result=await insertWebCopy(copy,destination);copyId=result.copyId;message=result.added?msg("已插入 {0} 页，保留原阅读位置", {"0": result.added}):msg("这些图片已插入，已保留原页序与阅读位置");
  }else{
   copy.title=destination.title;
   const result=await store.commitCopies([copy],[destination.assignment]);copyId=result.copyIds[0];message=result.created?msg("已加入漫画"):msg("此来源已加入，保留原归属与阅读位置");
   setSettings(s=>({...s,direction:manifest.direction}));
  }
  await reloadLibrary();const state=await store.readLibrary(),workId=state.coverage.find(item=>item.copyId===copyId)?.workId;
  if(workId)localStorage.setItem('nc-web-import-work',workId);
  setCurrentId(copyId);setNavigationKey(n=>n+1);setSourceManifest(undefined);
  notify(msg("{0}；已获取 {1} / {2} 张原图", {"0": message, "1": copy.pages.filter(page=>page.blobKey).length, "2": copy.pages.length}));
 }catch(e){setImportError(msg("加入未完成：{0}", {"0": (e as Error).message}));}
 finally{if(copy)await store.collectUnusedBlobs(store.copyBlobKeys(copy)).catch(()=>{});importLock.current=false;setBusy('');}
}
function exitReader(){setReadingEdition(undefined);setCurrentId(undefined);}
const rights=usage??caps?.entitlements;
const nav=(value:View)=>{exitReader();setView(value);location.hash=value;setError('');};
return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=current?'none':'copy';setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files));}}>
<input aria-label={msg("选择漫画图片")} type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
{!current&&<header className="nc-app-header"><button className="nc-brand" aria-label={msg("返回我的漫画")} onClick={()=>nav('library')}><span>✦</span><b>{msg("brand.name")}</b></button><nav aria-label={msg("主导航")}>{([['library',msg("我的漫画"),'book']] as const).map(([value,label,icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>nav(value)}><Icon name={icon} size={19}/>{label}</button>)}</nav><div className="nc-header-actions"><button className="icon-button" aria-label={msg("外观与设置")} onClick={()=>nav('settings')}><Icon name="settings"/></button><button className="nc-account-button" aria-label={msg("我的账户")} aria-current={view==='account'?'page':undefined} onClick={()=>nav('account')}><span className="nc-avatar">{account?account.user.name[0].toUpperCase():<Icon name="user" size={18}/>}</span><span>{account?(rights?.plan==='plus'?'PLUS':msg("普通用户")):msg("登录")}</span></button></div></header>}
<div className="nc-workspace">
{auth.reason==='expired'&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{expiredMessage()}</span><button className="button small" onClick={()=>login.setOpen(true)}>{msg("重新登录")}</button></div>}
{error&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label={msg("关闭错误提示")} onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
{current?<Reader directory={directory} onCatalog={directory?.catalogUrl?()=>{exitReader();void openSource(directory.catalogUrl!);}:undefined} initialView={readingEdition?{mode:readingEdition.mode,preference:'translation'}:undefined} onMarkRead={store.markCopyRead} sequence={sequence} onActiveCopy={setCurrentId} onLoadCopy={id=>{const c=copiesRef.current.find(c=>c.id===id);const task=library.tasks.find(t=>t.copyId===id);if(c?.sourceEntryId&&(!c.discoveryComplete||c.pages.some(p=>!p.blobKey))&&task?.status!=='paused'&&task?.status!=='failed')void queueCopies([id],false).catch(e=>setError(msg("原图采集未启动：{0}", {"0": e.message})));}} sourceStatus={sourceTask?(sourceTask.error??(sourceTask.phase==='discover'?msg("正在发现图片清单"):msg("正在获取原图")))+' · '+sourceTask.completed+' / '+(sourceTask.total??msg("未知")):undefined} onAcquire={()=>void grantImagePermissions([current.id],copiesRef.current).then(()=>notify(msg("已提交采集，原图进度将在阅读页更新"))).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseCopies([current.id]).then(()=>notify(msg("已暂停原图采集，已保存的页面仍可阅读"))).catch(e=>setError(e.message))} onNavigate={(id,pageId)=>void openCopy(id,readingEdition,pageId)} key={`${account?.user.id}:${apiOrigin}:${readingEdition?.mode??''}:${readingEdition?.language??''}:${navigationKey}`} api={api} busy={!!busy} copy={current} settings={settings} setSettings={setSettings} update={updateCopy} onBack={exitReader} onRetry={(page,mode,copyId)=>translation.retry(copyId??current.id,page,mode)} onUpgrade={()=>{if(WEBSITE_UPGRADE_URL)window.open(WEBSITE_UPGRADE_URL,'_blank','noopener,noreferrer');else notify(msg("官网升级即将开放，届时可前往官网管理 PLUS。"));}} onLogin={()=>login.setOpen(true)} translationState={translation.stateFor} onImport={()=>input.current?.click()} notify={notify} onReadingWindow={translation.onReadingWindow} caps={caps?{...caps,entitlements:usage??caps.entitlements}:undefined} userId={account?.user.id} apiOrigin={apiOrigin}/>:
<main className="nc-main">
{view==='library'&&(catalog?<CatalogImport key={catalog.id+':'+catalog.observedAt} catalog={catalog} library={library} copies={copies} onClose={()=>{setCatalog(undefined);history.replaceState(null,'',location.pathname);}} onDone={()=>void reloadLibrary()} onNotice={notify} onRefresh={()=>openSource(catalog.url,true)}/>:<Library api={api} userId={account?.user.id} apiOrigin={apiOrigin} onOpenTranslation={(id,edition)=>void openCopy(id,edition)} library={library} copies={copies} settings={settings} setSettings={setSettings} onOpen={id=>void openCopy(id)} onImport={()=>input.current?.click()} onDemo={()=>void openDemo()} notify={notify} onChanged={()=>void reloadLibrary()} onSource={url=>void openSource(url)}/>)}

{view==='settings'&&<Preferences key={`${apiOrigin}:${account?.user.id??''}`} settings={settings} setSettings={setSettings} caps={caps} cacheBytes={cacheBytes} notify={notify} onClearCache={()=>setConfirmAction({title:msg("清理本地译图缓存？"),body:msg("只清理本地译图，原图、书架和阅读进度保留。需要时可重新下载服务器译图。"),action:async()=>{await store.clearTranslations();setCopies(await store.readCopies());setCacheBytes(await store.cacheSize());notify(msg("本地译图已清理，原图与阅读进度已保留"));}})}/>}
{view==='account'&&<AccountPage key={`${apiOrigin}:${account?.user.id??''}`} api={api} account={account} rights={rights??undefined} testing={login.development} onEntitlements={receiveTranslationPolicy} onLogin={()=>login.setOpen(true)} onLogout={()=>{if(account)void signOut(account.id).then(()=>notify(msg("已退出账户，原图仍可继续阅读"))).catch(e=>setError(e.message));}}/>}
</main>}
</div>
{drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>{msg("把故事放在这里")}</h2><p>{msg("支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）")}</p></div>}
{busy&&<div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}{toast&&<div key={toast.id} className="toast" role="status" aria-live="polite" aria-atomic="true"><Icon name="check" size={18}/><span>{toast.message}</span><button className="icon-button" aria-label={msg("关闭操作提示")} onClick={()=>setToast(undefined)}><Icon name="close" size={16}/></button></div>}
<Login login={login}/>

<LocalImport queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={()=>input.current?.click()} onOpen={id=>{void reloadLibrary().then(()=>openCopy(id)).catch(e=>setError(e.message));}} library={library} limitMb={settings.cacheLimitMb}/>
{sourceManifest&&<SourceImport key={sourceManifest.id} manifest={sourceManifest} library={library} copies={copies} busy={!!busy} error={importError} onClose={()=>{setSourceManifest(undefined);setImportError('');}} onImport={acquireManifest}/>}
{confirmAction&&<Modal title={confirmAction.title} subtitle={confirmAction.body} onClose={()=>setConfirmAction(undefined)}><button className="button primary full" onClick={async()=>{const action=confirmAction;setConfirmAction(undefined);try{await action.action();}catch(e){setError((e as Error).message);}}}>{msg("确认")}</button></Modal>}
</div>;
}
