import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Icon} from './icons';
import {Modal,PageTitle,Stat} from './ui/components';
import {mergeJobs,pendingStatuses} from './reader/jobs';
import {Api,submissionRejected} from './api';
import {modeLabels,type Capabilities,type Chapter,type Job,type Mode,type Page,type Quote,type Settings,type Usage} from './types';
import * as store from './reader/store';
import {automaticScope,emptyPage,id,makeChapter,naturalSort,restoreImported} from './reader/model';
import {AutomaticTranslationQueue,type PreparationResult} from './reader/automatic';
import {autoConsentScope,readAutoConsents,saveAutoConsents,retryablePreparation,type AutoConsents} from './reader/auto-consent';
import {Reader} from './reader/Reader';
import {Preferences} from './ui/Preferences';
import {Library} from './ui/Library';
import {TranslationHistory} from './ui/History';
import {UsagePage} from './ui/Usage';
import {FeedbackInbox} from './ui/Feedback';
import {useAppearance} from './ui/Appearance';
import {latestResults} from './reader/presentation';
import type {ChapterManifest} from './sources/adapters';
import {openComic,prepareComicPage,isComicFile,importedFileHash,COMIC_ACCEPT} from './importers/comic';
import {imageIdentity} from './importers/hash';
import {assertCurrent,mapConcurrent,RequestPool,StaleOperation} from './concurrency';
import {applyMatch,bindSubmission,matchFilePages,pageSource,planTranslation,reusableJob,rerunSource,sourceKey,uploadPages,type RerunSource} from './reader/recovery';
import {AdminPanel} from './admin/AdminPanel';
import {finishOidc,startOidc,isOidcCallback,type AuthConfig} from './auth/oidc';
type View='library'|'history'|'usage'|'settings'|'account'|'admin';
type Intent={mode:Mode;pages:Page[];regenerate?:boolean};
type ReadyQuote={quote:Quote;intent:Intent;key:string;chapterId:string;ownerId:string;apiOrigin:string;targetLanguage:string;rerun?:RerunSource};
export function App(){
const [chapters,setChapters]=useState<Chapter[]>([]);const chaptersRef=useRef(chapters);chaptersRef.current=chapters;
const [currentId,setCurrentId]=useState<string>();const current=chapters.find(c=>c.id===currentId);
const [view,setView]=useState<View>((location.hash.slice(1) as View)||'library');
const [settings,setSettings]=useState<Settings>(store.settings);const [account,setAccount]=useState(store.session);const accountRef=useRef(account);accountRef.current=account;
useAppearance(settings);
const apiOrigin=useMemo(()=>{try{return new URL(settings.apiBase).origin;}catch{return '';}},[settings.apiBase]);
const requestPool=useRef(new RequestPool(settings.requestConcurrency));
useEffect(()=>{requestPool.current.setLimit(settings.requestConcurrency);},[settings.requestConcurrency]);
const api=useMemo(()=>new Api(settings.apiBase,account?.apiOrigin===apiOrigin?account.token:'',requestPool.current),[settings.apiBase,account,apiOrigin]);
const apiRef=useRef(api);apiRef.current=api;api.isCurrent=()=>apiRef.current===api;
const [recoveryStatus,setRecoveryStatus]=useState('');const [recovering,setRecovering]=useState(false);const recoveryRun=useRef(0);
const prepareLock=useRef(false);const submitLock=useRef(false);
const [caps,setCaps]=useState<Capabilities>();const [usage,setUsage]=useState<Usage>();
const [busy,setBusy]=useState('');const [toast,setToast]=useState('');const [error,setErrorMessage]=useState('');const [drag,setDrag]=useState(false);
const errorTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
const setError=useCallback((message:string)=>{
  clearTimeout(errorTimer.current);
  setErrorMessage(message);
  if(message)errorTimer.current=setTimeout(()=>setErrorMessage(''),5000);
},[]);
useEffect(()=>()=>clearTimeout(errorTimer.current),[]);
const [loginOpen,setLoginOpen]=useState(false);const [username,setUsername]=useState('reader');const [authAllowed,setAuthAllowed]=useState(false);const [pendingIntent,setPendingIntent]=useState<Intent>();
const [authConfig,setAuthConfig]=useState<AuthConfig>();
const [ready,setReady]=useState<ReadyQuote>();const [confirmAction,setConfirmAction]=useState<{title:string;body:string;action:()=>Promise<void>}>();
const pendingKey=account?`nc-submission:${apiOrigin}:${account.user.id}`:'';
const [cacheBytes,setCacheBytes]=useState(0);const [autoConsents,setAutoConsents]=useState(readAutoConsents);const autoQueue=useRef(new AutomaticTranslationQueue());const [preparingPages,setPreparingPages]=useState<string[]>([]);const currentRef=useRef(currentId);currentRef.current=currentId;
const autoScope=automaticScope(currentId,account?.user.id,apiOrigin,settings.language,settings.translationMode);
const consentScope=autoConsentScope(account?.user.id,apiOrigin,settings.language,settings.translationMode);
const autoApproval=!!account&&!!autoConsents[consentScope];
const autoScopeRef=useRef(autoScope);autoScopeRef.current=autoScope;
const [autoPause,setAutoPause]=useState<{scope:string;message:string;retryAt?:number;priceChanged?:boolean}>();
const pause=autoPause?.scope===consentScope?autoPause:undefined;
const autoState=useRef({enabled:false,chapterId:currentId});autoState.current={enabled:autoApproval&&!!currentId&&!pause,chapterId:currentId};
useEffect(()=>{autoQueue.current.reset();},[autoScope]);
function updateAutoConsent(value:AutoConsents){saveAutoConsents(value);setAutoConsents(value);}
function stopAutomatic(){autoState.current.enabled=false;autoQueue.current.reset();const next={...autoConsents};delete next[consentScope];updateAutoConsent(next);setAutoPause(undefined);}
function pauseAutomatic(message:string,retryAt?:number,priceChanged=false){if(autoScopeRef.current!==autoScope)return;autoState.current.enabled=false;setAutoPause({scope:consentScope,message,retryAt,priceChanged});}
const input=useRef<HTMLInputElement>(null);const [sourceManifest,setSourceManifest]=useState<ChapterManifest>();
const notify=useCallback((message:string)=>setToast(message),[]);
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
async function importComicFile(file:File){
  setBusy('正在解析漫画文件…');setError('');
  const savedKeys:string[]=[];let imported:Awaited<ReturnType<typeof openComic>>|undefined;let committed=false;
  try{
    imported=await openComic(file,(done,total)=>setBusy(`正在计算文件标识 ${Math.round(done/total*100)}%…`));
    const pages:Page[]=[];
    for await(const item of imported.pages){
      setBusy(`正在保存漫画页 ${pages.length+1} / ${imported.total}…`);
      const {blob,width,height,imageSha256}=await prepareComicPage(item);
      const page=emptyPage(item.name.replace(/\.gif$/i,'.png'),width,height);page.blobKey=`original:${page.id}`;page.fileHash=importedFileHash(imported,imageSha256);page.pageIndex=item.pageIndex;page.imageSha256=imageSha256;
      await store.putBlob(page.blobKey,blob);savedKeys.push(page.blobKey);pages.push(page);
    }
    pages.sort((a,b)=>a.pageIndex!-b.pageIndex!);
    const chapter=restoreImported(chaptersRef.current,makeChapter(imported.title,pages,`${imported.format} 本地导入`));
    await store.saveChapter(chapter);committed=true;updateChapter(chapter);setCurrentId(chapter.id);setView('library');
    const retained=new Set(chapter.pages.map(p=>p.blobKey));
    for(const key of savedKeys)if(!retained.has(key))await store.removeBlob(key);
    notify(`已导入 ${pages.length} 页 · ${imported.warnings[0]??'原图保存在本机，滚动时按需解码'}`);
    await store.enforceCacheBudget(chaptersRef.current,settings.cacheLimitMb,chapter.id);setCacheBytes(await store.cacheSize());
  }catch(e){setError(`导入未完成：${(e as Error).message}`);}
  finally{
    await imported?.close();
    if(!committed)for(const key of savedKeys)await store.removeBlob(key).catch(()=>{});
    setBusy('');if(input.current)input.current.value='';
  }
}
useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(timer);}},[toast]);
useEffect(()=>{store.readChapters().then(setChapters).catch(e=>setError(`本地书架无法读取：${e.message}`));store.cacheSize().then(setCacheBytes);},[]);
useEffect(()=>{if(!isOidcCallback())return;void finishOidc().then(value=>{if(value){if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请回到原服务或重新登录。');store.saveSession(value);setAccount(value);const chapterId=sessionStorage.getItem('nc-login-chapter');if(chapterId)setCurrentId(chapterId);sessionStorage.removeItem('nc-login-chapter');notify('登录成功，已返回原来的阅读位置');}}).catch(e=>setError((e as Error).message));},[]);
useEffect(()=>{store.saveSettings(settings);},[settings]);
useEffect(()=>{setReady(undefined);if(!pendingKey)return;try{const raw=localStorage.getItem(pendingKey);if(raw){const pending=JSON.parse(raw) as ReadyQuote;if(pending.ownerId===account?.user.id&&pending.apiOrigin===apiOrigin){if(!autoApproval){setReady(pending);notify('上次提交尚未核实，请使用同一确认按钮找回任务。');}}}}catch{setError('未能读取上次提交记录，请先查看服务端任务记录再新建。');}},[pendingKey]);
useEffect(()=>{let live=true;Promise.allSettled([api.capabilities(),api.authConfig(),...(account?[api.usage()]:[])]).then(results=>{if(!live)return;const c=results[0];if(c.status==='fulfilled'){setCaps(c.value as Capabilities);}const a=results[1];if(a.status==='fulfilled'){setAuthAllowed(Boolean((a.value as AuthConfig).dev_auth));setAuthConfig(a.value as AuthConfig);}if(results[2]?.status==='fulfilled')setUsage(results[2].value as Usage);});return()=>{live=false};},[api,account]);
const updateChapter=useCallback((chapter:Chapter)=>{const previous=chaptersRef.current;const next=previous.some(c=>c.id===chapter.id)?previous.map(c=>c.id===chapter.id?chapter:c):[chapter,...previous];chaptersRef.current=next;setChapters(next);void store.saveChapter(chapter).catch(e=>setError(`本地记录未保存：${e.message}`));},[]);
const patchPage=useCallback((chapterId:string,pageId:string,patch:(page:Page)=>Page)=>{const chapter=chaptersRef.current.find(c=>c.id===chapterId);if(chapter?.pages.some(p=>p.id===pageId))updateChapter({...chapter,pages:chapter.pages.map(p=>p.id===pageId?patch(p):p)});},[updateChapter]);
const refreshUsage=useCallback(()=>{if(accountRef.current)void api.usage().then(value=>{if(api.isCurrent())setUsage(value);}).catch(()=>{});},[api]);
useEffect(()=>{
  if(!account)return;
  let stopped=false;let timer:ReturnType<typeof setTimeout>;let cursor=0;
  const live=()=>!stopped&&api.isCurrent();
  async function poll(){
    const candidates=chaptersRef.current.flatMap(c=>c.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin).flatMap(p=>p.jobs.filter(j=>pendingStatuses.has(j.status)||j.status==='succeeded'&&!!j.output_asset_id&&!p.outputBlobs[j.id]&&latestResults(p.jobs).some(n=>n.id===j.id))));
    const allIds=[...new Set(candidates.map(j=>j.id))];
    const ids=allIds.length?Array.from({length:Math.min(80,allIds.length)},(_,i)=>allIds[(cursor+i)%allIds.length]):[];
    cursor=(cursor+ids.length)%Math.max(1,allIds.length);
    try{
      if(ids.length){
        const {items}=await api.status(ids);if(!live())return;
        for(const chapter of chaptersRef.current){
          if(!chapter.pages.some(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin&&p.jobs.some(j=>items.some(n=>n.id===j.id))))continue;
          updateChapter({...chapter,pages:chapter.pages.map(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:mergeJobs(p.jobs,items.filter(j=>p.jobs.some(old=>old.id===j.id)))}:p)});
        }
        const downloads=[...new Map(chaptersRef.current.flatMap(c=>c.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin).flatMap(p=>latestResults(p.jobs).filter(j=>ids.includes(j.id)&&j.output_asset_id&&!p.outputBlobs[j.id]))).map(j=>[j.id,j])).values()];
        await mapConcurrent(downloads,settings.requestConcurrency,async job=>{
          assertCurrent(live);
          try{
            const key=`result:${apiOrigin}:${account!.user.id}:${job.id}`;
            const blob=await store.getBlob(key)??await api.image(job.output_asset_id!);assertCurrent(live);
            await store.putBlob(key,blob);assertCurrent(live);
            for(const chapter of chaptersRef.current){
              const relevant=chapter.pages.filter(p=>p.ownerId===account!.user.id&&p.apiOrigin===apiOrigin&&p.jobs.some(j=>j.id===job.id&&j.output_asset_id===job.output_asset_id));
              for(const page of relevant)patchPage(chapter.id,page.id,p=>({...p,outputBlobs:{...p.outputBlobs,[job.id]:key},translationError:undefined}));
            }
          }catch(e){if(!live())return;for(const chapter of chaptersRef.current)for(const page of chapter.pages)if(page.ownerId===account!.user.id&&page.apiOrigin===apiOrigin&&page.jobs.some(j=>j.id===job.id))patchPage(chapter.id,page.id,p=>({...p,translationError:(e as Error).message}));}
        });
        if(live())refreshUsage();
      }
    }catch{/* Persistent job IDs survive temporary network errors. */}
    if(live())timer=setTimeout(poll,document.hidden?12000:4000);
  }
  void poll();return()=>{stopped=true;clearTimeout(timer);};
},[api,account,apiOrigin,settings.requestConcurrency,updateChapter,patchPage,refreshUsage]);

const recoveryModeEnabled=!!caps?.modes.find(m=>m.id===settings.translationMode)?.enabled;
const currentLoaded=!!current;
async function recoverChapter(manual=false,mode=settings.translationMode,requestedPages?:Page[]){
  const chapterId=currentRef.current;const acc=accountRef.current;
  if(!chapterId||!acc){if(manual&&!acc)setLoginOpen(true);return;}
  const chapter=chaptersRef.current.find(c=>c.id===chapterId);if(!chapter)return;
  const run=++recoveryRun.current;setRecovering(true);setRecoveryStatus('正在查找当前账户的翻译…');
  try{
    const {matches,errors}=await matchFilePages(api,requestedPages??chapter.pages,mode,settings.language);
    if(!api.isCurrent()||run!==recoveryRun.current||currentRef.current!==chapterId)return;
    const latest=chaptersRef.current.find(c=>c.id===chapterId);if(!latest)return;
    let restored=0;
    const pages=latest.pages.map(page=>{
      const source=pageSource(page);const match=source&&matches.get(sourceKey(source));
      if(!match)return page;
      if((match.display_jobs??match.jobs).some(j=>reusableJob(j,mode,settings.language)))restored++;
      return applyMatch(page,match,acc.user.id,apiOrigin,chapter.pages.find(p=>p.id===page.id));
    });
    updateChapter({...latest,pages});
    const missing=pages.filter(p=>!pageSource(p)).length;
    setRecoveryStatus(errors.size?`${errors.size} 页匹配失败，可重试；已找回 ${restored} 页翻译`:`已找回 ${restored} 页翻译${restored?'，译图将自动下载':''}${missing?`；${missing} 页缺少标识，请重新导入`:''}`);
  }catch(e){if(api.isCurrent()&&run===recoveryRun.current)setRecoveryStatus(`恢复未完成：${(e as Error).message}`);}
  finally{if(api.isCurrent()&&run===recoveryRun.current)setRecovering(false);}
}
useEffect(()=>{
  ++recoveryRun.current;setRecovering(false);setRecoveryStatus('');
  if(account&&currentLoaded)void recoverChapter();
  return()=>{++recoveryRun.current;};
},[api,currentId,currentLoaded,settings.translationMode,settings.language,recoveryModeEnabled]);

useEffect(()=>{const manifestId=new URLSearchParams(location.search).get('manifest');if(!manifestId||typeof chrome==='undefined'||!chrome.storage?.local)return;chrome.storage.local.get([`manifest:${manifestId}`,'pendingLanguage']).then(data=>{if(data.pendingLanguage)setSettings(s=>({...s,language:String(data.pendingLanguage)}));const m=data[`manifest:${manifestId}`] as ChapterManifest;if(m)setSourceManifest(m);});},[]);
async function importFiles(files:File[]){
  if(importLock.current)return;
  importLock.current=true;
  try{await importSelectedFiles(files);}finally{importLock.current=false;}
}
async function importSelectedFiles(files:File[]){
  const comic=files.find(f=>isComicFile(f.name));
  if(comic){if(files.length>1){setError('漫画文件请一次导入一本，以保留独立章节与阅读位置。');return;}await importComicFile(comic);return;}
  const accepted=naturalSort(files.filter(f=>['image/png','image/jpeg','image/webp'].includes(f.type)));if(!accepted.length){setError('请选择 PNG、JPEG、WebP 图片或 MOBI、CBZ/ZIP、CBR/RAR、PDF 漫画。');return;}if(accepted.length>300){setError('一次最多导入 300 张图片，请拆分阅读清单。');return;}setBusy(`正在整理 ${accepted.length} 张图片…`);setError('');try{const pages:Page[]=[];for(const file of accepted){if(file.size>40*1024*1024)throw Error(`${file.name} 超过本地单图 40 MB 限制。`);const bitmap=await createImageBitmap(file);if(bitmap.width*bitmap.height>100_000_000){bitmap.close();throw Error(`${file.name} 像素过大，无法安全解码。`);}const p=emptyPage(file.name,bitmap.width,bitmap.height);bitmap.close();Object.assign(p,await imageIdentity(file));p.blobKey=`original:${p.id}`;await store.putBlob(p.blobKey,file);pages.push(p);}const chapter=restoreImported(chaptersRef.current,makeChapter(accepted[0].name.replace(/\.[^.]+$/,'')+(pages.length>1?` · ${pages.length} 页`:''),pages));updateChapter(chapter);setCurrentId(chapter.id);setView('library');notify(`已导入 ${pages.length} 页 · 原图保存在本地`);await store.enforceCacheBudget([...chaptersRef.current,chapter],settings.cacheLimitMb,chapter.id);setCacheBytes(await store.cacheSize());}catch(e){setError((e as Error).message);}finally{setBusy('');if(input.current)input.current.value='';}}
async function openDemo(){const existing=chaptersRef.current.find(c=>c.demo);if(existing){setCurrentId(existing.id);return;}setBusy('正在打开原创阅读示例…');try{const blob=await(await fetch('/samples/starlight-bookshop.png')).blob();const bitmap=await createImageBitmap(blob);const p=emptyPage('星光书店 · 原创示例.png',bitmap.width,bitmap.height);bitmap.close();Object.assign(p,await imageIdentity(blob));p.blobKey=`original:${p.id}`;await store.putBlob(p.blobKey,blob);const c={...makeChapter('星光书店', [p],'原创阅读示例'),demo:true};updateChapter(c);setCurrentId(c.id);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
async function acquireManifest(){if(!sourceManifest)return;setBusy('正在获取已发现的原图…');try{const origins=[...new Set(sourceManifest.items.map(i=>new URL(i.url).origin+'/*'))];const granted=origins.length?await chrome.permissions.request({origins}):true;if(!granted)throw Error('未取得图片域名权限。你仍可导入本地图片。');const results=await mapConcurrent(sourceManifest.items,settings.requestConcurrency,async item=>{const p=emptyPage(`第 ${item.order+1} 页`,item.width,item.height);p.sourceUrl=item.url;try{const valid=await chrome.runtime.sendMessage({type:'NC_SOURCE_IMAGE',manifestId:sourceManifest.id,pageId:item.id});if(!valid.ok)throw Error(valid.error);const blob=await requestPool.current.run(async()=>{const response=await fetch(valid.data.url,{credentials:'omit'});if(!response.ok)throw Error(`图片获取失败（HTTP ${response.status}），请在源网页保存后导入。`);return response.blob();});if(blob.size>40*1024*1024)throw Error('图片超过 40 MB 本地限制。');const bitmap=await createImageBitmap(blob);p.width=bitmap.width;p.height=bitmap.height;bitmap.close();Object.assign(p,await imageIdentity(blob));p.blobKey=`original:${p.id}`;await store.putBlob(p.blobKey,blob);}catch(e){p.fetchError=(e as Error).message;}return p;});const pages=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);const c={...makeChapter(sourceManifest.title,pages,sourceManifest.adapter),sourceUrl:sourceManifest.url,discoveryComplete:sourceManifest.discoveryComplete};updateChapter(c);setSettings(s=>({...s,direction:sourceManifest.direction}));setCurrentId(c.id);setSourceManifest(undefined);notify(`已获取 ${pages.filter(p=>p.blobKey).length} / ${pages.length} 张原图`);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
async function authenticate(){setBusy('正在登录…');setError('');try{let value:store.Session;if(authAllowed){const auth=await api.login(username.trim());value={token:auth.access_token,user:auth.user,apiOrigin};}else{if(!authConfig)throw Error('无法读取身份服务配置。');if(currentId)sessionStorage.setItem('nc-login-chapter',currentId);const result=await startOidc(authConfig,settings.apiBase);if(!result)return;value=result;}if(value.apiOrigin!==new URL(store.settings().apiBase).origin)throw Error('登录期间服务地址已切换，请重新登录。');store.saveSession(value);setAccount(value);setLoginOpen(false);notify('已连接账户，可以开始翻译了');}catch(e){setError((e as Error).message);}finally{setBusy('');}}
useEffect(()=>{if(account&&pendingIntent){const intent=pendingIntent;setPendingIntent(undefined);void prepareTranslation(intent);} },[account]);
async function prepareTranslation(intent:Intent,automatic=false,windowCurrent=()=>true):Promise<PreparationResult>{
  if(!currentRef.current||prepareLock.current||submitLock.current)return false;
  if(automatic&&(ready||!caps))return false;
  if(pendingKey){const raw=localStorage.getItem(pendingKey);if(raw){if(!automatic)setReady(JSON.parse(raw));return false;}}
  const acc=accountRef.current;if(!acc){setPendingIntent(intent);setLoginOpen(true);return false;}
  if(!caps?.modes.find(m=>m.id===intent.mode)?.enabled){const message=`${modeLabels[intent.mode]}暂未配置就绪，请选择其他方式或稍后再试。`;if(automatic)pauseAutomatic(message);else setError(message);return false;}
  if(intent.pages.length>caps.limits.max_batch){setError(`单次翻译最多选择 ${caps.limits.max_batch} 页，请在页面列表调整范围。`);return false;}
  const chapterId=currentRef.current;const language=settings.language;
  const live=()=>api.isCurrent()&&currentRef.current===chapterId&&(!automatic||autoState.current.enabled&&autoScopeRef.current===autoScope&&windowCurrent());
  prepareLock.current=true;
  if(!automatic){setBusy('正在匹配已有翻译并准备选中页…');setError('');}
  try{
    const requested=chaptersRef.current.find(c=>c.id===chapterId)?.pages.filter(p=>intent.pages.some(n=>n.id===p.id))??[];
    if(!requested.length)return true;
    setPreparingPages(requested.map(p=>p.id));
    const snapshots=new Map(chaptersRef.current.find(c=>c.id===chapterId)!.pages.map(page=>[page.id,page]));
    const {matches,errors}=await matchFilePages(api,requested,intent.mode,language);assertCurrent(live);
    const retryPages=new Set(requested.filter(p=>{const source=pageSource(p);return source&&retryablePreparation(errors.get(sourceKey(source)));}).map(p=>p.id));
    const latest=chaptersRef.current.find(c=>c.id===chapterId);if(!latest)return false;
    updateChapter({...latest,pages:latest.pages.map(p=>{const source=pageSource(p);const match=source&&matches.get(sourceKey(source));return match?applyMatch(p,match,acc.user.id,apiOrigin,snapshots.get(p.id)):p;})});
    const eligible=chaptersRef.current.find(c=>c.id===chapterId)?.pages.filter(p=>requested.some(n=>n.id===p.id))??[];
    const planned=planTranslation(eligible,{matches,errors},intent.mode,language,!!intent.regenerate);
    const selected=planned.selected;const failures=planned.failures.map(({page,message})=>`${page.name}：${message}`);
    for(const {page,message} of planned.failures)patchPage(chapterId,page.id,p=>({...p,translationError:message}));
    const outcomes=await uploadPages(api,selected,acc.user.id,apiOrigin,settings.requestConcurrency,store.getBlob,page=>{
      patchPage(chapterId,page.id,latestPage=>({...latestPage,assetId:page.assetId,assetExpiresAt:page.assetExpiresAt,ownerId:page.ownerId,apiOrigin:page.apiOrigin,jobs:mergeJobs(latestPage.jobs,page.jobs),translationError:undefined}));
    },live);assertCurrent(live);
    const uploaded:Page[]=[];
    outcomes.forEach((result,index)=>{if(result.status==='fulfilled')uploaded.push(result.value.page);else{if(retryablePreparation(result.reason))retryPages.add(selected[index].id);const message=(result.reason as Error).message;failures.push(`${selected[index].name}：${message}`);patchPage(chapterId,selected[index].id,p=>({...p,translationError:message}));}});
    if(failures.length&&!automatic){setError(`${failures.length} 页未能准备，其余页面可继续。${failures.slice(0,3).join('；')}`);}
    // Identical source images and duplicate MOBI references may resolve to the same asset.
    const pages=[...new Map(uploaded.map(page=>[page.assetId!,page])).values()];
    if(!pages.length){if(automatic&&retryPages.size){pauseAutomatic('连接暂不可用，稍后自动重试',Date.now()+15000);return {retry:[...retryPages]};}if(!automatic&&!failures.length)notify('所选页面已有结果、无字记录或正在处理，无需重复创建任务');return true;}
    assertCurrent(live);
    const pending=localStorage.getItem(pendingKey);if(pending){if(!automatic)setReady(JSON.parse(pending));return false;}
    const rerun=intent.regenerate&&pages.length===1?rerunSource(pages[0],matches.get(sourceKey(pageSource(pages[0])!)),intent.mode,language):undefined;
    if(intent.regenerate&&!rerun)throw Error('旧版本的原图已失效，无法主动重建。请使用普通翻译重新准备此页。');
    const quote=await api.quote(rerun?[rerun.inputAssetId]:pages.map(p=>p.assetId!),intent.mode,language);assertCurrent(live);
    const prepared:ReadyQuote={quote,intent:{...intent,pages:uploaded},key:id(),chapterId,ownerId:acc.user.id,apiOrigin,targetLanguage:language,rerun};
    if(automatic){
      if(quote.unit_cost!==autoConsents[consentScope]?.unitCost){pauseAutomatic(`每页价格已变为 ${quote.unit_cost} 点，请确认新价格`,undefined,true);return false;}
      if(!await submitQuote(prepared,true))return false;
      if(retryPages.size){pauseAutomatic('部分页面连接失败，稍后自动补齐',Date.now()+15000);return {retry:[...retryPages]};}
    }else setReady(prepared);
    return true;
  }catch(e){if(api.isCurrent()&&!(e instanceof StaleOperation)){if(automatic){pauseAutomatic((e as Error).message,retryablePreparation(e)?Date.now()+15000:undefined);}else setError((e as Error).message);}}
  finally{prepareLock.current=false;setPreparingPages([]);if(!automatic)setBusy('');}
  return false;
}
async function submitQuote(prepared:ReadyQuote=ready!,automatic=false){
  if(!prepared||!accountRef.current||submitLock.current||!api.isCurrent())return;
  if(prepared.ownerId!==accountRef.current.user.id||prepared.apiOrigin!==accountRef.current.apiOrigin){setError('账户或服务已切换，请回到原账户核实这次提交。');return;}
  if(automatic&&(!autoState.current.enabled||autoState.current.chapterId!==prepared.chapterId||autoScopeRef.current!==autoScope))return;
  if(!automatic)setBusy('正在确认额度并提交任务…');
  const storageKey=`nc-submission:${prepared.apiOrigin}:${prepared.ownerId}`;
  submitLock.current=true;
  const clearPending=()=>{if(JSON.parse(localStorage.getItem(storageKey)??'null')?.key===prepared.key)localStorage.removeItem(storageKey);};
  try{
    const existing=localStorage.getItem(storageKey);if(existing&&JSON.parse(existing).key!==prepared.key)throw Error('另一项提交尚待核实，请先完成原提交。');
    // Persist before crossing the network boundary; an uncertain response reuses this exact key.
    localStorage.setItem(storageKey,JSON.stringify(prepared));
    let returned:Job[];
    if(prepared.intent.regenerate){
      if(!prepared.rerun)throw Error('新版本缺少已核实的原任务绑定，请重新估算。');
      returned=[await api.rerun(prepared.rerun.jobId,`${prepared.key}:${prepared.rerun.pageId}`,prepared.quote.id,prepared.quote.total_cost,prepared.rerun.inputAssetId)];
    }else returned=(await api.batch(prepared.quote.id,prepared.quote.total_cost,prepared.key)).jobs;
    if(!api.isCurrent())return;
    const bound=bindSubmission(chaptersRef.current.find(c=>c.id===prepared.chapterId),prepared.intent.pages,returned,prepared.ownerId,prepared.apiOrigin,prepared.rerun);
    if(bound.chapter){updateChapter(bound.chapter);await store.saveChapter(bound.chapter);}
    if(bound.detachedJobIds.length)localStorage.setItem(`nc-detached:${prepared.apiOrigin}:${prepared.ownerId}:${prepared.key}`,JSON.stringify({jobs:bound.detachedJobIds,createdAt:Date.now()}));
    if(!api.isCurrent())return;
    clearPending();setError('');
    if(!automatic){setReady(undefined);notify(`已提交 ${returned.length} 页${modeLabels[prepared.intent.mode]} · 可以继续读原图`);}
    refreshUsage();
    if(!automatic&&autoApproval)setAutoPause(undefined);
    return true;
  }catch(e){if(!api.isCurrent())return;const rejected=submissionRejected(e);if(rejected){clearPending();setReady(undefined);}if(automatic){pauseAutomatic(rejected?(e as Error).message:'提交结果待核实，已保留原请求；请核实后继续',rejected&&retryablePreparation(e)?Date.now()+15000:undefined);}else{setError((e as Error).message+(rejected?' 此请求未创建任务，请重新估算。':' 提交记录已保存，请使用同一确认按钮核实，避免重复新建。'));}return false;}
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
  if(resume&&!pause?.priceChanged){autoQueue.current.reset();setAutoPause(undefined);return;}
  let capabilities=caps;
  try{capabilities=await api.capabilities();if(!api.isCurrent()||autoScopeRef.current!==autoScope)return;setCaps(capabilities);}catch(e){setError((e as Error).message);return;}
  const selectedMode=capabilities?.modes.find(m=>m.id===settings.translationMode);
  if(!selectedMode?.enabled){setError('所选翻译方式尚未配置，暂时不能开启自动翻译。');return;}
  if(ready||pendingKey&&localStorage.getItem(pendingKey)){setError('请先完成或核实当前提交，再开启自动翻译。');return;}
  setConfirmAction({title:resume?'确认自动翻译价格':'开启自动翻译',body:`${modeLabels[settings.translationMode]} · 每页 ${selectedMode.unit_cost} 点。跟随阅读位置翻译当前页和后 ${settings.autoAhead} 页，持续使用账户可用额度；已有结果不重复提交。本机会记住此账户、服务、模式与语言的选择，刷新、换漫画或下次阅读时自动继续；离开阅读器时停止添加任务，手动关闭后保持关闭。`,action:async()=>{
    if(autoScopeRef.current!==autoScope)return;
    updateAutoConsent({...autoConsents,[consentScope]:{unitCost:selectedMode.unit_cost}});autoQueue.current.reset();setAutoPause(undefined);
  }});
}
function exitReader(){autoState.current.enabled=false;autoQueue.current.reset();setCurrentId(undefined);}
const balance=usage?.available??caps?.quota?.available;
const nav=(value:View)=>{exitReader();setView(value);location.hash=value;setError('');};
return <div className={`nc-app ${current?'is-reading':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=current?'none':'copy';setDrag(!current);}}} onDrop={e=>{e.preventDefault();setDrag(false);if(!current)void importFiles(Array.from(e.dataTransfer.files));}}>
<input aria-label="选择漫画图片" type="file" multiple accept={COMIC_ACCEPT} ref={input} className="hidden-input" onChange={e=>void importFiles(Array.from(e.target.files??[]))}/>
{!current&&<header className="nc-app-header"><button className="nc-brand" aria-label="返回我的漫画" onClick={()=>nav('library')}><span>✦</span><b>Node Comics</b></button><nav aria-label="主导航">{([['library','我的漫画','book'],['history','翻译记录','clock'],['usage','用量统计','coin']] as const).map(([value,label,icon])=><button key={value} aria-current={view===value?'page':undefined} onClick={()=>nav(value)}><Icon name={icon} size={19}/>{label}</button>)}</nav><div className="nc-header-actions"><button className="icon-button" aria-label="外观与设置" onClick={()=>nav('settings')}><Icon name="settings"/></button><button className="nc-account-button" onClick={()=>account?nav('account'):setLoginOpen(true)}><span className="nc-avatar">{account?account.user.name[0].toUpperCase():<Icon name="user" size={18}/>}</span><span>{account?`${balance??'—'} 点`:'登录'}</span></button></div></header>}
<div className="nc-workspace">
{error&&<div className="global-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
{current?<Reader key={`${current.id}:${account?.user.id}:${apiOrigin}`} api={api} busy={!!busy} preparingPages={preparingPages} chapter={current} settings={settings} setSettings={setSettings} update={updateChapter} onBack={exitReader} onTranslate={(mode,pages,regenerate)=>void prepareTranslation({mode,pages,regenerate})} onImport={()=>input.current?.click()} notify={notify} autoEnabled={autoApproval} autoStatus={autoApproval?(pause?.message||(pendingKey&&localStorage.getItem(pendingKey)?'提交结果待核实，请核实后继续':'')):''} autoRetrying={!!pause?.retryAt} onAutoResume={()=>void askAuto(true)} onAutoToggle={()=>void askAuto()} onAutoWindow={autoTranslate} caps={caps} userId={account?.user.id} apiOrigin={apiOrigin} recoveryStatus={recoveryStatus} recovering={recovering} onRecover={(mode,pages)=>void recoverChapter(true,mode,pages)} recoveryEnabled={!!account} onCancel={async(job)=>{try{const result=await api.cancel(job.id);if(!api.isCurrent())return;const p=chaptersRef.current.find(c=>c.id===current.id)?.pages.find(p=>p.jobs.some(j=>j.id===job.id));if(p)patchPage(current.id,p.id,page=>({...page,jobs:mergeJobs(page.jobs,[result])}));refreshUsage();}catch(e){setError((e as Error).message);}}}/>:
<main className="nc-main">{view==='admin'&&account?.user.role==='admin'&&<><AdminPanel api={api}/><FeedbackInbox api={api} admin/></>}
{view==='library'&&<Library chapters={chapters} settings={settings} setSettings={setSettings} userId={account?.user.id} apiOrigin={apiOrigin} onOpen={setCurrentId} onImport={()=>input.current?.click()} onDemo={()=>void openDemo()} onUpdate={updateChapter} onDelete={chapter=>setConfirmAction({title:'移除这本漫画？',body:'将删除该漫画的本地图片与阅读进度。服务端翻译记录仍可找回。',action:async()=>{await store.deleteChapter(chapter);const next=chaptersRef.current.filter(c=>c.id!==chapter.id);chaptersRef.current=next;setChapters(next);}})}/>}
{view==='history'&&<TranslationHistory key={`${apiOrigin}:${account?.user.id??''}`} api={api} chapters={chapters} userId={account?.user.id} onLogin={()=>setLoginOpen(true)} onOpen={(chapter,job,group)=>{const mode=job?.mode??group?.mode;const language=job?.target_language??group?.target_language;if(mode&&language)setSettings(s=>({...s,translationMode:mode,language}));const page=job?chapter.pages.find(p=>p.jobs.some(j=>j.id===job.id)||p.assetId===(job.requested_asset_id??job.input_asset_id)):undefined;if(page){store.savePosition(chapter.id,{pageId:page.id,relativeOffset:0});updateChapter({...chapter,pageId:page.id,relativeOffset:0});}setCurrentId(chapter.id);}} onDelete={job=>setConfirmAction({title:'删除服务器译图？',body:'删除后撤销服务器访问，已保存的本地副本仍可阅读。重新翻译需要新的报价。',action:async()=>{await api.deleteImage(job.output_asset_id!);if(!api.isCurrent())return;for(const c of chaptersRef.current)updateChapter({...c,pages:c.pages.map(p=>p.ownerId===account?.user.id&&p.apiOrigin===apiOrigin?{...p,jobs:p.jobs.map(j=>j.output_asset_id===job.output_asset_id?{...j,output_asset_id:null,result_available:false,result_expired:true}:j)}:p)});notify('服务器译图已删除');}})}/>}
{view==='usage'&&<UsagePage key={`${apiOrigin}:${account?.user.id??''}`} api={api} onLogin={()=>setLoginOpen(true)}/>}
{view==='settings'&&<Preferences key={`${apiOrigin}:${account?.user.id??''}`} api={api} account={!!account} settings={settings} setSettings={setSettings} caps={caps} cacheBytes={cacheBytes} notify={notify} onSaveApiAddress={saveApiAddress} onClearCache={()=>setConfirmAction({title:'清理本地图片缓存？',body:'所有本地原图和译图将被删除，书架和进度保留。之后需重新导入原图，译图可在服务器保留期内重新获取。',action:async()=>{await store.clearImages(chaptersRef.current);setChapters(await store.readChapters());setCacheBytes(0);notify('本地图片已清理，书架与进度已保留');}})}/>}
{view==='account'&&<><PageTitle eyebrow="A LITTLE MAGIC FOR EVERY PAGE" title="我的账户" description="成功交付后结算；失败或未执行时释放预占。费用与任务逐笔记录。"/>{account?<><div className="account-summary"><span className="avatar large">{account.user.name[0].toUpperCase()}</span><div><h2>{account.user.name}</h2><p>{authAllowed?'本地测试账户':'已登录账户'} · {account.user.role==='admin'?'管理员':'读者'}</p></div><button className="button secondary small" onClick={()=>{api.isCurrent=()=>false;store.saveSession(null);setAccount(null);setUsage(undefined);setReady(undefined);autoState.current.enabled=false;autoQueue.current.reset();notify('已退出账户，原图仍可继续阅读');}}>退出登录</button></div><div className="stat-grid"><Stat label="可用额度" value={usage?.available??'—'} suffix="点"/><Stat label="处理中预占" value={usage?.reserved??'—'} suffix="点"/><Stat label="账户余额" value={usage?.balance??'—'} suffix="点"/></div><section className="settings-card"><div className="nc-section-heading"><div><h2>用量与反馈</h2><p className="nc-muted">查看实际消耗、逐笔记录和反馈处理进展。</p></div><button className="button primary" onClick={()=>nav('usage')}>查看用量统计</button>{account.user.role==='admin'&&<button className="button secondary" onClick={()=>nav('admin')}><Icon name="shield"/>运营管理</button>}</div></section><FeedbackInbox api={api}/></>:<div className="login-prompt"><span className="feature-icon pink"><Icon name="user" size={28}/></span><h2>准备好，一起漫游了吗？</h2><p>无需登录即可阅读原图。登录账户，开始翻译并查看额度。</p><button className="button primary" onClick={()=>setLoginOpen(true)}>登录账户 <Icon name="arrow" size={18}/></button></div>}<div className="privacy-note standalone"><Icon name="info"/><p>本版本使用运营方发放的测试额度，尚未接入支付。公开部署需配置正式身份认证。</p></div></>}
</main>}
</div>
{drag&&!current&&<div className="drop-overlay" onDragLeave={()=>setDrag(false)}><Icon name="upload" size={60}/><h2>把故事放在这里</h2><p>支持图片、MOBI、CBZ/ZIP、CBR/RAR、PDF（未加密）</p></div>}
{busy&&<div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}{toast&&<div className="toast" role="status"><Icon name="check" size={18}/>{toast}</div>}
{loginOpen&&<Modal title="连接你的漫游账户" subtitle="原图无需登录。翻译任务和额度将归属于这个账户。" onClose={()=>{setLoginOpen(false);setPendingIntent(undefined);}}>
  {authAllowed?<><div className="notice"><Icon name="info"/><span>本地测试登录已由后端开启，仅用于开发验证。</span></div><label className="field">测试用户名<input value={username} maxLength={60} onChange={e=>setUsername(e.target.value)} placeholder="例如 reader" autoFocus/></label></>:<div className="notice"><Icon name="shield"/><span>{authConfig?.mode==='oidc'?'将前往身份服务安全登录，完成后回到当前阅读位置。':'身份服务尚未配置，请联系运营方。'}</span></div>}
  <button className="button primary full" style={{marginTop:20}} disabled={!!busy||(authAllowed?!username.trim():authConfig?.mode!=='oidc'||!authConfig?.authorization_endpoint||!authConfig?.token_endpoint||!authConfig?.client_id)} onClick={()=>void authenticate()}>{authAllowed?'连接测试账户':'继续登录'} <Icon name="arrow" size={18}/></button>
</Modal>}
{ready&&<Modal title={ready.intent.regenerate?'重新翻译这一页':`开始${modeLabels[ready.intent.mode]}`} subtitle="确认点数后开始，翻译过程中可以继续阅读。" onClose={()=>{if(!busy)setReady(undefined);}}><div className="quote-summary"><span>本次选中<b>{ready.quote.page_count} <small>页</small></b></span><span>预计预占<b>{ready.quote.total_cost} <small>点</small></b></span><span>目标语言<b className="language-value">{caps?.languages.find(l=>l.id===ready.targetLanguage)?.label??ready.targetLanguage}</b></span></div><p className="modal-copy">逐页交付、逐页结算；原图与已有译图一直保留。{ready.intent.mode==='classic'?'常规翻译只处理文字区域，请检查识别和排版效果。':'图片重绘可能改变画面细节，请在完成后对照检查。'}</p>{ready.intent.regenerate&&<p className="notice warning">将生成新的翻译结果。完成后替换当前模式的显示效果，原图仍可随时查看。</p>}<div className="quote-expiry">报价有效至 {new Date(ready.quote.expires_at).toLocaleTimeString()} · 确认后可继续阅读</div><button className="button primary full" disabled={!!busy} onClick={()=>void submitQuote()}><Icon name="spark" size={18}/>确认并开始 · {ready.quote.total_cost} 点</button></Modal>}
{sourceManifest&&<Modal title={`发现 ${sourceManifest.items.length} 张图片`} subtitle={sourceManifest.title} onClose={()=>setSourceManifest(undefined)}><div className="notice"><Icon name="info"/><span>{sourceManifest.note}</span></div><p className="modal-copy">下一步按需申请图片域名权限，并把原图缓存到当前设备。此时不会上传到翻译后端。</p><button className="button primary full" onClick={()=>void acquireManifest()} disabled={!!busy||!sourceManifest.items.length}>获取原图并阅读 <Icon name="arrow"/></button></Modal>}
{confirmAction&&<Modal title={confirmAction.title} subtitle={confirmAction.body} onClose={()=>setConfirmAction(undefined)}><button className="button primary full" onClick={async()=>{const action=confirmAction;setConfirmAction(undefined);try{await action.action();}catch(e){setError((e as Error).message);}}}>确认</button></Modal>}
</div>;
}
