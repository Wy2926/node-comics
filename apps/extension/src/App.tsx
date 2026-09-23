import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api } from './api';
import { expiredMessage } from './auth/model';
import { sessionAuthorization } from './auth/session';
import { signOut } from './auth/storage';
import { useLogin } from './auth/useLogin';
import { useSession } from './auth/useSession';
import { RequestPool, UPLOAD_CONCURRENCY } from './concurrency';
import { msg } from './i18n/runtime';
import { Icon } from './icons';
import { COMIC_ACCEPT } from './comics/formats/limits';
import { LocalImportQueue } from './comics/application/import-queue';
import { emptyLibrary, type SourceCatalog } from './comics/application/types';
import { listShelfIndex, loadEntry as readEntry, continueEntry, comicDirectory, getEntry, readerSequence, saveReaderState, subscribeLibrary, markRead, type ReadingDirectory } from './comics/application/library-service';
import { importSourceFiles, importCatalog, importManifest, reindexEntry } from './comics/application/import-service';
import { settings as readSettings, saveSettings } from './comics/application/preferences';
import { discoverEntryContent, pauseDownloads, grantDownloads, runDownloads, stopDownloads } from './comics/acquisition';
import { chooseSourceFiles, sourceImportOptions } from './comics/application/source-service';
import { onMaterialized } from './comics/pages/service';
import { authorizeOriginals } from './comics/originals';
import { initializeSources } from './comics/application/source-lifecycle';
import { Reader } from './reader/Reader';
import {ComicDirectory} from './reader/ComicDirectory';
import { readingViewKey } from './reader/view';
import { API_BASE, API_ORIGIN } from './service';
import { copyOrigins, inExtension, type PageManifest } from './sources';
import {readWebsiteCatalog} from './comics/application/website-catalog';
import {importWebsiteLink} from './comics/application/website-import';
import { useAutomaticTranslation } from './translation/useAutomaticTranslation';
import { type Capabilities, type Entitlements, type ReadingEntry, type Settings } from './types';
import { AccountPage, type AccountTab } from './ui/Account';
import { useAppearance } from './ui/Appearance';
import { BrandLogo } from './ui/BrandLogo';
import { ComicSites } from './ui/ComicSites';
import { SupportRequestForm } from './ui/SupportRequestForm';
import { Modal } from './ui/components';
import { Library } from './ui/Library';
import type {ShelfView} from './ui/ShelfGrid';
import { LocalImport } from './ui/LocalImport';
import { Login } from './ui/Login';
import { Preferences } from './ui/Preferences';
import {DocumentExport} from './ui/DocumentExport';
import type {Entry} from './comics/domain';
import { StorageManagement } from './ui/StorageManagement';

type View='library'|'sites'|'settings'|'account';
function viewFromHash():View {const value=location.hash.slice(1).split('/')[0];if(value==='sites'||value==='settings'||value==='account')return value;if(value&&value!=='library')history.replaceState(null,'',location.pathname+location.search+'#library');return 'library';}
export function App(){
 const [library,setLibrary]=useState(emptyLibrary),[copies,setCopies]=useState<ReadingEntry[]>([]),[directory,setDirectory]=useState<ReadingDirectory>();
 const shelfView=useRef<ShelfView>({scrollTop:0,search:'',sort:'recent'});
 const copiesRef=useRef(copies);copiesRef.current=copies;
 const [currentId,setCurrentId]=useState<string>(),current=copies.find(c=>c.id===currentId),[navigationKey,setNavigationKey]=useState(0);
 const currentRef=useRef(currentId);currentRef.current=currentId;
 const readingEpoch=useRef(0),libraryEpoch=useRef(0),documentRefreshEpoch=useRef(0);
 const [readingBusy,setReadingBusy]=useState(false);
 const [exporting,setExporting]=useState<Entry>();
 const [feedbackOpen,setFeedbackOpen]=useState(false);
 const [sourceDirectory,setSourceDirectory]=useState<ReadingDirectory>();
 const [localImport]=useState(()=>new LocalImportQueue()),[importExpanded,setImportExpanded]=useState(false);
 const sourceInProgress=useRef(false),sourceQueryHandled=useRef(false);
 const sourceActions=sourceImportOptions();
 const [view,setView]=useState<View>(viewFromHash),[accountTab,setAccountTab]=useState<AccountTab>('overview');
 const [settings,setSettings]=useState<Settings>(readSettings),auth=useSession(),account=auth.session;
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[toast,setToast]=useState(''),[drag,setDrag]=useState(false);
 const input=useRef<HTMLInputElement>(null),pool=useRef(new RequestPool(UPLOAD_CONCURRENCY));
 const api=useMemo(()=>new Api(API_BASE,account?.token??'',pool.current,undefined,account?sessionAuthorization(account.id):undefined),[account?.id]);
 const apiRef=useRef(api);apiRef.current=api;api.isCurrent=()=>apiRef.current===api;
 const [caps,setCaps]=useState<Capabilities>(),[usage,setUsage]=useState<Entitlements>();
 const notify=useCallback((message:string)=>setToast(message),[]),login=useLogin(currentId,setCurrentId,notify);
 const accountScope=account?{userId:account.user.id,origin:API_ORIGIN}:undefined;
 useAppearance(settings);
 const reloadLibrary=useCallback(async()=>{
   const request=++libraryEpoch.current;
   try{const value=await listShelfIndex();if(request===libraryEpoch.current)setLibrary(value);}
   catch(reason){if(request===libraryEpoch.current)throw reason;}
 },[]);
 const leaveReader=useCallback(()=>{readingEpoch.current++;currentRef.current=undefined;setCurrentId(undefined);setCopies([]);setDirectory(undefined);setReadingBusy(false);},[]);
 const updateEntry=useCallback((copy:ReadingEntry)=>{setCopies(values=>values.map(c=>c.id===copy.id?copy:c));void saveReaderState(copy).catch(e=>setError(e.message));},[]);
 const openEntry=useCallback(async(id:string,pageId?:string)=>{
   const request=++readingEpoch.current,isCurrent=()=>request===readingEpoch.current&&api.isCurrent();setReadingBusy(true);setError('');
   try{try{await discoverEntryContent(id);}catch(error){if(isCurrent())setError((error as Error).message);}if(!isCurrent())return;const result=await readerSequence(id,account?{userId:account.user.id,origin:API_ORIGIN}:undefined);if(!isCurrent())return;if(pageId)result.copies=result.copies.map(c=>c.id===id?{...c,pageId,relativeOffset:0}:c);setSourceDirectory(undefined);setCopies(result.copies);setDirectory(result.directory);currentRef.current=id;setCurrentId(id);setNavigationKey(n=>n+1);}catch(e){if(isCurrent())setError((e as Error).message);}finally{if(request===readingEpoch.current)setReadingBusy(false);}
 },[api]);
 function activateEntry(id:string){
   const request=++readingEpoch.current;currentRef.current=id;setCurrentId(id);setReadingBusy(false);
   void readerSequence(id,accountScope).then(result=>{if(request===readingEpoch.current&&currentRef.current===id&&api.isCurrent()){setCopies(result.copies);setDirectory(result.directory);}}).catch(e=>{if(request===readingEpoch.current&&api.isCurrent())setError(e.message);});
 }
 function loadEntry(id:string){
   const request=readingEpoch.current,isCurrent=()=>request===readingEpoch.current&&api.isCurrent();
   void discoverEntryContent(id).then(()=>isCurrent()?readEntry(id,accountScope):undefined).then(copy=>{if(copy&&isCurrent())setCopies(values=>values.map(c=>c.id===id?copy:c));}).catch(e=>{if(isCurrent())setError(e.message);});
 }
 async function openComic(comicId:string){const entry=await continueEntry(comicId);if(entry)await openEntry(entry.id);else{setSourceDirectory(await comicDirectory(comicId));window.scrollTo({top:0,behavior:'instant'});}}
 function beginImport(){const state=localImport.getSnapshot();if(state.running||state.phase==='paused'){setImportExpanded(true);return;}input.current?.click();}
 function chooseFiles(files:File[]){
  if(input.current)input.current.value='';if(!files.length)return;
  const state=localImport.getSnapshot();if(state.running||state.phase==='paused'){setImportExpanded(true);return;}
  const request=readingEpoch.current;setImportExpanded(false);
  void localImport.add(files).then(async items=>{await reloadLibrary();const item=items[0];if(items.length===1&&item.entryId&&readingEpoch.current===request){setImportExpanded(false);await openEntry(item.entryId);}else if(items.some(i=>i.status==='failed'))setImportExpanded(true);}).catch(e=>setError(e.message));
 }
 async function chooseSource(providerId:string){
  if(sourceInProgress.current)return;const option=sourceActions.find(action=>action.id===providerId);if(!option)return;
  setError('');if(!option.configured){setError(msg('此来源尚未配置，请先完成连接设置。'));return;}
  sourceInProgress.current=true;const request=readingEpoch.current;
  try{setBusy(msg('请选择 {0} 文件',{'0':option.label}));const selected=await chooseSourceFiles(providerId);
   if(selected.files.length)setBusy(msg('正在建立云盘文件目录'));const result=await importSourceFiles(selected);await reloadLibrary();
   if(!selected.files.length){notify(msg('{0} 已连接',{'0':option.label}));return;}
   if(result.failures.length)setError(result.failures.map(file=>file.name+'：'+file.error).join('；'));
   if(result.results.length===1&&selected.files.length===1&&request===readingEpoch.current)await openEntry(result.results[0].id);else notify(msg('{0} 份已导入 · {1} 份需要处理',{'0':result.results.length,'1':result.failures.length}));
  }catch(e){setError((e as Error).message);}finally{sourceInProgress.current=false;setBusy('');}
 }
 async function reloadCurrent(){if(!currentId)return;const id=currentId;setBusy(msg('正在重新载入'));try{const entry=await getEntry(id);if(!entry)return;if(entry.format==='website')await discoverEntryContent(id,undefined,true);else await reindexEntry(id);await openEntry(id);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function exportCurrent(){if(!currentId)return;const entry=await getEntry(currentId);if(entry)setExporting(entry);}
 useEffect(()=>{localImport.activate();void initializeSources().then(reloadLibrary).catch(e=>setError(e.message));return()=>localImport.dispose();},[localImport]);
 useEffect(()=>{void reloadLibrary().catch(e=>setError(e.message));},[reloadLibrary]);
 useEffect(()=>{if(inExtension())void chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}).catch(()=>{});},[]);
 useEffect(()=>subscribeLibrary(change=>{
   if(['comics','entries','connections'].includes(change.table))void reloadLibrary().catch(e=>setError(e.message));
   const id=currentRef.current;
   if(change.table==='catalogs'&&id){
     const request=readingEpoch.current;
     void readerSequence(id,accountScope).then(result=>{if(request===readingEpoch.current&&currentRef.current===id&&api.isCurrent()){
       setDirectory(result.directory);setCopies(previous=>result.copies.map(copy=>{const old=previous.find(old=>old.id===copy.id&&old.contentId===copy.contentId);return old?{...old,title:copy.title,sourceUrl:copy.sourceUrl}:copy;}));
     }}).catch(()=>{});
   }
   if(change.table==='entries'&&id&&change.ids.includes(id)){
     const request=readingEpoch.current,refresh=++documentRefreshEpoch.current,isCurrent=()=>request===readingEpoch.current&&refresh===documentRefreshEpoch.current&&currentRef.current===id&&api.isCurrent();
     void readEntry(id,accountScope).then(copy=>{if(isCurrent()){if(copiesRef.current.find(c=>c.id===copy.id)?.contentId!==copy.contentId){setNavigationKey(n=>n+1);notify(msg('来源内容已变化，已回到第一页。'));}setCopies(values=>values.map(c=>c.id!==copy.id?c:c.contentId===copy.contentId&&copy.pages.some(page=>page.id===c.pageId)?{...copy,pageId:c.pageId,relativeOffset:c.relativeOffset,lastReadAt:c.lastReadAt,catalogUpdateRevision:c.catalogUpdateRevision}:copy));}}).catch(()=>{if(isCurrent())leaveReader();});
   }
 }),[reloadLibrary,api,leaveReader]);
 useEffect(()=>onMaterialized(identity=>setCopies(values=>values.map(c=>c.contentId===identity.contentId?{...c,pages:c.pages.map(p=>p.id===identity.pageId?{...p,imageSha256:identity.imageSha256,imageByteSize:identity.byteSize,imageMime:identity.mime,width:identity.width,height:identity.height}:p)}:c))),[]);
 useEffect(()=>{void saveSettings(settings);},[settings]);
 useEffect(()=>{const changed=(event:StorageEvent)=>{if(event.key==='nc-settings'||event.key===null){const next=readSettings();setSettings(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);}};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
 useEffect(()=>{authorizeOriginals(account?{origin:API_ORIGIN,userId:account.user.id,download:id=>api.image(id),isCurrent:api.isCurrent}:undefined);return()=>authorizeOriginals(undefined);},[api,account?.user.id]);
 useEffect(()=>{const timer=setInterval(()=>void runDownloads().catch(e=>setError(e.message)),1500);return()=>{clearInterval(timer);stopDownloads();};},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6000);return()=>clearTimeout(timer);},[toast]);
 useEffect(()=>{const changed=()=>{setView(viewFromHash());setAccountTab(location.hash==='#account/subscription'?'subscription':'overview');leaveReader();};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[leaveReader]);
 useEffect(()=>()=>{readingEpoch.current++;libraryEpoch.current++;},[]);
 useEffect(()=>{let live=true;setUsage(undefined);setCaps(undefined);const refresh=async()=>{try{const value=await api.capabilities();if(live)setCaps(value);if(account){const value=await api.entitlements();if(live)setUsage(value);}}catch{/* Keep local reading available offline. */}};void refresh();window.addEventListener('focus',refresh);return()=>{live=false;window.removeEventListener('focus',refresh);};},[api]);
 useEffect(()=>{
  if(sourceQueryHandled.current||typeof chrome==='undefined'||!chrome.storage?.local)return;
  const query=new URLSearchParams(location.search),manifestId=query.get('manifest'),catalogId=query.get('catalog');if(!manifestId&&!catalogId)return;
  sourceQueryHandled.current=true;const request=readingEpoch.current;setBusy(msg('正在打开漫画'));
  void (async()=>{
   if(manifestId){const data=await chrome.storage.local.get('manifest:'+manifestId),manifest=data['manifest:'+manifestId] as PageManifest|undefined;if(!manifest)throw Error(msg('来源清单已失效，请重新发现。'));
    const result=await importManifest(manifest);await reloadLibrary();if(readingEpoch.current===request)await openEntry(result.id);
    if(result.catalogUrl){try{const source=await readWebsiteCatalog(result.catalogUrl);await importCatalog(source);await reloadLibrary();if(currentRef.current===result.id&&api.isCurrent()){const sequence=await readerSequence(result.id,accountScope);if(currentRef.current===result.id&&api.isCurrent()){setCopies(sequence.copies);setDirectory(sequence.directory);}}}catch(e){notify((e as Error).message);}}
   }else if(catalogId){const data=await chrome.storage.local.get('nc-import:'+catalogId),source=data['nc-import:'+catalogId] as {catalog?:SourceCatalog}|undefined;if(!source?.catalog)throw Error(msg('来源清单已失效，请重新发现。'));const comic=await importCatalog(source.catalog);await reloadLibrary();if(readingEpoch.current===request)await openComic(comic.id);}
  })().catch(e=>setError(e.message)).finally(()=>{setBusy('');query.delete('manifest');query.delete('catalog');history.replaceState(null,'',location.pathname+(query.size?'?'+query:'')+location.hash);});
 },[api]);
 const refreshConfiguration=useCallback(async()=>{const [capabilities,entitlements]=await Promise.all([api.capabilities(),api.entitlements()]);if(!api.isCurrent())throw Error(msg("账户已切换"));setCaps(capabilities);setUsage(entitlements);return entitlements;},[api]);
 const receivePolicy=useCallback((value:Entitlements)=>{setUsage(value);setCaps(c=>c?{...c,entitlements:value}:c);},[]);
 const translation=useAutomaticTranslation({api,userId:account?.user.id,origin:API_ORIGIN,copies,updateEntry,language:settings.language,currentId,caps,rights:usage??caps?.entitlements,onPolicy:receivePolicy,refreshConfiguration});
 function nav(value:View,tab:AccountTab='overview'){leaveReader();setView(value);setSourceDirectory(undefined);setAccountTab(tab);location.hash=value==='account'&&tab==='subscription'?'account/subscription':value;setError('');}
 const rights=usage??caps?.entitlements;
 async function importWebsiteUrl(url:string){
   const comic=await importWebsiteLink(url);await reloadLibrary();
   setView('library');history.replaceState(null,'',location.pathname+location.search+'#library');await openComic(comic.id);
 }
 return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files));}}>
  <input aria-label={msg('选择漫画文件')} type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
  {!current&&<header className="nc-app-header"><button className="nc-brand" aria-label={msg('返回我的漫画')} onClick={()=>nav('library')}><BrandLogo/></button><nav aria-label={msg('主导航')}><button aria-current={view==='library'?'page':undefined} onClick={()=>nav('library')}><Icon name="book"/>{msg('我的漫画')}</button><button aria-current={view==='sites'?'page':undefined} onClick={()=>nav('sites')}><Icon name="globe"/>{msg('漫画网站')}</button></nav><div className="nc-header-actions"><button className="icon-button" aria-label={msg('插件反馈')} title={msg('插件反馈')} onClick={()=>setFeedbackOpen(true)}><Icon name="message"/></button><button className="icon-button" aria-label={msg('外观与设置')} onClick={()=>nav('settings')}><Icon name="settings"/></button><button aria-label={msg('我的账户')} className="nc-account-button" onClick={()=>nav('account')}><Icon name="user"/><span>{account?(rights?.plan==='plus'?'PLUS':msg('普通用户')):msg('我的账户')}</span></button></div></header>}
  <div className="nc-workspace">{auth.reason==='expired'&&<div className="global-error" role="alert">{expiredMessage()}<button onClick={()=>login.setOpen(true)}>{msg('重新登录')}</button></div>}{error&&<div className="global-error" role="alert"><Icon name="info"/><span>{error}</span><button aria-label={msg('关闭错误提示')} onClick={()=>setError('')}><Icon name="close"/></button></div>}
  {current?<Reader key={`${current.comicId}:${account?.user.id}:${navigationKey}`} viewKey={readingViewKey(current.comicId??current.id)} directory={directory} onReload={()=>void reloadCurrent()} onExport={()=>void exportCurrent()} sourceStatus={directory?.entries.find(e=>e.id===current.id)?.error} onMarkRead={markRead} sequence={copies} onActiveEntry={activateEntry} onLoadEntry={loadEntry} onAcquire={()=>void grantDownloads([current.id],copyOrigins([current])).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseDownloads([current.id])} onNavigate={(id,pageId)=>void openEntry(id,pageId)} api={api} busy={!!busy||readingBusy} copy={current} settings={settings} setSettings={setSettings} update={updateEntry} onBack={leaveReader} onRetry={(page,mode,id)=>translation.retry(id??current.id,page,mode)} onUpgrade={()=>nav('account','subscription')} onLogin={()=>login.setOpen(true)} translationState={translation.stateFor} onImport={beginImport} notify={notify} onReadingWindow={translation.onReadingWindow} caps={caps} userId={account?.user.id} apiOrigin={API_ORIGIN}/>:
  <main className="nc-main">{view==='library'&&(sourceDirectory?<section className="nc-reading-start" aria-label={msg('选择开始阅读的位置')}><div className="nc-page-heading"><h1>{msg('选择开始阅读的位置')}</h1><button className="button secondary" onClick={()=>setSourceDirectory(undefined)}>{msg('返回我的漫画')}</button></div><ComicDirectory directory={sourceDirectory} index={0} pageCount={0} onNavigate={id=>void openEntry(id)}/></section>:<Library library={library} onOpen={id=>void openComic(id).catch(e=>setError(e.message))} onImport={beginImport} onSource={id=>void chooseSource(id)} sourceActions={sourceActions} onChanged={reloadLibrary} notify={notify} onExport={setExporting} shelfView={shelfView}/>)}
  {view==='sites'&&<ComicSites onImport={importWebsiteUrl}/>}
  {view==='settings'&&<Preferences settings={settings} setSettings={setSettings} caps={caps}><StorageManagement onNotice={notify} onChanged={()=>{setCopies(values=>values.map(c=>({...c,pages:c.pages.map(p=>({...p,outputBlobs:{}}))})));}}/></Preferences>}
  {view==='account'&&<AccountPage tab={accountTab} onTabChange={tab=>nav('account',tab)} api={api} account={account} notify={notify} rights={rights??undefined} testing={login.development} onEntitlements={receivePolicy} onLogin={()=>login.setOpen(true)} onLogout={()=>{if(account)void signOut(account.id).catch(e=>setError(e.message));}}/>}</main>}
  </div>
  {drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>{msg('把故事放在这里')}</h2><p>{'CBZ / ZIP · CBR / RAR · PDF · MOBI'}</p></div>}
  {(busy||readingBusy)&&<div className="busy-pill" role="status"><span className="spinner"/>{busy||msg('正在打开漫画')}</div>}{toast&&<div className="toast" role="status"><Icon name="check"/>{toast}<button onClick={()=>setToast('')}><Icon name="close"/></button></div>}
  {exporting&&<DocumentExport document={exporting} api={api} userId={account?.user.id} settings={settings} onClose={()=>setExporting(undefined)}/>}
  {feedbackOpen&&<Modal title={msg('插件反馈')} subtitle={msg('使用中遇到问题或有建议？无需登录，欢迎告诉我们。')} onClose={()=>setFeedbackOpen(false)}><SupportRequestForm kind="plugin"/></Modal>}
  <Login login={login}/><LocalImport reading={!!current} queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={beginImport} onOpen={id=>void openEntry(id)}/>

 </div>;
}
