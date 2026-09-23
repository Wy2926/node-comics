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
import { listShelfIndex, loadDocument, readerSequence, saveReaderState, subscribeLibrary, markRead, type ReadingDirectory } from './comics/application/library-service';
import { importSourceFiles } from './comics/application/import-service';
import { settings as readSettings, saveSettings } from './comics/application/preferences';
import { discoverDocument, pauseDownloads, grantDownloads, runDownloads, stopDownloads } from './comics/acquisition';
import { chooseSourceFiles, sourceImportOptions, type SourceSelection } from './comics/application/source-service';
import { onMaterialized } from './comics/pages/service';
import { authorizeOriginals } from './comics/originals';
import { initializeSources } from './comics/application/source-lifecycle';
import { Reader } from './reader/Reader';
import { readingViewKey } from './reader/view';
import { API_BASE, API_ORIGIN } from './service';
import { discoverCatalog, type PageManifest } from './sources';
import { useAutomaticTranslation } from './translation/useAutomaticTranslation';
import { type Capabilities, type Entitlements, type ReadingCopy, type Settings } from './types';
import { AccountPage, type AccountTab } from './ui/Account';
import { useAppearance } from './ui/Appearance';
import { BrandLogo } from './ui/BrandLogo';
import { CatalogImport } from './ui/CatalogImport';
import { Modal } from './ui/components';
import { Library } from './ui/Library';
import type {ShelfView} from './ui/ShelfGrid';
import { LocalImport } from './ui/LocalImport';
import { Login } from './ui/Login';
import { Preferences } from './ui/Preferences';
import { SourceImport } from './ui/SourceImport';
import {DocumentExport} from './ui/DocumentExport';
import {DownloadManagement} from './ui/DownloadManagement';
import type {Document as ComicDocument} from './comics/domain';
import { StorageManagement } from './ui/StorageManagement';
import { ImportAssignmentFields } from './ui/ImportAssignment';
import type {ImportAssignment} from './comics/application/types';

type View='library'|'settings'|'account';
function viewFromHash():View {const value=location.hash.slice(1).split('/')[0];if(value==='settings'||value==='account')return value;if(value&&value!=='library')history.replaceState(null,'',location.pathname+location.search+'#library');return 'library';}
export function App(){
 const [library,setLibrary]=useState(emptyLibrary),[libraryWorkId,setLibraryWorkId]=useState<string>(),[copies,setCopies]=useState<ReadingCopy[]>([]),[directory,setDirectory]=useState<ReadingDirectory>();
 const shelfView=useRef<ShelfView>({scrollTop:0,search:'',sort:'updated'});
 const copiesRef=useRef(copies);copiesRef.current=copies;
 const [currentId,setCurrentId]=useState<string>(),current=copies.find(c=>c.id===currentId),[navigationKey,setNavigationKey]=useState(0);
 const currentRef=useRef(currentId);currentRef.current=currentId;
 const readingEpoch=useRef(0),libraryEpoch=useRef(0),documentRefreshEpoch=useRef(0);
 const [readingBusy,setReadingBusy]=useState(false);
 const [exporting,setExporting]=useState<ComicDocument>();
 const [catalog,setCatalog]=useState<SourceCatalog>(),[sourceManifest,setSourceManifest]=useState<PageManifest>();
 const [localImport]=useState(()=>new LocalImportQueue()),[importExpanded,setImportExpanded]=useState(false),[importPicker,setImportPicker]=useState(false);
 const [importTarget,setImportTarget]=useState<ImportAssignment>(),[importRequest,setImportRequest]=useState(0);
 const [sourceImport,setSourceImport]=useState<{selection:SourceSelection;label:string}>(),[sourceAssignment,setSourceAssignment]=useState<ImportAssignment>({title:'',kind:'unclassified'});
 const sourceInProgress=useRef(false),[sourceError,setSourceError]=useState('');
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
 const updateCopy=useCallback((copy:ReadingCopy)=>{setCopies(values=>values.map(c=>c.id===copy.id?copy:c));void saveReaderState(copy).catch(e=>setError(e.message));},[]);
 const openCopy=useCallback(async(id:string,pageId?:string)=>{
   const request=++readingEpoch.current,isCurrent=()=>request===readingEpoch.current&&api.isCurrent();setReadingBusy(true);setError('');
   try{await discoverDocument(id);if(!isCurrent())return;const result=await readerSequence(id,account?{userId:account.user.id,origin:API_ORIGIN}:undefined);if(!isCurrent())return;if(pageId)result.copies=result.copies.map(c=>c.id===id?{...c,pageId,relativeOffset:0}:c);setCopies(result.copies);setDirectory(result.directory);currentRef.current=id;setCurrentId(id);setNavigationKey(n=>n+1);}catch(e){if(isCurrent())setError((e as Error).message);}finally{if(request===readingEpoch.current)setReadingBusy(false);}
 },[api]);
 function activateCopy(id:string){
   const request=++readingEpoch.current;currentRef.current=id;setCurrentId(id);setReadingBusy(false);
   void readerSequence(id,accountScope).then(result=>{if(request===readingEpoch.current&&currentRef.current===id&&api.isCurrent()){setCopies(result.copies);setDirectory(result.directory);}}).catch(e=>{if(request===readingEpoch.current&&api.isCurrent())setError(e.message);});
 }
 function loadCopy(id:string){
   const request=readingEpoch.current,isCurrent=()=>request===readingEpoch.current&&api.isCurrent();
   void discoverDocument(id).then(()=>isCurrent()?loadDocument(id,accountScope):undefined).then(copy=>{if(copy&&isCurrent())setCopies(values=>values.map(c=>c.id===id?copy:c));}).catch(e=>{if(isCurrent())setError(e.message);});
 }
 async function openSource(url:string){const request=++readingEpoch.current;setReadingBusy(false);setBusy(msg("正在发现来源目录"));try{const value=await discoverCatalog(url);if(request!==readingEpoch.current)return;setCatalog({...value,excludedEntryIds:[]});currentRef.current=undefined;setCurrentId(undefined);setCopies([]);setView('library');}catch(e){if(request===readingEpoch.current)setError((e as Error).message);}finally{setBusy(value=>value===msg('正在发现来源目录')?'':value);}}
 function resumeBusyImport(){const state=localImport.getSnapshot();if(!state.running&&!state.checking&&state.phase!=='paused')return false;setImportExpanded(true);notify(msg('请先完成或停止当前导入，再添加新的内容。'));return true;}
 function beginImport(assignment?:ImportAssignment){if(resumeBusyImport())return;setImportTarget(assignment);setImportRequest(value=>value+1);setImportPicker(true);}
 function chooseFiles(files:File[],fresh=false){if(input.current)input.current.value='';if(!files.length||resumeBusyImport())return;if(fresh){setImportTarget(undefined);setImportRequest(value=>value+1);}setImportPicker(false);setImportExpanded(true);void localImport.add(files).then(accepted=>{if(!accepted)notify(msg('请先完成或停止当前导入，再添加新的内容。'));});}
 async function chooseSource(providerId:string){
   if(sourceInProgress.current||sourceImport)return;
   const option=sourceActions.find(action=>action.id===providerId);if(!option)return;
   setImportPicker(false);setError('');setSourceError('');
   if(!option.configured){setError(msg("此来源尚未配置，请先完成连接设置。"));return;}
   sourceInProgress.current=true;
   try{setBusy(msg("请选择 {0} 文件",{'0':option.label}));const selected=await chooseSourceFiles(providerId);if(!selected.files.length){notify(msg("{0} 已连接",{'0':option.label}));return;}setSourceImport({selection:selected,label:option.label});setSourceAssignment(importTarget??{title:selected.files[0].name.replace(/\.[^.]+$/,''),kind:'unclassified'});}
   catch(e){setError((e as Error).message);}finally{sourceInProgress.current=false;setBusy('');}
 }
 async function confirmSource(){
   if(!sourceImport||sourceInProgress.current||(!sourceAssignment.workId&&!sourceAssignment.title.trim()))return;
   sourceInProgress.current=true;setSourceError('');setBusy(msg("正在建立云盘文件目录"));
   try{await importSourceFiles(sourceImport.selection,sourceAssignment);await reloadLibrary();setSourceImport(undefined);nav('library');notify(msg('已导入'));}
   catch(e){setSourceError((e as Error).message);}finally{sourceInProgress.current=false;setBusy('');}
 }
 useEffect(()=>{localImport.activate();void initializeSources().then(reloadLibrary).catch(e=>setError(e.message));return()=>localImport.dispose();},[localImport]);
 useEffect(()=>{void reloadLibrary().catch(e=>setError(e.message));},[reloadLibrary]);
 useEffect(()=>subscribeLibrary(change=>{
   if(['works','units','documents','bindings','connections'].includes(change.table))void reloadLibrary().catch(e=>setError(e.message));
   const id=currentRef.current;
   if(change.table==='documents'&&id&&change.ids.includes(id)){
     const request=readingEpoch.current,refresh=++documentRefreshEpoch.current,isCurrent=()=>request===readingEpoch.current&&refresh===documentRefreshEpoch.current&&currentRef.current===id&&api.isCurrent();
     void loadDocument(id,accountScope).then(copy=>{if(isCurrent())setCopies(values=>values.map(c=>c.id===copy.id?copy:c));}).catch(()=>{if(isCurrent())leaveReader();});
   }
 }),[reloadLibrary,api,leaveReader]);
 useEffect(()=>onMaterialized(identity=>setCopies(values=>values.map(c=>c.revisionId===identity.revisionId?{...c,pages:c.pages.map(p=>p.id===identity.pageId?{...p,imageSha256:identity.imageSha256,imageByteSize:identity.byteSize,imageMime:identity.mime,width:identity.width,height:identity.height}:p)}:c))),[]);
 useEffect(()=>{void saveSettings(settings);},[settings]);
 useEffect(()=>{authorizeOriginals(account?{origin:API_ORIGIN,userId:account.user.id,download:id=>api.image(id),isCurrent:api.isCurrent}:undefined);return()=>authorizeOriginals(undefined);},[api,account?.user.id]);
 useEffect(()=>{const timer=setInterval(()=>void runDownloads().catch(e=>setError(e.message)),1500);return()=>{clearInterval(timer);stopDownloads();};},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6000);return()=>clearTimeout(timer);},[toast]);
 useEffect(()=>{const changed=()=>{setView(viewFromHash());setAccountTab(location.hash==='#account/subscription'?'subscription':'overview');leaveReader();};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[leaveReader]);
 useEffect(()=>()=>{readingEpoch.current++;libraryEpoch.current++;},[]);
 useEffect(()=>{let live=true;setUsage(undefined);setCaps(undefined);const refresh=async()=>{try{const value=await api.capabilities();if(live)setCaps(value);if(account){const value=await api.entitlements();if(live)setUsage(value);}}catch{/* Keep local reading available offline. */}};void refresh();window.addEventListener('focus',refresh);return()=>{live=false;window.removeEventListener('focus',refresh);};},[api]);
 useEffect(()=>{if(typeof chrome==='undefined'||!chrome.storage?.local)return;const query=new URLSearchParams(location.search),manifest=query.get('manifest'),source=query.get('catalog');if(manifest)void chrome.storage.local.get('manifest:'+manifest).then(data=>setSourceManifest(data['manifest:'+manifest] as PageManifest));if(source)void chrome.storage.local.get('nc-import:'+source).then(data=>{const draft=data['nc-import:'+source] as {catalog?:SourceCatalog}|undefined;if(draft?.catalog)setCatalog(draft.catalog);});},[]);
 const refreshConfiguration=useCallback(async()=>{const [capabilities,entitlements]=await Promise.all([api.capabilities(),api.entitlements()]);if(!api.isCurrent())throw Error(msg("账户已切换"));setCaps(capabilities);setUsage(entitlements);return entitlements;},[api]);
 const receivePolicy=useCallback((value:Entitlements)=>{setUsage(value);setCaps(c=>c?{...c,entitlements:value}:c);},[]);
 const translation=useAutomaticTranslation({api,userId:account?.user.id,origin:API_ORIGIN,copies,updateCopy,language:settings.language,currentId,caps,rights:usage??caps?.entitlements,onPolicy:receivePolicy,refreshConfiguration});
 function nav(value:View,tab:AccountTab='overview'){leaveReader();setView(value);if(value==='library')setLibraryWorkId(undefined);setAccountTab(tab);location.hash=value==='account'&&tab==='subscription'?'account/subscription':value;setError('');}
 const rights=usage??caps?.entitlements;
 return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files),true);}}>
  <input aria-label={msg('选择漫画图片')} type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
  {!current&&<header className="nc-app-header"><button className="nc-brand" aria-label={msg('返回我的漫画')} onClick={()=>nav('library')}><BrandLogo/></button><nav aria-label={msg('主导航')}><button aria-current={view==='library'?'page':undefined} onClick={()=>nav('library')}><Icon name="book"/>{msg('我的漫画')}</button></nav><div className="nc-header-actions"><button className="icon-button" aria-label={msg('外观与设置')} onClick={()=>nav('settings')}><Icon name="settings"/></button><button aria-label={msg('我的账户')} className="nc-account-button" onClick={()=>nav('account')}><Icon name="user"/><span>{account?(rights?.plan==='plus'?'PLUS':msg('普通用户')):msg('我的账户')}</span></button></div></header>}
  <div className="nc-workspace">{auth.reason==='expired'&&<div className="global-error" role="alert">{expiredMessage()}<button onClick={()=>login.setOpen(true)}>{msg('重新登录')}</button></div>}{error&&<div className="global-error" role="alert"><Icon name="info"/><span>{error}</span><button aria-label={msg('关闭错误提示')} onClick={()=>setError('')}><Icon name="close"/></button></div>}
  {current?<Reader key={`${current.workId}:${account?.user.id}:${navigationKey}`} viewKey={readingViewKey(current.workId,current.id)} directory={directory} onMarkRead={markRead} sequence={copies} onActiveCopy={activateCopy} onLoadCopy={loadCopy} onAcquire={()=>void grantDownloads([current.id]).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseDownloads([current.id])} onNavigate={(id,pageId)=>void openCopy(id,pageId)} api={api} busy={!!busy||readingBusy} copy={current} settings={settings} setSettings={setSettings} update={updateCopy} onBack={leaveReader} onRetry={(page,mode,id)=>translation.retry(id??current.id,page,mode)} onUpgrade={()=>nav('account','subscription')} onLogin={()=>login.setOpen(true)} translationState={translation.stateFor} onImport={beginImport} notify={notify} onReadingWindow={translation.onReadingWindow} caps={caps} userId={account?.user.id} apiOrigin={API_ORIGIN}/>:
  <main className="nc-main">{view==='library'&&<DownloadManagement notify={notify} onOpen={id=>void openCopy(id)}/>} {view==='library'&&(catalog?<CatalogImport catalog={catalog} library={library} onClose={()=>setCatalog(undefined)} onDone={()=>void reloadLibrary()} onNotice={notify} onRefresh={()=>openSource(catalog.url)}/>:<Library library={library} workId={libraryWorkId} onSelectWork={id=>{leaveReader();setLibraryWorkId(id);}} onOpen={id=>void openCopy(id)} onImport={beginImport} onChanged={reloadLibrary} notify={notify} onExport={setExporting} shelfView={shelfView}/>)}
  {view==='settings'&&<><Preferences settings={settings} setSettings={setSettings} caps={caps}/><StorageManagement onNotice={notify} onChanged={()=>{setCopies(values=>values.map(c=>({...c,pages:c.pages.map(p=>({...p,outputBlobs:{}}))})));}}/></>}
  {view==='account'&&<AccountPage tab={accountTab} onTabChange={tab=>nav('account',tab)} api={api} account={account} notify={notify} rights={rights??undefined} testing={login.development} onEntitlements={receivePolicy} onLogin={()=>login.setOpen(true)} onLogout={()=>{if(account)void signOut(account.id).catch(e=>setError(e.message));}}/>}</main>}
  </div>
  {drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>{msg('把故事放在这里')}</h2><p>{msg('支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）')}</p></div>}
  {(busy||readingBusy)&&<div className="busy-pill" role="status"><span className="spinner"/>{busy||msg('正在打开漫画')}</div>}{toast&&<div className="toast" role="status"><Icon name="check"/>{toast}<button onClick={()=>setToast('')}><Icon name="close"/></button></div>}
  {exporting&&<DocumentExport document={exporting} api={api} userId={account?.user.id} settings={settings} onClose={()=>setExporting(undefined)}/>}
  <Login login={login}/><LocalImport assignmentPreset={importTarget} presetKey={importRequest} queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={()=>input.current?.click()} onOpen={id=>void openCopy(id)} library={library} limitMb={settings.cacheLimitMb}/>
  {sourceManifest&&<SourceImport manifest={sourceManifest} library={library} onClose={()=>setSourceManifest(undefined)} onDone={()=>void reloadLibrary()} onNotice={notify}/>}
  {importPicker&&<Modal title={msg('导入漫画')} onClose={()=>setImportPicker(false)}><div className="nc-stack-actions"><button className="button primary" onClick={()=>input.current?.click()}>{msg("本地文件")}</button>{sourceActions.map(action=><button key={action.id} className="button secondary" onClick={()=>void chooseSource(action.id)}>{action.label}</button>)}</div><p className="nc-muted">{msg("本地保存完整源文件；云盘保存引用，阅读时按需获取。")}</p></Modal>}
  {sourceImport&&<Modal title={msg("导入 {0} 文件",{'0':sourceImport.label})} onClose={()=>{if(!sourceInProgress.current)setSourceImport(undefined);}}><p>{sourceImport.selection.connection.displayName} · {msg('{0} 份文件',{'0':sourceImport.selection.files.length})}</p><ul style={{maxHeight:'12rem',overflowY:'auto',overflowWrap:'anywhere'}}>{sourceImport.selection.files.map(file=><li key={file.id}>{file.name}</li>)}</ul>{sourceError&&<p className="error-message" role="alert">{sourceError}</p>}<fieldset style={{border:0,padding:0,margin:0,minWidth:0}} disabled={!!busy}><ImportAssignmentFields value={sourceAssignment} onChange={setSourceAssignment} library={library}/></fieldset><button className="button primary full" disabled={!!busy||(!sourceAssignment.workId&&!sourceAssignment.title.trim())} onClick={()=>void confirmSource()}>{msg("登记文件引用")}</button></Modal>}
 </div>;
}
