import {useAutomaticTranslation} from './translation/useAutomaticTranslation';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Icon} from './icons';
import {Modal,PageTitle} from './ui/components';
import {Api} from './api';
import {type Capabilities,type ReadingCopy,type Settings,type Entitlements} from './types';
import * as store from './library/store';
import {emptyPage} from './reader/model';
import {Reader} from './reader/Reader';
import {Preferences} from './ui/Preferences';
import {Library} from './ui/Library';
import {TranslationHistory} from './ui/History';
import {UsagePage} from './ui/Usage';
import {EntitlementCards} from './ui/Entitlements';
import {PlusOffer} from './ui/PlusOffer';
import {FeedbackInbox} from './ui/Feedback';
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
import {RequestPool} from './concurrency';
import {AdminPanel} from './admin/AdminPanel';
import {finishOidc,startOidc,isOidcCallback,type AuthConfig} from './auth/oidc';
type View='library'|'history'|'usage'|'settings'|'account'|'admin';
export function App(){
const [copies,setCopies]=useState<ReadingCopy[]>([]);const copiesRef=useRef(copies);copiesRef.current=copies;
const [library,setLibrary]=useState(emptyLibrary);const [catalog,setCatalog]=useState<SourceCatalog>();
const [importError,setImportError]=useState('');const [localImport]=useState(()=>new LocalImportQueue());const [importExpanded,setImportExpanded]=useState(false);
useEffect(()=>{localImport.activate();return()=>localImport.dispose();},[localImport]);
async function reloadLibrary(){const [state,values]=await Promise.all([store.readLibrary(),store.readCopies()]);setLibrary(state);copiesRef.current=values;setCopies(values);setCacheBytes(await store.cacheSize());}
useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>void reloadLibrary().catch(e=>setError(e.message)),60);};window.addEventListener('nc-library-change',changed);const channel=new BroadcastChannel('nc-library');channel.onmessage=changed;const broadcast=()=>channel.postMessage('change');window.addEventListener('nc-library-change',broadcast);return()=>{clearTimeout(timer);channel.close();window.removeEventListener('nc-library-change',changed);window.removeEventListener('nc-library-change',broadcast);};},[]);
async function openCopy(copyId:string,edition?:TranslationEdition,pageId?:string){setNavigationKey(n=>n+1);setReadingEdition(edition);if(edition)setSettings(s=>({...s,translationMode:edition.mode,language:edition.language}));const destination=copiesRef.current.find(c=>c.id===copyId);if(destination&&pageId&&destination.pages.some(p=>p.id===pageId)){store.savePosition(copyId,destination.manifestRevision,{pageId,relativeOffset:0});}setCurrentId(copyId);const copy=copiesRef.current.find(c=>c.id===copyId);if(copy?.sourceEntryId&&(!copy.discoveryComplete||copy.pages.some(p=>!p.blobKey)))try{await queueCopies([copyId],false);}catch(e){setError('原图采集未启动：'+(e as Error).message);}}
const sourceLock=useRef(false);
async function openSource(url:string,propagateError=false){if(sourceLock.current)return;sourceLock.current=true;setBusy('正在发现来源目录…');setError('');try{setCatalog(await discoverCatalog(url));setCurrentId(undefined);setView('library');}catch(e){setError((e as Error).message);if(propagateError)throw e;}finally{sourceLock.current=false;setBusy('');}}
function chooseFiles(files:File[]){if(input.current)input.current.value='';if(!files.length)return;setImportExpanded(true);void localImport.add(files).then(added=>{if(!added)notify('请在当前检查或导入结束后添加文件；当前清单已保留。');});}
const [readingEdition,setReadingEdition]=useState<TranslationEdition>();const [navigationKey,setNavigationKey]=useState(0);
const [currentId,setCurrentId]=useState<string>();const current=copies.find(c=>c.id===currentId);
const [view,setView]=useState<View>((['library','history','usage','settings','account','admin'].includes(location.hash.slice(1))?location.hash.slice(1) as View:'library'));
const [settings,setSettings]=useState<Settings>(store.settings);const [account,setAccount]=useState(store.session);const accountRef=useRef(account);accountRef.current=account;
useAppearance(settings);
useEffect(()=>{const coordinator=new AcquisitionCoordinator();const tick=()=>void coordinator.run(settings.cacheLimitMb).catch(e=>setError(e.message));tick();const timer=setInterval(tick,2000);return()=>{clearInterval(timer);coordinator.stop();};},[settings.cacheLimitMb]);
const apiOrigin=useMemo(()=>{try{return new URL(settings.apiBase).origin;}catch{return '';}},[settings.apiBase]);
const requestPool=useRef(new RequestPool(settings.requestConcurrency));
useEffect(()=>{requestPool.current.setLimit(settings.requestConcurrency);},[settings.requestConcurrency]);
const api=useMemo(()=>new Api(settings.apiBase,account?.apiOrigin===apiOrigin?account.token:'',requestPool.current),[settings.apiBase,account,apiOrigin]);
const apiRef=useRef(api);apiRef.current=api;api.isCurrent=()=>apiRef.current===api;
const [caps,setCaps]=useState<Capabilities>();const [usage,setUsage]=useState<Entitlements>();
const [busy,setBusy]=useState('');const [toast,setToast]=useState<{message:string;id:number}>();const [error,setErrorMessage]=useState('');const [drag,setDrag]=useState(false);
const setError=useCallback((message:string)=>setErrorMessage(message),[]);
const [loginOpen,setLoginOpen]=useState(false);const [username,setUsername]=useState('reader');const [authAllowed,setAuthAllowed]=useState(false);
const [authConfig,setAuthConfig]=useState<AuthConfig>();
const [confirmAction,setConfirmAction]=useState<{title:string;body:string;action:()=>Promise<void>}>();
const [cacheBytes,setCacheBytes]=useState(0);const [upgradeOpen,setUpgradeOpen]=useState(false);
const input=useRef<HTMLInputElement>(null);const [sourceManifest,setSourceManifest]=useState<PageManifest>();
const noticeId=useRef(0);
const notify=useCallback((message:string)=>setToast({message,id:++noticeId.current}),[]);
async function saveApiAddress(apiDraft:string){
  try{
    const url=new URL(apiDraft);const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash)throw Error('服务地址须为 HTTPS，或本机 HTTP 地址，不可包含凭据与查询参数。');
    if(typeof chrome!=='undefined'&&chrome.permissions){const granted=await chrome.permissions.request({origins:[url.origin+'/*']});if(!granted)throw Error('尚未取得新服务域名的访问权限。');}
    const base=url.href.replace(/\/+$/,'');
    if(base!==api.base){store.saveSession(null);setAccount(null);setUsage(undefined);setCaps(undefined);api.isCurrent=()=>false;}
    setSettings(s=>({...s,apiBase:base}));notify('服务地址已保存；切换服务后需重新登录');
  }catch(e){setError((e as Error).message);}
}
const importLock=useRef(false);
useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(undefined),6000);return()=>clearTimeout(timer);}},[toast]);
useEffect(()=>{reloadLibrary().catch(e=>setError(`本地书架无法读取：${e.message}`));store.cacheSize().then(setCacheBytes);},[]);
useEffect(()=>{if(!isOidcCallback())return;void finishOidc().then(value=>{if(value){if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请回到原服务或重新登录。');store.saveSession(value);setAccount(value);const copyId=sessionStorage.getItem('nc-login-copy');if(copyId)setCurrentId(copyId);sessionStorage.removeItem('nc-login-copy');notify('登录成功，已返回原来的阅读位置');}}).catch(e=>setError((e as Error).message));},[]);
useEffect(()=>{store.saveSettings(settings);},[settings]);
useEffect(()=>{let live=true;Promise.allSettled([api.authConfig(),...(account?[api.entitlements()]:[])]).then(results=>{if(!live)return;const a=results[0];if(a.status==='fulfilled'){setAuthAllowed(Boolean((a.value as AuthConfig).dev_auth));setAuthConfig(a.value as AuthConfig);}if(results[1]?.status==='fulfilled')setUsage(results[1].value as Entitlements);});return()=>{live=false};},[api,account]);
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
  const timer=setInterval(refresh,30000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[api]);
const updateCopy=useCallback((copy:ReadingCopy)=>{const previous=copiesRef.current;const next=previous.some(c=>c.id===copy.id)?previous.map(c=>c.id===copy.id?copy:c):[copy,...previous];copiesRef.current=next;setCopies(next);void store.saveCopy(copy).catch(e=>setError(`本地记录未保存：${e.message}`));},[]);
const refreshUsage=useCallback(()=>{if(accountRef.current)void api.entitlements().then(value=>{if(api.isCurrent()){setUsage(value);setCaps(current=>current?{...current,entitlements:value}:current);}}).catch(()=>{});},[api]);
const translation=useAutomaticTranslation({api,userId:account?.user.id,origin:apiOrigin,copies,updateCopy,concurrency:settings.requestConcurrency,language:settings.language,currentId,caps,rights:usage??caps?.entitlements,refreshUsage});
useEffect(()=>{
  if(!account)return;
  const refresh=()=>{if(document.visibilityState==='visible')refreshUsage();};
  const timer=setInterval(refresh,30000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[account,refreshUsage]);

const directory=useMemo(()=>current?readingDirectory(library,copies,current):undefined,[library,copies,current]);
const sequence=current?readingSequence(library,copies,current):[];
const sourceTask=library.tasks.find(t=>t.copyId===currentId&&t.status!=='complete');
useEffect(()=>{const manifestId=new URLSearchParams(location.search).get('manifest');if(!manifestId||typeof chrome==='undefined'||!chrome.storage?.local)return;chrome.storage.local.get([`manifest:${manifestId}`,'pendingLanguage']).then(data=>{if(data.pendingLanguage)setSettings(s=>({...s,language:String(data.pendingLanguage)}));const m=data[`manifest:${manifestId}`] as PageManifest;if(m)setSourceManifest(m);});},[]);
useEffect(()=>{const catalogId=new URLSearchParams(location.search).get('catalog');if(!catalogId||typeof chrome==='undefined'||!chrome.storage?.local)return;chrome.storage.local.get('nc-import:'+catalogId).then(data=>{const draft=data['nc-import:'+catalogId] as {catalog:SourceCatalog}|undefined;if(draft?.catalog)setCatalog(draft.catalog);});},[]);
async function openDemo(){const existing=copiesRef.current.find(c=>c.demo);if(existing){setCurrentId(existing.id);return;}setBusy('正在打开原创阅读示例…');try{const blob=await(await fetch('/samples/starlight-bookshop.png')).blob();const bitmap=await createImageBitmap(blob);const p=emptyPage('星光书店 · 原创示例.png',bitmap.width,bitmap.height);bitmap.close();Object.assign(p,await imageIdentity(blob));p.blobKey=`original:${p.id}`;await store.putBlob(p.blobKey,blob);const c={...makeCopy('星光书店', [p],'原创阅读示例','demo:starlight'),demo:true};const result=await store.commitCopies([c],[{title:'星光书店',kind:'work'}]);await reloadLibrary();setCurrentId(result.copyIds[0]);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
async function acquireManifest(manifest:PageManifest,destination:WebDestination){
 if(importLock.current)return;
 importLock.current=true;setBusy('正在获取已发现的原图…');setImportError('');
 let copy:ReadingCopy|undefined;
 try{
  copy=await acquireWebImages(manifest,settings.cacheLimitMb,setBusy,destination.mode==='insert'?destination.copyId:undefined);
  let copyId:string,message:string;
  if(destination.mode==='insert'){
   const result=await insertWebCopy(copy,destination);copyId=result.copyId;message=result.added?`已插入 ${result.added} 页，保留原阅读位置`:'这些图片已插入，已保留原页序与阅读位置';
  }else{
   copy.title=destination.title;
   const result=await store.commitCopies([copy],[destination.assignment]);copyId=result.copyIds[0];message=result.created?'已加入漫画':'此来源已加入，保留原归属与阅读位置';
   setSettings(s=>({...s,direction:manifest.direction}));
  }
  await reloadLibrary();const state=await store.readLibrary(),workId=state.coverage.find(item=>item.copyId===copyId)?.workId;
  if(workId)localStorage.setItem('nc-web-import-work',workId);
  setCurrentId(copyId);setNavigationKey(n=>n+1);setSourceManifest(undefined);
  notify(`${message}；已获取 ${copy.pages.filter(page=>page.blobKey).length} / ${copy.pages.length} 张原图`);
 }catch(e){setImportError('加入未完成：'+(e as Error).message);}
 finally{if(copy)await store.collectUnusedBlobs(store.copyBlobKeys(copy)).catch(()=>{});importLock.current=false;setBusy('');}
}
async function authenticate(){setBusy('正在登录…');setError('');try{let value:store.Session;if(authAllowed){const auth=await api.login(username.trim());value={token:auth.access_token,user:auth.user,apiOrigin};}else{if(!authConfig)throw Error('无法读取身份服务配置。');if(currentId)sessionStorage.setItem('nc-login-copy',currentId);const result=await startOidc(authConfig,settings.apiBase);if(!result)return;value=result;}if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请重新登录。');store.saveSession(value);setAccount(value);setLoginOpen(false);notify('已连接账户，可以开始翻译了');}catch(e){setError((e as Error).message);}finally{setBusy('');}}
function exitReader(){setReadingEdition(undefined);setCurrentId(undefined);}
const rights=usage??caps?.entitlements;
const nav=(value:View)=>{exitReader();setView(value);location.hash=value;setError('');};
return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=current?'none':'copy';setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files));}}>
<input aria-label="选择漫画图片" type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
{!current&&<header className="nc-app-header"><button className="nc-brand" aria-label="返回我的漫画" onClick={()=>nav('library')}><span>✦</span><b>Node Comics</b></button><nav aria-label="主导航">{([['library','我的漫画','book'],['history','翻译记录','clock'],['usage','用量统计','coin']] as const).map(([value,label,icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>nav(value)}><Icon name={icon} size={19}/>{label}</button>)}</nav><div className="nc-header-actions"><button className="icon-button" aria-label="外观与设置" onClick={()=>nav('settings')}><Icon name="settings"/></button><button className="nc-account-button" onClick={()=>account?nav('account'):setLoginOpen(true)}><span className="nc-avatar">{account?account.user.name[0].toUpperCase():<Icon name="user" size={18}/>}</span><span>{account?(rights?.plan==='plus'?'PLUS':'普通用户'):'登录'}</span></button></div></header>}
<div className="nc-workspace">
{error&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
{current?<Reader directory={directory} onCatalog={directory?.catalogUrl?()=>{exitReader();void openSource(directory.catalogUrl!);}:undefined} initialView={readingEdition?{mode:readingEdition.mode,preference:'translation'}:undefined} onMarkRead={store.markCopyRead} sequence={sequence} onActiveCopy={setCurrentId} onLoadCopy={id=>{const c=copiesRef.current.find(c=>c.id===id);const task=library.tasks.find(t=>t.copyId===id);if(c?.sourceEntryId&&(!c.discoveryComplete||c.pages.some(p=>!p.blobKey))&&task?.status!=='paused'&&task?.status!=='failed')void queueCopies([id],false).catch(e=>setError('原图采集未启动：'+e.message));}} sourceStatus={sourceTask?(sourceTask.error??(sourceTask.phase==='discover'?'正在发现图片清单':'正在获取原图'))+' · '+sourceTask.completed+' / '+(sourceTask.total??'未知'):undefined} onAcquire={()=>void grantImagePermissions([current.id],copiesRef.current).then(()=>notify('已提交采集，原图进度将在阅读页更新')).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseCopies([current.id]).then(()=>notify('已暂停原图采集，已保存的页面仍可阅读')).catch(e=>setError(e.message))} onNavigate={(id,pageId)=>void openCopy(id,readingEdition,pageId)} key={`${account?.user.id}:${apiOrigin}:${readingEdition?.mode??''}:${readingEdition?.language??''}:${navigationKey}`} api={api} busy={!!busy} copy={current} settings={settings} setSettings={setSettings} update={updateCopy} onBack={exitReader} onRetry={(page,mode,copyId)=>void translation.retry(copyId??current.id,page,mode).catch(e=>notify(e.message))} onUpgrade={()=>setUpgradeOpen(true)} onLogin={()=>setLoginOpen(true)} translationState={translation.stateFor} onImport={()=>input.current?.click()} notify={notify} onReadingWindow={translation.onReadingWindow} caps={caps?{...caps,entitlements:usage??caps.entitlements}:undefined} userId={account?.user.id} apiOrigin={apiOrigin}/>:
<main className="nc-main">{view==='admin'&&account?.user.role==='admin'&&<><AdminPanel api={api}/><FeedbackInbox api={api} admin/></>}
{view==='library'&&(catalog?<CatalogImport key={catalog.id+':'+catalog.observedAt} catalog={catalog} library={library} copies={copies} onClose={()=>{setCatalog(undefined);history.replaceState(null,'',location.pathname);}} onDone={()=>void reloadLibrary()} onNotice={notify} onRefresh={()=>openSource(catalog.url,true)}/>:<Library api={api} userId={account?.user.id} apiOrigin={apiOrigin} onOpenTranslation={(id,edition)=>void openCopy(id,edition)} library={library} copies={copies} settings={settings} setSettings={setSettings} onOpen={id=>void openCopy(id)} onImport={()=>input.current?.click()} onDemo={()=>void openDemo()} notify={notify} onChanged={()=>void reloadLibrary()} onSource={url=>void openSource(url)}/>)}

{view==='history'&&<TranslationHistory key={`${apiOrigin}:${account?.user.id??''}`} api={api} copies={copies} userId={account?.user.id} onLogin={()=>setLoginOpen(true)} onOpen={(copy,job,group)=>{const mode=job?.mode??group?.mode;const language=job?.target_language??group?.target_language;if(mode&&language)setSettings(s=>({...s,translationMode:mode,language}));const page=job?copy.pages.find(p=>p.jobs.some(j=>j.id===job.id)||p.assetId===(job.requested_asset_id??job.input_asset_id)):undefined;if(page){store.savePosition(copy.id,copy.manifestRevision,{pageId:page.id,relativeOffset:0});updateCopy({...copy,pageId:page.id,relativeOffset:0});}setCurrentId(copy.id);}} onDelete={(job,onDeleted)=>setConfirmAction({title:'删除服务器译图？',body:'删除后撤销服务器访问，已保存的本地副本仍可阅读。重新翻译需要新的翻译任务。',action:async()=>{await api.deleteImage(job.output_asset_id!);if(!api.isCurrent())return;for(const c of copiesRef.current)updateCopy({...c,pages:c.pages.map(p=>p.ownerId===account?.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:p.jobs.map(j=>j.output_asset_id===job.output_asset_id?{...j,output_asset_id:null,result_available:false,result_expired:true}:j)}:p)});notify('服务器译图已删除');onDeleted();}})}/>}
{view==='usage'&&<UsagePage key={`${apiOrigin}:${account?.user.id??''}`} api={api} onLogin={()=>setLoginOpen(true)}/>}
{view==='settings'&&<Preferences key={`${apiOrigin}:${account?.user.id??''}`} api={api} account={!!account} settings={settings} setSettings={setSettings} caps={caps} cacheBytes={cacheBytes} notify={notify} onSaveApiAddress={saveApiAddress} onClearCache={()=>setConfirmAction({title:'清理本地图片缓存？',body:'所有本地原图和译图将被删除，书架和进度保留。已上传的原图和译图可从账户重新获取，未上传的原图需重新导入。',action:async()=>{await store.clearImages(copiesRef.current);setCopies(await store.readCopies());setCacheBytes(0);notify('本地图片已清理，书架与进度已保留');}})}/>}
{view==='account'&&<><PageTitle eyebrow="A LITTLE MAGIC FOR EVERY PAGE" title="我的账户" description="查看会员权益与有效期。"/>{account?<><div className="account-summary"><span className="avatar large">{account.user.name[0].toUpperCase()}</span><div><h2>{account.user.name}</h2><p>{authAllowed?'本地测试账户':'已登录账户'} · {account.user.role==='admin'?'管理员':'读者'}</p></div><button className="button secondary small" onClick={()=>{api.isCurrent=()=>false;store.saveSession(null);setAccount(null);setUsage(undefined);notify('已退出账户，原图仍可继续阅读');}}>退出登录</button></div><EntitlementCards data={rights??undefined}/><PlusOffer api={api} onChanged={refreshUsage}/><section className="settings-card"><div className="nc-section-heading"><div><h2>用量与反馈</h2><p className="nc-muted">查看实际消耗、逐笔记录和反馈处理进展。</p></div><button className="button primary" onClick={()=>nav('usage')}>查看用量统计</button>{account.user.role==='admin'&&<button className="button secondary" onClick={()=>nav('admin')}><Icon name="shield"/>运营管理</button>}</div></section><FeedbackInbox api={api}/></>:<div className="login-prompt"><span className="feature-icon pink"><Icon name="user" size={28}/></span><h2>准备好，一起漫游了吗？</h2><p>无需登录即可阅读原图。登录账户，阅读时自动翻译。</p><button className="button primary" onClick={()=>setLoginOpen(true)}>登录账户 <Icon name="arrow" size={18}/></button></div>}<div className="privacy-note standalone"><Icon name="info"/><p>订阅权益由付款状态自动同步；管理员赠送权益与页数按各自期限独立生效。</p></div></>}
</main>}
</div>
{drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>把故事放在这里</h2><p>支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）</p></div>}
{busy&&<div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}{toast&&<div key={toast.id} className="toast" role="status" aria-live="polite" aria-atomic="true"><Icon name="check" size={18}/><span>{toast.message}</span><button className="icon-button" aria-label="关闭操作提示" onClick={()=>setToast(undefined)}><Icon name="close" size={16}/></button></div>}
{loginOpen&&<Modal title="连接你的漫游账户" subtitle="原图无需登录。登录后随读随译，当前页与后两页自动翻译。" onClose={()=>{setLoginOpen(false);}}>
  {authAllowed?<><div className="notice"><Icon name="info"/><span>本地测试登录已由后端开启，仅用于开发验证。</span></div><label className="field">测试用户名<input value={username} maxLength={60} onChange={e=>setUsername(e.target.value)} placeholder="例如 reader" autoFocus/></label></>:<div className="notice"><Icon name="shield"/><span>{authConfig?.mode==='oidc'?'将前往身份服务安全登录，完成后回到当前阅读位置。':'身份服务尚未配置，请联系运营方。'}</span></div>}
  <button className="button primary full" style={{marginTop:20}} disabled={!!busy||(authAllowed?!username.trim():authConfig?.mode!=='oidc'||!authConfig?.authorization_endpoint||!authConfig?.token_endpoint||!authConfig?.client_id)} onClick={()=>void authenticate()}>{authAllowed?'连接测试账户':'继续登录'} <Icon name="arrow" size={18}/></button>
</Modal>}

{upgradeOpen&&<Modal title="升级权益" onClose={()=>setUpgradeOpen(false)}><PlusOffer api={api} onChanged={refreshUsage}/></Modal>}
<LocalImport queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={()=>input.current?.click()} onOpen={id=>{void reloadLibrary().then(()=>openCopy(id)).catch(e=>setError(e.message));}} library={library} limitMb={settings.cacheLimitMb}/>
{sourceManifest&&<SourceImport key={sourceManifest.id} manifest={sourceManifest} library={library} copies={copies} busy={!!busy} error={importError} onClose={()=>{setSourceManifest(undefined);setImportError('');}} onImport={acquireManifest}/>}
{confirmAction&&<Modal title={confirmAction.title} subtitle={confirmAction.body} onClose={()=>setConfirmAction(undefined)}><button className="button primary full" onClick={async()=>{const action=confirmAction;setConfirmAction(undefined);try{await action.action();}catch(e){setError((e as Error).message);}}}>确认</button></Modal>}
</div>;
}
