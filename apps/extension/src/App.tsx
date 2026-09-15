import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Icon} from './icons';
import {Modal,PageTitle} from './ui/components';
import {mergeJobs,pendingStatuses} from './reader/jobs';
import {Api,ApiError,submissionRejected} from './api';
import {modeLabels,type Capabilities,type ReadingCopy,type Job,type Mode,type Page,type TranslationPreview,type Settings,type Entitlements} from './types';
import * as store from './library/store';
import {automaticScope,emptyPage,id} from './reader/model';
import {AutomaticTranslationQueue,type PreparationResult} from './reader/automatic';
import {autoConsentScope,readAutoConsents,saveAutoConsents,retryablePreparation,type AutoConsents} from './reader/auto-consent';
import {Reader} from './reader/Reader';
import {Preferences} from './ui/Preferences';
import {Library} from './ui/Library';
import {TranslationHistory} from './ui/History';
import {UsagePage} from './ui/Usage';
import {EntitlementCards,entitlementDescription} from './ui/Entitlements';
import {FeedbackInbox} from './ui/Feedback';
import {useAppearance} from './ui/Appearance';
import {latestResults} from './reader/presentation';
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
import {assertCurrent,mapConcurrent,RequestPool,StaleOperation} from './concurrency';
import {applyMatch,bindSubmission,matchFilePages,pageSource,planTranslation,reusableJob,rerunSource,sourceKey,uploadPages,type RerunSource} from './reader/recovery';
import {AdminPanel} from './admin/AdminPanel';
import {finishOidc,startOidc,isOidcCallback,type AuthConfig} from './auth/oidc';
type View='library'|'history'|'usage'|'settings'|'account'|'admin';
type Intent={mode:Mode;pages:Page[];regenerate?:boolean};
type ReadyPreview={preview:TranslationPreview;intent:Intent;key:string;copyId:string;ownerId:string;apiOrigin:string;targetLanguage:string;rerun?:RerunSource};
export function App(){
const [copies,setCopies]=useState<ReadingCopy[]>([]);const copiesRef=useRef(copies);copiesRef.current=copies;
const [library,setLibrary]=useState(emptyLibrary);const [catalog,setCatalog]=useState<SourceCatalog>();
const [importError,setImportError]=useState('');const [localImport]=useState(()=>new LocalImportQueue());const [importExpanded,setImportExpanded]=useState(false);
useEffect(()=>{localImport.activate();return()=>localImport.dispose();},[localImport]);
async function reloadLibrary(){const [state,values]=await Promise.all([store.readLibrary(),store.readCopies()]);setLibrary(state);copiesRef.current=values;setCopies(values);setCacheBytes(await store.cacheSize());}
useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>void reloadLibrary().catch(e=>setError(e.message)),60);};window.addEventListener('nc-library-change',changed);const channel=new BroadcastChannel('nc-library');channel.onmessage=changed;const broadcast=()=>channel.postMessage('change');window.addEventListener('nc-library-change',broadcast);return()=>{clearTimeout(timer);channel.close();window.removeEventListener('nc-library-change',changed);window.removeEventListener('nc-library-change',broadcast);};},[]);
async function openCopy(copyId:string,edition?:TranslationEdition,pageId?:string){setNavigationKey(n=>n+1);autoState.current.enabled=false;autoQueue.current.reset();setReadingEdition(edition);setExistingOnly(!!edition);if(edition)setSettings(s=>({...s,translationMode:edition.mode,language:edition.language}));const destination=copiesRef.current.find(c=>c.id===copyId);if(destination&&pageId&&destination.pages.some(p=>p.id===pageId)){store.savePosition(copyId,destination.manifestRevision,{pageId,relativeOffset:0});}setCurrentId(copyId);const copy=copiesRef.current.find(c=>c.id===copyId);if(copy?.sourceEntryId&&(!copy.discoveryComplete||copy.pages.some(p=>!p.blobKey)))try{await queueCopies([copyId],false);}catch(e){setError('原图采集未启动：'+(e as Error).message);}}
const sourceLock=useRef(false);
async function openSource(url:string,propagateError=false){if(sourceLock.current)return;sourceLock.current=true;setBusy('正在发现来源目录…');setError('');try{setCatalog(await discoverCatalog(url));setCurrentId(undefined);setView('library');}catch(e){setError((e as Error).message);if(propagateError)throw e;}finally{sourceLock.current=false;setBusy('');}}
function chooseFiles(files:File[]){if(input.current)input.current.value='';if(!files.length)return;setImportExpanded(true);void localImport.add(files).then(added=>{if(!added)notify('请在当前检查或导入结束后添加文件；当前清单已保留。');});}
const [readingEdition,setReadingEdition]=useState<TranslationEdition>();const [existingOnly,setExistingOnly]=useState(false);const [navigationKey,setNavigationKey]=useState(0);
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
const prepareLock=useRef(false);const submitLock=useRef(false);
const [caps,setCaps]=useState<Capabilities>();const [usage,setUsage]=useState<Entitlements>();
const [busy,setBusy]=useState('');const [toast,setToast]=useState<{message:string;id:number}>();const [error,setErrorMessage]=useState('');const [drag,setDrag]=useState(false);
const setError=useCallback((message:string)=>setErrorMessage(message),[]);
const [loginOpen,setLoginOpen]=useState(false);const [username,setUsername]=useState('reader');const [authAllowed,setAuthAllowed]=useState(false);const [pendingIntent,setPendingIntent]=useState<Intent>();
const [authConfig,setAuthConfig]=useState<AuthConfig>();
const [ready,setReady]=useState<ReadyPreview>();const [confirmAction,setConfirmAction]=useState<{title:string;body:string;action:()=>Promise<void>}>();
const pendingKey=account?`nc-library-submission-v2:${apiOrigin}:${account.user.id}`:'';
const [cacheBytes,setCacheBytes]=useState(0);const [autoConsents,setAutoConsents]=useState(readAutoConsents);const autoQueue=useRef(new AutomaticTranslationQueue());const [preparingPages,setPreparingPages]=useState<string[]>([]);const currentRef=useRef(currentId);currentRef.current=currentId;
const autoScope=automaticScope(currentId,account?.user.id,apiOrigin,settings.language,settings.translationMode);
const consentScope=autoConsentScope(account?.user.id,apiOrigin,settings.language,settings.translationMode);
const autoApproval=!existingOnly&&!!account&&!!autoConsents[consentScope];
const autoScopeRef=useRef(autoScope);autoScopeRef.current=autoScope;
const [autoPause,setAutoPause]=useState<{scope:string;message:string;retryAt?:number;rightsChanged?:boolean;quotaExhausted?:boolean;mode?:Mode;consentVersion?:string}>();
const pause=autoPause?.scope===consentScope?autoPause:undefined;
const autoState=useRef({enabled:false,copyId:currentId});autoState.current={enabled:autoApproval&&!!currentId&&!pause,copyId:currentId};
useEffect(()=>{autoQueue.current.reset();},[autoScope]);
function updateAutoConsent(value:AutoConsents){saveAutoConsents(value);setAutoConsents(value);}
function stopAutomatic(){autoState.current.enabled=false;autoQueue.current.reset();const next={...autoConsents};delete next[consentScope];updateAutoConsent(next);setAutoPause(undefined);}
function pauseAutomatic(message:string,retryAt?:number,rightsChanged=false,quotaExhausted=false){if(autoScopeRef.current!==autoScope)return;autoState.current.enabled=false;setAutoPause({scope:consentScope,message,retryAt,rightsChanged,quotaExhausted,mode:settings.translationMode,consentVersion:autoConsents[consentScope]?.version});}
const input=useRef<HTMLInputElement>(null);const [sourceManifest,setSourceManifest]=useState<PageManifest>();
const noticeId=useRef(0);
const notify=useCallback((message:string)=>setToast({message,id:++noticeId.current}),[]);
async function saveApiAddress(apiDraft:string){
  try{
    const url=new URL(apiDraft);const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash)throw Error('服务地址须为 HTTPS，或本机 HTTP 地址，不可包含凭据与查询参数。');
    if(typeof chrome!=='undefined'&&chrome.permissions){const granted=await chrome.permissions.request({origins:[url.origin+'/*']});if(!granted)throw Error('尚未取得新服务域名的访问权限。');}
    const base=url.href.replace(/\/+$/,'');
    if(base!==api.base){store.saveSession(null);setAccount(null);setUsage(undefined);setCaps(undefined);setReady(undefined);setPendingIntent(undefined);autoState.current.enabled=false;autoQueue.current.reset();api.isCurrent=()=>false;}
    setSettings(s=>({...s,apiBase:base}));notify('服务地址已保存；切换服务后需重新登录');
  }catch(e){setError((e as Error).message);}
}
const importLock=useRef(false);
useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(undefined),6000);return()=>clearTimeout(timer);}},[toast]);
useEffect(()=>{reloadLibrary().catch(e=>setError(`本地书架无法读取：${e.message}`));store.cacheSize().then(setCacheBytes);},[]);
useEffect(()=>{if(!isOidcCallback())return;void finishOidc().then(value=>{if(value){if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请回到原服务或重新登录。');store.saveSession(value);setAccount(value);const copyId=sessionStorage.getItem('nc-login-copy');if(copyId)setCurrentId(copyId);sessionStorage.removeItem('nc-login-copy');notify('登录成功，已返回原来的阅读位置');}}).catch(e=>setError((e as Error).message));},[]);
useEffect(()=>{store.saveSettings(settings);},[settings]);
useEffect(()=>{setReady(undefined);if(!pendingKey)return;try{const raw=localStorage.getItem(pendingKey);if(raw){const pending=JSON.parse(raw) as ReadyPreview;if(pending.ownerId===account?.user.id&&pending.apiOrigin===apiOrigin){if(!autoApproval){setReady(pending);notify('上次提交尚未核实，请使用同一确认按钮找回任务。');}}}}catch{setError('未能读取上次提交记录，请先查看服务端任务记录再新建。');}},[pendingKey]);
useEffect(()=>{let live=true;Promise.allSettled([api.capabilities(),api.authConfig(),...(account?[api.entitlements()]:[])]).then(results=>{if(!live)return;const c=results[0];if(c.status==='fulfilled'){setCaps(c.value as Capabilities);}const a=results[1];if(a.status==='fulfilled'){setAuthAllowed(Boolean((a.value as AuthConfig).dev_auth));setAuthConfig(a.value as AuthConfig);}if(results[2]?.status==='fulfilled')setUsage(results[2].value as Entitlements);});return()=>{live=false};},[api,account]);
const updateCopy=useCallback((copy:ReadingCopy)=>{const previous=copiesRef.current;const next=previous.some(c=>c.id===copy.id)?previous.map(c=>c.id===copy.id?copy:c):[copy,...previous];copiesRef.current=next;setCopies(next);void store.saveCopy(copy).catch(e=>setError(`本地记录未保存：${e.message}`));},[]);
const patchPage=useCallback((copyId:string,pageId:string,patch:(page:Page)=>Page)=>{const copy=copiesRef.current.find(c=>c.id===copyId);if(copy?.pages.some(p=>p.id===pageId))updateCopy({...copy,pages:copy.pages.map(p=>p.id===pageId?patch(p):p)});},[updateCopy]);
const refreshUsage=useCallback(()=>{if(accountRef.current)void api.entitlements().then(value=>{
  if(!api.isCurrent())return;
  setUsage(value);
  // Only a fresh server response can resume quota exhaustion; stale UI values
  // must not turn a concurrent quota rejection into a rapid retry loop.
  setAutoPause(current=>{
    if(!current?.quotaExhausted||!current.mode)return current;
    const benefit=value.modes[current.mode];
    if(!benefit.allowed||!benefit.unlimited&&(benefit.quota?.available??0)<=0)return current;
    return benefit.consent_version===current.consentVersion?undefined:{scope:current.scope,message:'账户权益已变化，请确认后继续自动翻译',rightsChanged:true};
  });
}).catch(()=>{});},[api]);
useEffect(()=>{
  if(!account)return;
  const refresh=()=>{if(document.visibilityState==='visible')refreshUsage();};
  const timer=setInterval(refresh,30000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
},[account,refreshUsage]);

useEffect(()=>{
  if(!account)return;
  let stopped=false;let timer:ReturnType<typeof setTimeout>;let cursor=0;
  const live=()=>!stopped&&api.isCurrent();
  async function poll(){
    const candidates=copiesRef.current.flatMap(c=>c.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin).flatMap(p=>p.jobs.filter(j=>pendingStatuses.has(j.status)||j.status==='succeeded'&&!!j.output_asset_id&&!p.outputBlobs[j.id]&&latestResults(p.jobs).some(n=>n.id===j.id))));
    const allIds=[...new Set(candidates.map(j=>j.id))];
    const ids=allIds.length?Array.from({length:Math.min(80,allIds.length)},(_,i)=>allIds[(cursor+i)%allIds.length]):[];
    cursor=(cursor+ids.length)%Math.max(1,allIds.length);
    try{
      if(ids.length){
        const {items}=await api.status(ids);if(!live())return;
        for(const copy of copiesRef.current){
          if(!copy.pages.some(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin&&p.jobs.some(j=>items.some(n=>n.id===j.id))))continue;
          updateCopy({...copy,pages:copy.pages.map(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:mergeJobs(p.jobs,items.filter(j=>p.jobs.some(old=>old.id===j.id)))}:p)});
        }
        const downloads=[...new Map(copiesRef.current.flatMap(c=>c.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin).flatMap(p=>latestResults(p.jobs).filter(j=>ids.includes(j.id)&&j.output_asset_id&&!p.outputBlobs[j.id]))).map(j=>[j.id,j])).values()];
        await mapConcurrent(downloads,settings.requestConcurrency,async job=>{
          assertCurrent(live);
          try{
            const key=`result:${apiOrigin}:${account!.user.id}:${job.id}`;
            const blob=await store.getBlob(key)??await api.image(job.output_asset_id!);assertCurrent(live);
            await store.putBlob(key,blob);assertCurrent(live);
            for(const copy of copiesRef.current){
              const relevant=copy.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin&&p.jobs.some(j=>j.id===job.id&&j.output_asset_id===job.output_asset_id));
              for(const page of relevant)patchPage(copy.id,page.id,p=>({...p,outputBlobs:{...p.outputBlobs,[job.id]:key},translationError:undefined}));
            }
          }catch(e){if(!live())return;for(const copy of copiesRef.current)for(const page of copy.pages)if(page.ownerId===account!.user.id&&page.apiOrigin===apiOrigin&&page.jobs.some(j=>j.id===job.id))patchPage(copy.id,page.id,p=>({...p,translationError:(e as Error).message}));}
        });
        if(live())refreshUsage();
      }
    }catch{/* Persistent job IDs survive temporary network errors. */}
    if(live())timer=setTimeout(poll,document.hidden?12000:4000);
  }
  void poll();return()=>{stopped=true;clearTimeout(timer);};
},[api,account,apiOrigin,settings.requestConcurrency,updateCopy,patchPage,refreshUsage]);

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
    setRecoveryStatus(errors.size?`${errors.size} 页匹配失败，可重试；已找回 ${restored} 页翻译`:`已找回 ${restored} 页翻译${restored?'，译图将自动下载':''}${missing?`；${missing} 页缺少标识，请重新导入`:''}`);
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
async function prepareTranslation(intent:Intent,automatic=false,windowCurrent=()=>true):Promise<PreparationResult>{
  if(!currentRef.current||prepareLock.current||submitLock.current)return false;
  if(automatic&&(ready||!caps))return false;
  if(pendingKey){const raw=localStorage.getItem(pendingKey);if(raw){if(!automatic)setReady(JSON.parse(raw));return false;}}
  const acc=accountRef.current;if(!acc){setPendingIntent(intent);setLoginOpen(true);return false;}
  if(!caps?.modes.find(m=>m.id===intent.mode)?.enabled){const message=`${modeLabels[intent.mode]}暂未配置就绪，请选择其他方式或稍后再试。`;if(automatic)pauseAutomatic(message);else setError(message);return false;}
  if(intent.pages.length>caps.limits.max_batch){setError(`单次翻译最多选择 ${caps.limits.max_batch} 页，请在页面列表调整范围。`);return false;}
  const copyId=currentRef.current;const language=settings.language;
  const live=()=>api.isCurrent()&&currentRef.current===copyId&&(!automatic||autoState.current.enabled&&autoScopeRef.current===autoScope&&windowCurrent());
  prepareLock.current=true;
  if(!automatic){setBusy('正在匹配已有翻译并准备选中页…');setError('');}
  try{
    const requested=copiesRef.current.find(c=>c.id===copyId)?.pages.filter(p=>intent.pages.some(n=>n.id===p.id))??[];
    if(!requested.length)return true;
    setPreparingPages(requested.map(p=>p.id));
    const snapshots=new Map(copiesRef.current.find(c=>c.id===copyId)!.pages.map(page=>[page.id,page]));
    const {matches,errors}=await matchFilePages(api,requested,intent.mode,language);assertCurrent(live);
    const retryPages=new Set(requested.filter(p=>{const source=pageSource(p);return source&&retryablePreparation(errors.get(sourceKey(source)));}).map(p=>p.id));
    const latest=copiesRef.current.find(c=>c.id===copyId);if(!latest)return false;
    updateCopy({...latest,pages:latest.pages.map(p=>{const source=pageSource(p);const match=source&&matches.get(sourceKey(source));return match?applyMatch(p,match,acc.user.id,apiOrigin,snapshots.get(p.id)):p;})});
    const eligible=copiesRef.current.find(c=>c.id===copyId)?.pages.filter(p=>requested.some(n=>n.id===p.id))??[];
    const planned=planTranslation(eligible,{matches,errors},intent.mode,language,!!intent.regenerate);
    let selected=planned.selected;const failures=planned.failures.map(({page,message})=>`${page.name}：${message}`);
    for(const {page,message} of planned.failures)patchPage(copyId,page.id,p=>({...p,translationError:message}));
    const rights=await api.entitlements();assertCurrent(live);setUsage(rights);
    const benefit=rights.modes[intent.mode];
    if(selected.length&&!benefit.allowed){
      const message='AI 重绘需要 PLUS 或有效的重绘赠送额度，已有译图仍可查看。';
      if(automatic)pauseAutomatic(message,undefined,true);else setError(message);
      return false;
    }
    if(automatic&&selected.length){
      if(autoConsents[consentScope]?.version!==benefit.consent_version){pauseAutomatic('账户权益已变化，请确认后继续自动翻译',undefined,true);return false;}
      const queue=await api.queue();assertCurrent(live);
      const limit=Math.min(queue.available_slots,benefit.unlimited?Infinity:benefit.quota?.available??0);
      const deferred=selected.slice(limit);deferred.forEach(p=>retryPages.add(p.id));selected=selected.slice(0,limit);
      if(!selected.length){
        const exhausted=!benefit.unlimited&&(benefit.quota?.available??0)<=0;
        const reset=benefit.quota?.resets_at;
        pauseAutomatic(exhausted?`翻译额度已用完${reset?'，恢复时间 '+new Date(reset).toLocaleString():''}`:'待处理任务已满，等待任务完成',exhausted?(reset?Date.parse(reset):undefined):Date.now()+15000,false,exhausted);
        return {retry:[...retryPages]};
      }
    }
    const outcomes=await uploadPages(api,selected,acc.user.id,apiOrigin,settings.requestConcurrency,store.getBlob,page=>{
      patchPage(copyId,page.id,latestPage=>({...latestPage,assetId:page.assetId,assetExpiresAt:page.assetExpiresAt,ownerId:page.ownerId,apiOrigin:page.apiOrigin,jobs:mergeJobs(latestPage.jobs,page.jobs),translationError:undefined}));
    },live);assertCurrent(live);
    const uploaded:Page[]=[];
    outcomes.forEach((result,index)=>{if(result.status==='fulfilled')uploaded.push(result.value.page);else{if(retryablePreparation(result.reason))retryPages.add(selected[index].id);const message=(result.reason as Error).message;failures.push(`${selected[index].name}：${message}`);patchPage(copyId,selected[index].id,p=>({...p,translationError:message}));}});
    if(failures.length&&!automatic){setError(`${failures.length} 页未能准备，其余页面可继续。${failures.slice(0,3).join('；')}`);}
    // Identical source images and duplicate MOBI references may resolve to the same asset.
    const pages=[...new Map(uploaded.map(page=>[page.assetId!,page])).values()];
    if(!pages.length){if(automatic&&retryPages.size){pauseAutomatic('连接暂不可用，稍后自动重试',Date.now()+15000);return {retry:[...retryPages]};}if(!automatic&&!failures.length)notify('所选页面已有结果、无字记录或正在处理，无需重复创建任务');return true;}
    assertCurrent(live);
    const pending=localStorage.getItem(pendingKey);if(pending){if(!automatic)setReady(JSON.parse(pending));return false;}
    const rerun=intent.regenerate&&pages.length===1?rerunSource(pages[0],matches.get(sourceKey(pageSource(pages[0])!)),intent.mode,language):undefined;
    if(intent.regenerate&&!rerun)throw Error('旧版本的原图已失效，无法主动重建。请使用普通翻译重新准备此页。');
    const preview=await api.preview(rerun?[rerun.inputAssetId]:pages.map(p=>p.assetId!),intent.mode,language,!!intent.regenerate);assertCurrent(live);
    const prepared:ReadyPreview={preview,intent:{...intent,pages:uploaded},key:id(),copyId,ownerId:acc.user.id,apiOrigin,targetLanguage:language,rerun};
    if(automatic){
      if(preview.entitlement_version!==autoConsents[consentScope]?.version){pauseAutomatic('账户权益已变化，请确认后继续',undefined,true);return false;}
      if(!await submitPreview(prepared,true))return false;
      if(retryPages.size){pauseAutomatic('剩余页面将在额度和队列允许时继续',Date.now()+15000);return {retry:[...retryPages]};}
    }else if(intent.mode==='classic'&&!intent.regenerate&&intent.pages.length===1){await submitPreview(prepared);}else setReady(prepared);
    return true;
  }catch(e){if(api.isCurrent()&&!(e instanceof StaleOperation)){if(automatic){pauseAutomatic((e as Error).message,retryablePreparation(e)?(e instanceof ApiError&&e.resetsAt?Date.parse(e.resetsAt):Date.now()+15000):undefined,false,e instanceof ApiError&&["DAILY_QUOTA_EXHAUSTED","REDRAW_QUOTA_EXHAUSTED"].includes(e.code));}else setError((e as Error).message);}}
  finally{prepareLock.current=false;setPreparingPages([]);if(!automatic)setBusy('');}
  return false;
}
async function submitPreview(prepared:ReadyPreview=ready!,automatic=false){
  if(!prepared||!accountRef.current||submitLock.current||!api.isCurrent())return;
  if(prepared.ownerId!==accountRef.current.user.id||prepared.apiOrigin!==accountRef.current.apiOrigin){setError('账户或服务已切换，请回到原账户核实这次提交。');return;}
  if(automatic&&(!autoState.current.enabled||autoState.current.copyId!==prepared.copyId||autoScopeRef.current!==autoScope))return;
  if(!automatic)setBusy('正在确认额度并提交任务…');
  const storageKey=`nc-library-submission-v2:${prepared.apiOrigin}:${prepared.ownerId}`;
  submitLock.current=true;
  const clearPending=()=>{if(JSON.parse(localStorage.getItem(storageKey)??'null')?.key===prepared.key)localStorage.removeItem(storageKey);};
  try{
    const existing=localStorage.getItem(storageKey);if(existing&&JSON.parse(existing).key!==prepared.key)throw Error('另一项提交尚待核实，请先完成原提交。');
    // Persist before crossing the network boundary; an uncertain response reuses this exact key.
    localStorage.setItem(storageKey,JSON.stringify(prepared));
    let returned:Job[];
    if(prepared.intent.regenerate){
      if(!prepared.rerun)throw Error('新版本缺少已核实的原任务绑定，请重新准备。');
      returned=[await api.rerun(prepared.rerun.jobId,`${prepared.key}:${prepared.rerun.pageId}`,prepared.preview.id,prepared.preview.quota_pages,prepared.rerun.inputAssetId)];
    }else returned=(await api.batch(prepared.preview.id,prepared.preview.quota_pages,prepared.key)).jobs;
    if(!api.isCurrent())return;
    const bound=bindSubmission(copiesRef.current.find(c=>c.id===prepared.copyId),prepared.intent.pages,returned,prepared.ownerId,prepared.apiOrigin,prepared.rerun);
    if(bound.copy){updateCopy(bound.copy);await store.saveCopy(bound.copy);}
    if(bound.detachedJobIds.length)localStorage.setItem(`nc-detached:${prepared.apiOrigin}:${prepared.ownerId}:${prepared.key}`,JSON.stringify({jobs:bound.detachedJobIds,createdAt:Date.now()}));
    if(!api.isCurrent())return;
    clearPending();setError('');
    if(!automatic){setReady(undefined);notify(`已提交 ${returned.length} 页${modeLabels[prepared.intent.mode]} · 可以继续读原图`);}
    refreshUsage();
    if(!automatic&&autoApproval)setAutoPause(undefined);
    return true;
  }catch(e){if(!api.isCurrent())return;const rejected=submissionRejected(e);if(rejected){clearPending();setReady(undefined);}if(automatic){pauseAutomatic(rejected?(e as Error).message:'提交结果待核实，已保留原请求；请核实后继续',rejected&&retryablePreparation(e)?(e instanceof ApiError&&e.resetsAt?Date.parse(e.resetsAt):Date.now()+15000):undefined,false,e instanceof ApiError&&["DAILY_QUOTA_EXHAUSTED","REDRAW_QUOTA_EXHAUSTED"].includes(e.code));}else{setError((e as Error).message+(rejected?' 此请求未创建任务，请重新准备。':' 提交记录已保存，请使用同一确认按钮核实，避免重复新建。'));}return false;}
  finally{submitLock.current=false;if(!automatic)setBusy('');}
}
const autoTranslate=useCallback(async(pages:Page[],submit=true)=>{
  if(pause){if(pause.retryAt&&Date.now()>=pause.retryAt)setAutoPause(undefined);return;}
  if(!autoState.current.enabled||!account||!api.isCurrent())return;
  autoQueue.current.setWindow(pages);
  if(!submit)return;
  await autoQueue.current.drain(caps?.limits.max_batch??1,async(batch,current)=>{
    if(!autoState.current.enabled||!api.isCurrent())return false;
    return prepareTranslation({mode:settings.translationMode,pages:batch},true,current);
  });
},[autoApproval,autoScope,autoConsents,pause,ready,account,settings.language,settings.translationMode,settings.requestConcurrency,api,caps]);
async function askAuto(resume=false){
  if(autoApproval&&!resume){stopAutomatic();return;}
  if(!account){setLoginOpen(true);return;}
  if(resume&&pendingKey&&localStorage.getItem(pendingKey)){setReady(JSON.parse(localStorage.getItem(pendingKey)!));return;}

  let capabilities=caps;
  try{capabilities=await api.capabilities();if(!api.isCurrent()||autoScopeRef.current!==autoScope)return;setCaps(capabilities);}catch(e){setError((e as Error).message);return;}
  const selectedMode=capabilities?.modes.find(m=>m.id===settings.translationMode);
  if(!selectedMode?.enabled){setError('所选翻译方式尚未配置，暂时不能开启自动翻译。');return;}
  if(ready||pendingKey&&localStorage.getItem(pendingKey)){setError('请先完成或核实当前提交，再开启自动翻译。');return;}
  const benefit=capabilities!.entitlements?.modes[settings.translationMode];
  if(!benefit?.allowed){setError('需要 PLUS 或有效重绘赠送额度才能开启此模式。');return;}
  setUsage(capabilities!.entitlements!);
  setConfirmAction({title:resume?'确认自动翻译权益':'开启自动翻译',body:`${entitlementDescription(benefit,settings.translationMode)}。跟随阅读位置翻译当前页和后 ${settings.autoAhead} 页，持续使用账户可用额度；已有结果不重复提交。本机会记住此账户、服务、模式与语言的选择，刷新、换漫画或下次阅读时自动继续；离开阅读器时停止添加任务，手动关闭后保持关闭。`,action:async()=>{
    if(autoScopeRef.current!==autoScope)return;
    setExistingOnly(false);setReadingEdition(undefined);updateAutoConsent({...autoConsents,[consentScope]:{version:benefit.consent_version,quotaKind:benefit.quota_kind}});autoQueue.current.reset();setAutoPause(undefined);
  }});
}
function exitReader(){setReadingEdition(undefined);setExistingOnly(false);autoState.current.enabled=false;autoQueue.current.reset();setCurrentId(undefined);}
const rights=usage??caps?.entitlements;
const nav=(value:View)=>{exitReader();setView(value);location.hash=value;setError('');};
return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=current?'none':'copy';setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)chooseFiles(Array.from(e.dataTransfer.files));}}>
<input aria-label="选择漫画图片" type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>chooseFiles(Array.from(e.target.files??[]))}/>
{!current&&<header className="nc-app-header"><button className="nc-brand" aria-label="返回我的漫画" onClick={()=>nav('library')}><span>✦</span><b>Node Comics</b></button><nav aria-label="主导航">{([['library','我的漫画','book'],['history','翻译记录','clock'],['usage','用量统计','coin']] as const).map(([value,label,icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>nav(value)}><Icon name={icon} size={19}/>{label}</button>)}</nav><div className="nc-header-actions"><button className="icon-button" aria-label="外观与设置" onClick={()=>nav('settings')}><Icon name="settings"/></button><button className="nc-account-button" onClick={()=>account?nav('account'):setLoginOpen(true)}><span className="nc-avatar">{account?account.user.name[0].toUpperCase():<Icon name="user" size={18}/>}</span><span>{account?(rights?.plan==='plus'?'PLUS':'普通用户'):'登录'}</span></button></div></header>}
<div className="nc-workspace">
{error&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
{current?<Reader directory={directory} onCatalog={directory?.catalogUrl?()=>{exitReader();void openSource(directory.catalogUrl!);}:undefined} initialView={readingEdition?{mode:readingEdition.mode,preference:'translation'}:undefined} onMarkRead={store.markCopyRead} sequence={sequence} onActiveCopy={setCurrentId} onLoadCopy={id=>{const c=copiesRef.current.find(c=>c.id===id);const task=library.tasks.find(t=>t.copyId===id);if(c?.sourceEntryId&&(!c.discoveryComplete||c.pages.some(p=>!p.blobKey))&&task?.status!=='paused'&&task?.status!=='failed')void queueCopies([id],false).catch(e=>setError('原图采集未启动：'+e.message));}} sourceStatus={sourceTask?(sourceTask.error??(sourceTask.phase==='discover'?'正在发现图片清单':'正在获取原图'))+' · '+sourceTask.completed+' / '+(sourceTask.total??'未知'):undefined} onAcquire={()=>void grantImagePermissions([current.id],copiesRef.current).then(()=>notify('已提交采集，原图进度将在阅读页更新')).catch(e=>setError(e.message))} onPauseAcquire={()=>void pauseCopies([current.id]).then(()=>notify('已暂停原图采集，已保存的页面仍可阅读')).catch(e=>setError(e.message))} onNavigate={(id,pageId)=>void openCopy(id,readingEdition,pageId)} key={`${account?.user.id}:${apiOrigin}:${readingEdition?.mode??''}:${readingEdition?.language??''}:${navigationKey}`} api={api} busy={!!busy} preparingPages={preparingPages} copy={current} settings={settings} setSettings={setSettings} update={updateCopy} onBack={exitReader} onTranslate={(mode,pages,regenerate)=>void prepareTranslation({mode,pages,regenerate})} onImport={()=>input.current?.click()} notify={notify} autoEnabled={autoApproval} autoStatus={autoApproval?(pause?.message||(pendingKey&&localStorage.getItem(pendingKey)?'提交结果待核实，请核实后继续':'')):''} autoRetrying={!!pause?.retryAt} onAutoResume={()=>void askAuto(true)} onAutoToggle={()=>void askAuto()} onAutoWindow={autoTranslate} caps={caps?{...caps,entitlements:usage??caps.entitlements}:undefined} userId={account?.user.id} apiOrigin={apiOrigin} recoveryStatus={recoveryStatus} recovering={recovering} onRecover={(mode,pages)=>void recoverCopy(true,mode,pages)} recoveryEnabled={!!account} onCancel={async(job)=>{try{const result=await api.cancel(job.id);if(!api.isCurrent())return;const p=copiesRef.current.find(c=>c.id===current.id)?.pages.find(p=>p.jobs.some(j=>j.id===job.id));if(p)patchPage(current.id,p.id,page=>({...page,jobs:mergeJobs(page.jobs,[result])}));refreshUsage();}catch(e){setError((e as Error).message);}}}/>:
<main className="nc-main">{view==='admin'&&account?.user.role==='admin'&&<><AdminPanel api={api}/><FeedbackInbox api={api} admin/></>}
{view==='library'&&(catalog?<CatalogImport key={catalog.id+':'+catalog.observedAt} catalog={catalog} library={library} copies={copies} onClose={()=>{setCatalog(undefined);history.replaceState(null,'',location.pathname);}} onDone={()=>void reloadLibrary()} onNotice={notify} onRefresh={()=>openSource(catalog.url,true)}/>:<Library api={api} userId={account?.user.id} apiOrigin={apiOrigin} onOpenTranslation={(id,edition)=>void openCopy(id,edition)} library={library} copies={copies} settings={settings} setSettings={setSettings} onOpen={id=>void openCopy(id)} onImport={()=>input.current?.click()} onDemo={()=>void openDemo()} notify={notify} onChanged={()=>void reloadLibrary()} onSource={url=>void openSource(url)}/>)}

{view==='history'&&<TranslationHistory key={`${apiOrigin}:${account?.user.id??''}`} api={api} copies={copies} userId={account?.user.id} onLogin={()=>setLoginOpen(true)} onOpen={(copy,job,group)=>{const mode=job?.mode??group?.mode;const language=job?.target_language??group?.target_language;if(mode&&language)setSettings(s=>({...s,translationMode:mode,language}));const page=job?copy.pages.find(p=>p.jobs.some(j=>j.id===job.id)||p.assetId===(job.requested_asset_id??job.input_asset_id)):undefined;if(page){store.savePosition(copy.id,copy.manifestRevision,{pageId:page.id,relativeOffset:0});updateCopy({...copy,pageId:page.id,relativeOffset:0});}setCurrentId(copy.id);}} onDelete={(job,onDeleted)=>setConfirmAction({title:'删除服务器译图？',body:'删除后撤销服务器访问，已保存的本地副本仍可阅读。重新翻译需要新的翻译任务。',action:async()=>{await api.deleteImage(job.output_asset_id!);if(!api.isCurrent())return;for(const c of copiesRef.current)updateCopy({...c,pages:c.pages.map(p=>p.ownerId===account?.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:p.jobs.map(j=>j.output_asset_id===job.output_asset_id?{...j,output_asset_id:null,result_available:false,result_expired:true}:j)}:p)});notify('服务器译图已删除');onDeleted();}})}/>}
{view==='usage'&&<UsagePage key={`${apiOrigin}:${account?.user.id??''}`} api={api} onLogin={()=>setLoginOpen(true)}/>}
{view==='settings'&&<Preferences key={`${apiOrigin}:${account?.user.id??''}`} api={api} account={!!account} settings={settings} setSettings={setSettings} caps={caps} cacheBytes={cacheBytes} notify={notify} onSaveApiAddress={saveApiAddress} onClearCache={()=>setConfirmAction({title:'清理本地图片缓存？',body:'所有本地原图和译图将被删除，书架和进度保留。之后需重新导入原图，译图可在服务器保留期内重新获取。',action:async()=>{await store.clearImages(copiesRef.current);setCopies(await store.readCopies());setCacheBytes(0);notify('本地图片已清理，书架与进度已保留');}})}/>}
{view==='account'&&<><PageTitle eyebrow="A LITTLE MAGIC FOR EVERY PAGE" title="我的账户" description="查看会员权益、可用翻译页数与到期时间。成功交付后计量，失败释放预占。"/>{account?<><div className="account-summary"><span className="avatar large">{account.user.name[0].toUpperCase()}</span><div><h2>{account.user.name}</h2><p>{authAllowed?'本地测试账户':'已登录账户'} · {account.user.role==='admin'?'管理员':'读者'}</p></div><button className="button secondary small" onClick={()=>{api.isCurrent=()=>false;store.saveSession(null);setAccount(null);setUsage(undefined);setReady(undefined);autoState.current.enabled=false;autoQueue.current.reset();notify('已退出账户，原图仍可继续阅读');}}>退出登录</button></div><EntitlementCards data={rights??undefined}/><section className="settings-card"><div className="nc-section-heading"><div><h2>用量与反馈</h2><p className="nc-muted">查看实际消耗、逐笔记录和反馈处理进展。</p></div><button className="button primary" onClick={()=>nav('usage')}>查看用量统计</button>{account.user.role==='admin'&&<button className="button secondary" onClick={()=>nav('admin')}><Icon name="shield"/>运营管理</button>}</div></section><FeedbackInbox api={api}/></>:<div className="login-prompt"><span className="feature-icon pink"><Icon name="user" size={28}/></span><h2>准备好，一起漫游了吗？</h2><p>无需登录即可阅读原图。登录账户，开始翻译并查看额度。</p><button className="button primary" onClick={()=>setLoginOpen(true)}>登录账户 <Icon name="arrow" size={18}/></button></div>}<div className="privacy-note standalone"><Icon name="info"/><p>会员由管理员开通，支付订阅尚未接入。基础额度与赠送额度分别按各自期限生效。</p></div></>}
</main>}
</div>
{drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>把故事放在这里</h2><p>支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）</p></div>}
{busy&&<div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}{toast&&<div key={toast.id} className="toast" role="status" aria-live="polite" aria-atomic="true"><Icon name="check" size={18}/><span>{toast.message}</span><button className="icon-button" aria-label="关闭操作提示" onClick={()=>setToast(undefined)}><Icon name="close" size={16}/></button></div>}
{loginOpen&&<Modal title="连接你的漫游账户" subtitle="原图无需登录。翻译任务和额度将归属于这个账户。" onClose={()=>{setLoginOpen(false);setPendingIntent(undefined);}}>
  {authAllowed?<><div className="notice"><Icon name="info"/><span>本地测试登录已由后端开启，仅用于开发验证。</span></div><label className="field">测试用户名<input value={username} maxLength={60} onChange={e=>setUsername(e.target.value)} placeholder="例如 reader" autoFocus/></label></>:<div className="notice"><Icon name="shield"/><span>{authConfig?.mode==='oidc'?'将前往身份服务安全登录，完成后回到当前阅读位置。':'身份服务尚未配置，请联系运营方。'}</span></div>}
  <button className="button primary full" style={{marginTop:20}} disabled={!!busy||(authAllowed?!username.trim():authConfig?.mode!=='oidc'||!authConfig?.authorization_endpoint||!authConfig?.token_endpoint||!authConfig?.client_id)} onClick={()=>void authenticate()}>{authAllowed?'连接测试账户':'继续登录'} <Icon name="arrow" size={18}/></button>
</Modal>}
{ready&&<Modal title={ready.intent.regenerate?'重新翻译这一页':`开始${modeLabels[ready.intent.mode]}`} subtitle="确认翻译范围与页数后开始，翻译过程中可以继续阅读。" onClose={()=>{if(!busy)setReady(undefined);}}><div className="preview-summary"><span>本次选中<b>{ready.preview.page_count} <small>页</small></b></span><span>预计预占<b>{ready.preview.quota_pages} <small>页</small></b></span><span>目标语言<b className="language-value">{caps?.languages.find(l=>l.id===ready.targetLanguage)?.label??ready.targetLanguage}</b></span></div><p className="modal-copy">{ready.preview.reused_pages>0?`复用 ${ready.preview.reused_pages} 页，不重复计量。`:""}{ready.preview.quota_kind==="classic_unlimited"?"PLUS 常规翻译不消耗重绘额度。":""}逐页交付、逐页结算；原图与已有译图一直保留。{ready.intent.mode==='classic'?'常规翻译只处理文字区域，请检查识别和排版效果。':'图片重绘可能改变画面细节，请在完成后对照检查。'}</p>{ready.intent.regenerate&&<p className="notice warning">将生成新的翻译结果。完成后替换当前模式的显示效果，原图仍可随时查看。</p>}<div className="preview-expiry">预览有效至 {new Date(ready.preview.expires_at).toLocaleTimeString()} · 确认后可继续阅读</div><button className="button primary full" disabled={!!busy} onClick={()=>void submitPreview()}><Icon name="spark" size={18}/>确认并开始 · {ready.preview.quota_kind==='classic_unlimited'?'PLUS 常规不限量':`最多 ${ready.preview.quota_pages} 页额度`}</button></Modal>}
<LocalImport queue={localImport} expanded={importExpanded} onExpand={()=>setImportExpanded(true)} onCollapse={()=>setImportExpanded(false)} onAdd={()=>input.current?.click()} onOpen={id=>{void reloadLibrary().then(()=>openCopy(id)).catch(e=>setError(e.message));}} library={library} limitMb={settings.cacheLimitMb}/>
{sourceManifest&&<SourceImport key={sourceManifest.id} manifest={sourceManifest} library={library} copies={copies} busy={!!busy} error={importError} onClose={()=>{setSourceManifest(undefined);setImportError('');}} onImport={acquireManifest}/>}
{confirmAction&&<Modal title={confirmAction.title} subtitle={confirmAction.body} onClose={()=>setConfirmAction(undefined)}><button className="button primary full" onClick={async()=>{const action=confirmAction;setConfirmAction(undefined);try{await action.action();}catch(e){setError((e as Error).message);}}}>确认</button></Modal>}
</div>;
}
