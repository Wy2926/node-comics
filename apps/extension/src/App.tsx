import {useTranslationQueue} from './translation/useTranslationQueue';
import {translationScope,type UploadManifest,type UploadItem} from './translation/store';
import {TranslationQueue} from './ui/TranslationQueue';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Icon} from './icons';
import {Modal,PageTitle} from './ui/components';
import {mergeJobs} from './reader/jobs';
import {Api} from './api';
import {modeLabels,type Capabilities,type ReadingCopy,type Job,type Mode,type Page,type Settings,type Entitlements,type ModeQueue} from './types';
import * as store from './library/store';
import {emptyPage,id} from './reader/model';
import {Reader} from './reader/Reader';
import {Preferences} from './ui/Preferences';
import {Library} from './ui/Library';
import {TranslationHistory} from './ui/History';
import {UsagePage} from './ui/Usage';
import {EntitlementCards,entitlementDescription} from './ui/Entitlements';
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
import {hashFile,imageIdentity} from './importers/hash';
import {assertCurrent,RequestPool} from './concurrency';
import {applyMatch,matchFilePages,pageSource,planTranslation,reusableJob,sourceKey} from './reader/recovery';
import {AdminPanel} from './admin/AdminPanel';
import {finishOidc,startOidc,isOidcCallback,type AuthConfig} from './auth/oidc';
type View='queues'|'library'|'history'|'usage'|'settings'|'account'|'admin';
type Intent={mode:Mode;pages:Page[];regenerate?:boolean};
type ReadySubmission={intent:Intent;copyId:string;title:string;ownerId:string;apiOrigin:string;targetLanguage:string;pages:Page[];reused:number;queue:ModeQueue;rights:Entitlements['modes'][Mode]};

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
const [view,setView]=useState<View>((location.hash.slice(1) as View)||'library');
const [settings,setSettings]=useState<Settings>(store.settings);const [account,setAccount]=useState(store.session);const accountRef=useRef(account);accountRef.current=account;
useAppearance(settings);
useEffect(()=>{const coordinator=new AcquisitionCoordinator();const tick=()=>void coordinator.run(settings.cacheLimitMb).catch(e=>setError(e.message));tick();const timer=setInterval(tick,2000);return()=>{clearInterval(timer);coordinator.stop();};},[settings.cacheLimitMb]);
const apiOrigin=useMemo(()=>{try{return new URL(settings.apiBase).origin;}catch{return '';}},[settings.apiBase]);
const requestPool=useRef(new RequestPool(settings.requestConcurrency));
useEffect(()=>{requestPool.current.setLimit(settings.requestConcurrency);},[settings.requestConcurrency]);
const api=useMemo(()=>new Api(settings.apiBase,account?.apiOrigin===apiOrigin?account.token:'',requestPool.current),[settings.apiBase,account,apiOrigin]);
const apiRef=useRef(api);apiRef.current=api;api.isCurrent=()=>apiRef.current===api;
const [recoveryStatus,setRecoveryStatus]=useState('');const [recovering,setRecovering]=useState(false);const recoveryRun=useRef(0);
const prepareLock=useRef(false);
const [caps,setCaps]=useState<Capabilities>();const [usage,setUsage]=useState<Entitlements>();
const [busy,setBusy]=useState('');const [toast,setToast]=useState<{message:string;id:number}>();const [error,setErrorMessage]=useState('');const [drag,setDrag]=useState(false);
const setError=useCallback((message:string)=>setErrorMessage(message),[]);
const [loginOpen,setLoginOpen]=useState(false);const [username,setUsername]=useState('reader');const [authAllowed,setAuthAllowed]=useState(false);const [pendingIntent,setPendingIntent]=useState<Intent>();
const [authConfig,setAuthConfig]=useState<AuthConfig>();
const [ready,setReady]=useState<ReadySubmission>();const [confirmAction,setConfirmAction]=useState<{title:string;body:string;action:()=>Promise<void>}>();
const [cacheBytes,setCacheBytes]=useState(0);const [preparingPages,setPreparingPages]=useState<string[]>([]);const [continuous,setContinuous]=useState(false);const [ackUnknownCost,setAckUnknownCost]=useState(false);const currentRef=useRef(currentId);currentRef.current=currentId;
const input=useRef<HTMLInputElement>(null);const [sourceManifest,setSourceManifest]=useState<PageManifest>();
const noticeId=useRef(0);
const notify=useCallback((message:string)=>setToast({message,id:++noticeId.current}),[]);
async function saveApiAddress(apiDraft:string){
  try{
    const url=new URL(apiDraft);const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash)throw Error('服务地址须为 HTTPS，或本机 HTTP 地址，不可包含凭据与查询参数。');
    if(typeof chrome!=='undefined'&&chrome.permissions){const granted=await chrome.permissions.request({origins:[url.origin+'/*']});if(!granted)throw Error('尚未取得新服务域名的访问权限。');}
    const base=url.href.replace(/\/+$/,'');
    if(base!==api.base){store.saveSession(null);setAccount(null);setUsage(undefined);setCaps(undefined);setReady(undefined);setPendingIntent(undefined);api.isCurrent=()=>false;}
    setSettings(s=>({...s,apiBase:base}));notify('服务地址已保存；切换服务后需重新登录');
  }catch(e){setError((e as Error).message);}
}
const importLock=useRef(false);
useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(undefined),6000);return()=>clearTimeout(timer);}},[toast]);
useEffect(()=>{reloadLibrary().catch(e=>setError(`本地书架无法读取：${e.message}`));store.cacheSize().then(setCacheBytes);},[]);
useEffect(()=>{if(!isOidcCallback())return;void finishOidc().then(value=>{if(value){if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请回到原服务或重新登录。');store.saveSession(value);setAccount(value);const copyId=sessionStorage.getItem('nc-login-copy');if(copyId)setCurrentId(copyId);sessionStorage.removeItem('nc-login-copy');notify('登录成功，已返回原来的阅读位置');}}).catch(e=>setError((e as Error).message));},[]);
useEffect(()=>{store.saveSettings(settings);},[settings]);
useEffect(()=>{let live=true;Promise.allSettled([api.capabilities(),api.authConfig(),...(account?[api.entitlements()]:[])]).then(results=>{if(!live)return;const c=results[0];if(c.status==='fulfilled'){setCaps(c.value as Capabilities);}const a=results[1];if(a.status==='fulfilled'){setAuthAllowed(Boolean((a.value as AuthConfig).dev_auth));setAuthConfig(a.value as AuthConfig);}if(results[2]?.status==='fulfilled')setUsage(results[2].value as Entitlements);});return()=>{live=false};},[api,account]);
const updateCopy=useCallback((copy:ReadingCopy)=>{const previous=copiesRef.current;const next=previous.some(c=>c.id===copy.id)?previous.map(c=>c.id===copy.id?copy:c):[copy,...previous];copiesRef.current=next;setCopies(next);void store.saveCopy(copy).catch(e=>setError(`本地记录未保存：${e.message}`));},[]);
const refreshUsage=useCallback(()=>{if(accountRef.current)void api.entitlements().then(value=>{if(api.isCurrent()){setUsage(value);setCaps(current=>current?{...current,entitlements:value}:current);}}).catch(()=>{});},[api]);
const translationQueue=useTranslationQueue({api,userId:account?.user.id,origin:apiOrigin,copies,updateCopy,concurrency:settings.requestConcurrency,language:settings.language,currentId});
useEffect(()=>{
  if(!account)return;
  const refresh=()=>{if(document.visibilityState==='visible')refreshUsage();};
  const timer=setInterval(refresh,30000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[account,refreshUsage]);

const recoveryModeEnabled=!!caps?.modes.find(m=>m.id===settings.translationMode)?.enabled;
const currentLoaded=!!current;
const directory=useMemo(()=>current?readingDirectory(library,copies,current):undefined,[library,copies,current]);
const sequence=current?readingSequence(library,copies,current):[];
const sourceTask=library.tasks.find(t=>t.copyId===currentId&&t.status!=='complete');
async function recoverCopy(manual=false,mode=settings.translationMode,requestedPages?:Page[]){
  const copyId=currentRef.current;const acc=accountRef.current;
  if(!copyId||!acc){if(manual&&!acc)setLoginOpen(true);return;}
  const copy=copiesRef.current.find(c=>c.id===copyId);if(!copy)return;
  const run=++recoveryRun.current;setRecovering(true);setRecoveryStatus('正在查找当前账户的翻译…');
  try{
    const {matches,errors}=await matchFilePages(api,requestedPages??copy.pages,mode,settings.language);
    if(!api.isCurrent()||run!==recoveryRun.current||currentRef.current!==copyId)return;
    const latest=copiesRef.current.find(c=>c.id===copyId);if(!latest)return;
    let restored=0;
    const pages=latest.pages.map(page=>{
      const source=pageSource(page);const match=source&&matches.get(sourceKey(source));
      if(!match)return page;
      if((match.display_jobs??match.jobs).some(j=>reusableJob(j,mode,settings.language)))restored++;
      return applyMatch(page,match,acc.user.id,apiOrigin,copy.pages.find(p=>p.id===page.id));
    });
    updateCopy({...latest,pages});
    const missing=pages.filter(p=>!pageSource(p)).length;
    setRecoveryStatus(errors.size?`${errors.size} 页匹配失败，可重试；已找回 ${restored} 页翻译`:`已找回 ${restored} 页翻译${restored?'，当前阅读附近的译图将按需加载':''}${missing?`；${missing} 页缺少标识，请重新导入`:''}`);
  }catch(e){if(api.isCurrent()&&run===recoveryRun.current)setRecoveryStatus(`恢复未完成：${(e as Error).message}`);}
  finally{if(api.isCurrent()&&run===recoveryRun.current)setRecovering(false);}
}
useEffect(()=>{
  ++recoveryRun.current;setRecovering(false);setRecoveryStatus('');
  if(account&&currentLoaded)void recoverCopy();
  return()=>{++recoveryRun.current;};
},[api,currentId,currentLoaded,settings.translationMode,settings.language,recoveryModeEnabled]);

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
useEffect(()=>{if(account&&pendingIntent){const intent=pendingIntent;setPendingIntent(undefined);void prepareTranslation(intent);} },[account]);
async function prepareTranslation(intent:Intent){
 const acc=accountRef.current,copyId=currentRef.current;
 if(!acc){setPendingIntent(intent);setLoginOpen(true);return;}
 if(!copyId||prepareLock.current)return;
 prepareLock.current=true;setBusy('正在核实翻译范围、队列容量与权益…');setError('');
 try{
  const [capabilities,queueData,benefits]=await Promise.all([api.capabilities(),api.queues(),api.entitlements()]);assertCurrent(api.isCurrent);
  setCaps(capabilities);setUsage(benefits);
  if(!capabilities.modes.find(m=>m.id===intent.mode)?.enabled)throw Error(`${modeLabels[intent.mode]}尚未配置就绪。`);
  if(capabilities.modes.find(m=>m.id===intent.mode)?.languages?.includes(settings.language)===false)throw Error('此目标语言暂不支持所选模式，请使用常规翻译或更换目标语言。');
  const rights=benefits.modes[intent.mode];if(!rights.allowed)throw Error('此模式需要 PLUS 或有效赠送额度。');
  const copy=copiesRef.current.find(c=>c.id===copyId);if(!copy)return;
  const requested=copy.pages.filter(p=>intent.pages.some(i=>i.id===p.id));setPreparingPages(requested.map(p=>p.id));
  const found=await matchFilePages(api,requested,intent.mode,settings.language);assertCurrent(api.isCurrent);
  const latest=copiesRef.current.find(value=>value.id===copyId);if(!latest)return;
  const updated={...latest,pages:latest.pages.map(page=>{const source=pageSource(page),match=source&&found.matches.get(sourceKey(source));return match?applyMatch(page,match,acc.user.id,apiOrigin):page;})};updateCopy(updated);
  const selected=updated.pages.filter(p=>requested.some(i=>i.id===p.id));
  const plan=planTranslation(selected,found,intent.mode,settings.language,!!intent.regenerate);
  if(plan.failures.length)throw Error(plan.failures.map(f=>`${f.page.name}：${f.message}`).slice(0,3).join('；'));
  if(!plan.selected.length){notify('这些页面已有翻译结果或服务器任务，将按当前阅读位置优先处理');translationQueue.claimReading();return;}
  const queue=queueData.items.find(q=>q.mode===intent.mode);if(!queue)throw Error('服务器没有返回此模式的队列配置。');
  if(!rights.unlimited&&plan.selected.length>(rights.quota?.available??0))throw Error(`本次需要最多 ${plan.selected.length} 页额度，当前可用 ${rights.quota?.available??0} 页，请缩小范围。`);
  setContinuous(plan.selected.length>queue.available_slots);setAckUnknownCost(false);
  setReady({intent,copyId,title:copy.title,ownerId:acc.user.id,apiOrigin,targetLanguage:settings.language,pages:plan.selected,reused:requested.length-plan.selected.length,queue,rights});
 }catch(e){if(api.isCurrent())setError((e as Error).message);}
 finally{prepareLock.current=false;setBusy('');setPreparingPages([]);}
}
async function acceptSubmission(){
 const prepared=ready;if(!prepared||!account||busy)return;
 if(prepared.ownerId!==account.user.id||prepared.apiOrigin!==apiOrigin){setReady(undefined);return;}
 if(!continuous&&prepared.pages.length>prepared.queue.available_slots){setError('所选页数超过当前空位，请缩小范围或开启持续补充。');return;}
 setBusy('正在保存本机上传清单…');
 try{
  const items:UploadItem[]=[];
  for(const page of prepared.pages){
   const blob=page.blobKey?await store.getBlob(page.blobKey):undefined;assertCurrent(api.isCurrent);
   if(!blob&&!(page.assetId&&page.imageSha256&&page.imageByteSize))throw Error(`${page.name} 的原图未就绪，请先完成采集或重新导入。`);
   const itemId=id(),imageSha256=page.imageSha256??await hashFile(blob!);assertCurrent(api.isCurrent);
   items.push({id:itemId,copyId:prepared.copyId,pageId:page.id,blobKey:page.blobKey,state:'local',image:{client_item_id:itemId,...pageSource(page),image_sha256:imageSha256,byte_size:blob?.size??page.imageByteSize!,content_type:blob?.type||page.imageMime||'image/png',name:page.name,...(page.assetId?{asset_id:page.assetId}:{})}});
  }
  const previous=prepared.intent.regenerate?prepared.pages[0].jobs.filter(j=>j.mode===prepared.intent.mode&&j.target_language===prepared.targetLanguage).at(-1):undefined;
  const manifest:UploadManifest={id:id(),scope:translationScope(apiOrigin,account.user.id),title:prepared.title,mode:prepared.intent.mode,language:prepared.targetLanguage,quotaKind:prepared.rights.quota_kind,maxQuotaPages:items.length,regenerate:!!prepared.intent.regenerate,rerunJobId:previous?.id,acknowledgeUnknownCost:ackUnknownCost,continuous,paused:false,createdAt:Date.now(),items};
  await translationQueue.addManifest(manifest);assertCurrent(api.isCurrent);setReady(undefined);notify(`已保存 ${items.length} 页上传清单；原图校验后由服务器持续处理`);refreshUsage();
 }catch(e){if(api.isCurrent())setError((e as Error).message);}
 finally{setBusy('');}
}
async function cancelJob(job:Job){const result=await api.cancel(job.id);if(!api.isCurrent())return;for(const copy of copiesRef.current){const relevant=copy.pages.some(p=>p.jobs.some(j=>j.id===job.id));if(relevant)updateCopy({...copy,pages:copy.pages.map(p=>p.jobs.some(j=>j.id===job.id)?{...p,jobs:mergeJobs(p.jobs,[result])}:p)});}await translationQueue.refresh();refreshUsage();}
function openQueueJob(job:Job){const copy=copiesRef.current.find(c=>c.pages.some(p=>p.jobs.some(j=>j.id===job.id)));const page=copy?.pages.find(p=>p.jobs.some(j=>j.id===job.id));if(copy&&page){setSettings(s=>({...s,translationMode:job.mode,language:job.target_language}));void openCopy(copy.id,undefined,page.id);}else {notify('此任务来自另一设备，可在翻译记录中下载结果');nav('history');}}
function exitReader(){setReadingEdition(undefined);setCurrentId(undefined);}
const rights=usage??caps?.entitlements;
const nav=(value:View)=>{exitReader();setView(value);location.hash=value;setError('');};
return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=current?'none':'copy';setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files));}}>
<input aria-label="选择漫画图片" type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
{!current&&<header className="nc-app-header"><button className="nc-brand" aria-label="返回我的漫画" onClick={()=>nav('library')}><span>✦</span><b>Node Comics</b></button><nav aria-label="主导航">{([['library','我的漫画','book'],['queues','翻译队列','list'],['history','翻译记录','clock'],['usage','用量统计','coin']] as const).map(([value,label,icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>nav(value)}><Icon name={icon} size={19}/>{label}</button>)}</nav><div className="nc-header-actions"><button className="icon-button" aria-label="外观与设置" onClick={()=>nav('settings')}><Icon name="settings"/></button><button className="nc-account-button" onClick={()=>account?nav('account'):setLoginOpen(true)}><span className="nc-avatar">{account?account.user.name[0].toUpperCase():<Icon name="user" size={18}/>}</span><span>{account?(rights?.plan==='plus'?'PLUS':'普通用户'):'登录'}</span></button></div></header>}
<div className="nc-workspace">
{error&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
{current?<Reader directory={directory} onCatalog={directory?.catalogUrl?()=>{exitReader();void openSource(directory.catalogUrl!);}:undefined} initialView={readingEdition?{mode:readingEdition.mode,preference:'translation'}:undefined} onMarkRead={store.markCopyRead} sequence={sequence} onActiveCopy={setCurrentId} onLoadCopy={id=>{const c=copiesRef.current.find(c=>c.id===id);const task=library.tasks.find(t=>t.copyId===id);if(c?.sourceEntryId&&(!c.discoveryComplete||c.pages.some(p=>!p.blobKey))&&task?.status!=='paused'&&task?.status!=='failed')void queueCopies([id],false).catch(e=>setError('原图采集未启动：'+e.message));}} sourceStatus={sourceTask?(sourceTask.error??(sourceTask.phase==='discover'?'正在发现图片清单':'正在获取原图'))+' · '+sourceTask.completed+' / '+(sourceTask.total??'未知'):undefined} onAcquire={()=>void grantImagePermissions([current.id],copiesRef.current).then(()=>notify('已提交采集，原图进度将在阅读页更新')).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseCopies([current.id]).then(()=>notify('已暂停原图采集，已保存的页面仍可阅读')).catch(e=>setError(e.message))} onNavigate={(id,pageId)=>void openCopy(id,readingEdition,pageId)} key={`${account?.user.id}:${apiOrigin}:${readingEdition?.mode??''}:${readingEdition?.language??''}:${navigationKey}`} api={api} busy={!!busy} preparingPages={preparingPages} copy={current} settings={settings} setSettings={setSettings} update={updateCopy} onBack={exitReader} onTranslate={(mode,pages,regenerate)=>void prepareTranslation({mode,pages,regenerate})} onImport={()=>input.current?.click()} notify={notify} onReadingWindow={translationQueue.onReadingWindow} priorityStatus={translationQueue.priorityStatus} onClaimReading={translationQueue.claimReading} onOpenQueue={()=>nav('queues')} realtimeLimit={translationQueue.queues.find(q=>q.mode===settings.translationMode)?.realtime_limit??(rights?.plan==='plus'?10:2)} caps={caps?{...caps,entitlements:usage??caps.entitlements}:undefined} userId={account?.user.id} apiOrigin={apiOrigin} recoveryStatus={recoveryStatus} recovering={recovering} onRecover={(mode,pages)=>void recoverCopy(true,mode,pages)} recoveryEnabled={!!account} onCancel={async job=>{try{await cancelJob(job);}catch(e){setError((e as Error).message);}}}/>:
<main className="nc-main">{view==='admin'&&account?.user.role==='admin'&&<><AdminPanel api={api}/><FeedbackInbox api={api} admin/></>}
{view==='library'&&(catalog?<CatalogImport key={catalog.id+':'+catalog.observedAt} catalog={catalog} library={library} copies={copies} onClose={()=>{setCatalog(undefined);history.replaceState(null,'',location.pathname);}} onDone={()=>void reloadLibrary()} onNotice={notify} onRefresh={()=>openSource(catalog.url,true)}/>:<Library api={api} userId={account?.user.id} apiOrigin={apiOrigin} onOpenTranslation={(id,edition)=>void openCopy(id,edition)} library={library} copies={copies} settings={settings} setSettings={setSettings} onOpen={id=>void openCopy(id)} onImport={()=>input.current?.click()} onDemo={()=>void openDemo()} notify={notify} onChanged={()=>void reloadLibrary()} onSource={url=>void openSource(url)}/>)}

{view==='history'&&<TranslationHistory key={`${apiOrigin}:${account?.user.id??''}`} api={api} copies={copies} userId={account?.user.id} onLogin={()=>setLoginOpen(true)} onOpen={(copy,job,group)=>{const mode=job?.mode??group?.mode;const language=job?.target_language??group?.target_language;if(mode&&language)setSettings(s=>({...s,translationMode:mode,language}));const page=job?copy.pages.find(p=>p.jobs.some(j=>j.id===job.id)||p.assetId===(job.requested_asset_id??job.input_asset_id)):undefined;if(page){store.savePosition(copy.id,copy.manifestRevision,{pageId:page.id,relativeOffset:0});updateCopy({...copy,pageId:page.id,relativeOffset:0});}setCurrentId(copy.id);}} onDelete={(job,onDeleted)=>setConfirmAction({title:'删除服务器译图？',body:'删除后撤销服务器访问，已保存的本地副本仍可阅读。重新翻译需要新的翻译任务。',action:async()=>{await api.deleteImage(job.output_asset_id!);if(!api.isCurrent())return;for(const c of copiesRef.current)updateCopy({...c,pages:c.pages.map(p=>p.ownerId===account?.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:p.jobs.map(j=>j.output_asset_id===job.output_asset_id?{...j,output_asset_id:null,result_available:false,result_expired:true}:j)}:p)});notify('服务器译图已删除');onDeleted();}})}/>}
{view==='queues'&&<TranslationQueue queues={translationQueue.queues} jobs={translationQueue.jobs} manifests={translationQueue.manifests} error={translationQueue.error} onPause={translationQueue.pauseQueue} onLocalPause={translationQueue.toggleManifest} onCancel={cancelJob} onOpen={openQueueJob} onLogin={()=>setLoginOpen(true)} loggedIn={!!account}/>}
{view==='usage'&&<UsagePage key={`${apiOrigin}:${account?.user.id??''}`} api={api} onLogin={()=>setLoginOpen(true)}/>}
{view==='settings'&&<Preferences key={`${apiOrigin}:${account?.user.id??''}`} api={api} account={!!account} settings={settings} setSettings={setSettings} caps={caps} cacheBytes={cacheBytes} notify={notify} onSaveApiAddress={saveApiAddress} onClearCache={()=>setConfirmAction({title:'清理本地图片缓存？',body:'所有本地原图和译图将被删除，书架和进度保留。已上传的原图和译图可从账户重新获取，未上传的原图需重新导入。',action:async()=>{await store.clearImages(copiesRef.current);setCopies(await store.readCopies());setCacheBytes(0);notify('本地图片已清理，书架与进度已保留');}})}/>}
{view==='account'&&<><PageTitle eyebrow="A LITTLE MAGIC FOR EVERY PAGE" title="我的账户" description="查看会员权益、可用翻译页数与到期时间。成功交付后计量，失败释放预占。"/>{account?<><div className="account-summary"><span className="avatar large">{account.user.name[0].toUpperCase()}</span><div><h2>{account.user.name}</h2><p>{authAllowed?'本地测试账户':'已登录账户'} · {account.user.role==='admin'?'管理员':'读者'}</p></div><button className="button secondary small" onClick={()=>{api.isCurrent=()=>false;store.saveSession(null);setAccount(null);setUsage(undefined);setReady(undefined);notify('已退出账户，原图仍可继续阅读');}}>退出登录</button></div><EntitlementCards data={rights??undefined}/><section className="settings-card"><div className="nc-section-heading"><div><h2>用量与反馈</h2><p className="nc-muted">查看实际消耗、逐笔记录和反馈处理进展。</p></div><button className="button primary" onClick={()=>nav('usage')}>查看用量统计</button>{account.user.role==='admin'&&<button className="button secondary" onClick={()=>nav('admin')}><Icon name="shield"/>运营管理</button>}</div></section><FeedbackInbox api={api}/></>:<div className="login-prompt"><span className="feature-icon pink"><Icon name="user" size={28}/></span><h2>准备好，一起漫游了吗？</h2><p>无需登录即可阅读原图。登录账户，开始翻译并查看额度。</p><button className="button primary" onClick={()=>setLoginOpen(true)}>登录账户 <Icon name="arrow" size={18}/></button></div>}<div className="privacy-note standalone"><Icon name="info"/><p>会员由管理员开通，支付订阅尚未接入。基础额度与赠送额度分别按各自期限生效。</p></div></>}
</main>}
</div>
{drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>把故事放在这里</h2><p>支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）</p></div>}
{busy&&<div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}{toast&&<div key={toast.id} className="toast" role="status" aria-live="polite" aria-atomic="true"><Icon name="check" size={18}/><span>{toast.message}</span><button className="icon-button" aria-label="关闭操作提示" onClick={()=>setToast(undefined)}><Icon name="close" size={16}/></button></div>}
{loginOpen&&<Modal title="连接你的漫游账户" subtitle="原图无需登录。翻译任务和额度将归属于这个账户。" onClose={()=>{setLoginOpen(false);setPendingIntent(undefined);}}>
  {authAllowed?<><div className="notice"><Icon name="info"/><span>本地测试登录已由后端开启，仅用于开发验证。</span></div><label className="field">测试用户名<input value={username} maxLength={60} onChange={e=>setUsername(e.target.value)} placeholder="例如 reader" autoFocus/></label></>:<div className="notice"><Icon name="shield"/><span>{authConfig?.mode==='oidc'?'将前往身份服务安全登录，完成后回到当前阅读位置。':'身份服务尚未配置，请联系运营方。'}</span></div>}
  <button className="button primary full" style={{marginTop:20}} disabled={!!busy||(authAllowed?!username.trim():authConfig?.mode!=='oidc'||!authConfig?.authorization_endpoint||!authConfig?.token_endpoint||!authConfig?.client_id)} onClick={()=>void authenticate()}>{authAllowed?'连接测试账户':'继续登录'} <Icon name="arrow" size={18}/></button>
</Modal>}
{ready&&<Modal title={ready.intent.regenerate?'重新翻译这一页':`预存${modeLabels[ready.intent.mode]}`} subtitle="先保存上传清单，原图校验后服务器持续消费；可以继续阅读或离开当前漫画。" onClose={()=>{if(!busy)setReady(undefined);}}><div className="preview-summary"><span>新增页数<b>{ready.pages.length} <small>页</small></b></span><span>队列空位<b>{ready.queue.available_slots} / {ready.queue.capacity}</b></span><span>实时名额<b>{ready.queue.realtime_limit} <small>页</small></b></span></div><p className="modal-copy">{ready.reused?`已有 ${ready.reused} 页可复用，不重复入队。`:''}{entitlementDescription(ready.rights,ready.intent.mode)}。目标语言：{caps?.languages.find(l=>l.id===ready.targetLanguage)?.label??ready.targetLanguage}。本次最多新建 {ready.pages.length} 页任务，逐页交付和计量。</p><label className="nc-batch-continuous"><input type="checkbox" checked={continuous} onChange={e=>setContinuous(e.target.checked)}/><span><b>有空位时持续补充本次选择</b><br/>空位不足的页面先保存在本机；阅读中的页优先上传。仅限本次已确认的 {ready.pages.length} 页，关闭页面会停止尚未上传的补充。</span></label><p className="nc-muted">实时优先由服务器确认，普通每模式 2 页、PLUS 每模式 10 页。已经执行的阶段自然完成，原图与已有译图保留。</p>{ready.intent.regenerate&&ready.pages.some(p=>p.jobs.some(j=>j.status==='unknown_released'))&&<label className="nc-batch-continuous"><input type="checkbox" checked={ackUnknownCost} onChange={e=>setAckUnknownCost(e.target.checked)}/><span>原请求可能已产生供应商费用且无法确认结果。我确认新建一次重绘，可能再次产生费用。</span></label>}<button className="button primary full" disabled={!!busy||!continuous&&ready.pages.length>ready.queue.available_slots||ready.intent.regenerate&&ready.pages.some(p=>p.jobs.some(j=>j.status==='unknown_released'))&&!ackUnknownCost} onClick={()=>void acceptSubmission()}><Icon name="upload" size={18}/>确认并加入上传清单 · 最多 {ready.pages.length} 页</button></Modal>}

<LocalImport queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={()=>input.current?.click()} onOpen={id=>{void reloadLibrary().then(()=>openCopy(id)).catch(e=>setError(e.message));}} library={library} limitMb={settings.cacheLimitMb}/>
{sourceManifest&&<SourceImport key={sourceManifest.id} manifest={sourceManifest} library={library} copies={copies} busy={!!busy} error={importError} onClose={()=>{setSourceManifest(undefined);setImportError('');}} onImport={acquireManifest}/>}
{confirmAction&&<Modal title={confirmAction.title} subtitle={confirmAction.body} onClose={()=>setConfirmAction(undefined)}><button className="button primary full" onClick={async()=>{const action=confirmAction;setConfirmAction(undefined);try{await action.action();}catch(e){setError((e as Error).message);}}}>确认</button></Modal>}
</div>;
}
