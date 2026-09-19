import {useCallback,useEffect,useRef,useState} from 'react';
import {Api,ApiError} from '../api';
import {supportsLanguage,type Capabilities,type Entitlements,type Job,type Mode,type ModeQueue,type Page,type ReadingCopy} from '../types';
import {mergeJobs} from '../reader/jobs';
import {latestResults,pageTranslation} from '../reader/presentation';
import {assertCurrent,mapConcurrent} from '../concurrency';
import * as libraryStore from '../library/store';
import {applyAccountJobs,readingPriority} from './sync';
import {applyMatch,matchFilePages,pageSource,sourceKey} from '../reader/recovery';
import {processManifest} from './processor';
import {readManifests,readManifest,saveManifest,withManifestLock,readSync,saveSync,translationScope,type UploadManifest} from './store';

import {ReadingWindow,automaticManifest,exhausted,availableSlots,needsTranslation,targetKey,quotaErrors,capacityErrors,type ReadingTarget,type TranslationState} from './automatic';

export function useAutomaticTranslation({api,userId,origin,copies,updateCopy,concurrency,language,currentId,caps,rights,refreshUsage}:{api:Api;userId?:string;origin:string;copies:ReadingCopy[];updateCopy:(copy:ReadingCopy)=>void;concurrency:number;language:string;currentId?:string;caps?:Capabilities;rights?:Entitlements|null;refreshUsage:()=>void}){
 const [,render]=useState(0);
 const [queues,setQueues]=useState<ModeQueue[]>([]),[jobs,setJobs]=useState<Job[]>([]),[manifests,setManifests]=useState<UploadManifest[]>([]),[error,setError]=useState('');
 const scope=userId?translationScope(origin,userId):'',copyRef=useRef(copies);copyRef.current=copies;
 const commitCopy=useCallback((copy:ReadingCopy)=>{copyRef.current=copyRef.current.map(value=>value.id===copy.id?copy:value);updateCopy(copy);},[updateCopy]);
 const jobsRef=useRef(jobs);jobsRef.current=jobs;const queueRef=useRef(queues);queueRef.current=queues;
 const windowRef=useRef(new ReadingWindow()),config=useRef({caps,rights,refreshUsage});config.current={caps,rights,refreshUsage};
 const visible=useRef<Page[]>([]),readingSignature=useRef(''),generation=useRef(0),wake=useRef(()=>{});
 const session=useRef(crypto.randomUUID()),sequence=useRef(0),lastPriority=useRef('');
 const reload=useCallback(async()=>{if(!scope)return;const records=await readManifests(scope);if(api.isCurrent())setManifests(records.sort((a,b)=>b.createdAt-a.createdAt));},[scope,api]);
 const attach=useCallback(async(incoming:Job[])=>{
  if(!api.isCurrent()||!userId)return;
  jobsRef.current=mergeJobs(jobsRef.current,incoming);setJobs(jobsRef.current);
  for(const copy of copyRef.current){const updated=applyAccountJobs(copy,incoming,userId,origin);if(updated!==copy)commitCopy(updated);}
 },[api,userId,origin,commitCopy]);
 const refresh=useCallback(async()=>{if(!scope)return;const data=await api.queues();if(api.isCurrent()){queueRef.current=data.items;setQueues(data.items);}await reload();},[scope,api,reload]);
 useEffect(()=>{
  ++generation.current;lastPriority.current='';if(!currentId){windowRef.current.update([]);visible.current=[];}
 },[currentId,language]);
 useEffect(()=>{
  if(!scope){setQueues([]);setJobs([]);jobsRef.current=[];setManifests([]);return;}
  let stopped=false,timer:ReturnType<typeof setTimeout>,running=false,syncing=false,backgroundState=false,wakeRequested=false;let cursor:string|undefined;let retryAt=0;
  const live=()=>!stopped&&api.isCurrent();
  const focus=()=>{lastPriority.current='';wake.current();};window.addEventListener('focus',focus);
  const visibility=()=>{if(!document.hidden)focus();};document.addEventListener('visibilitychange',visibility);
  async function sync(){
   if(syncing)return;
   syncing=true;
   try{
   for(let page=0;page<20;page++){
    let changes;
    try{changes=await api.translationChanges(cursor);}catch(e){if(e instanceof ApiError&&['CURSOR_EXPIRED','INVALID_CURSOR'].includes(e.code)){cursor=undefined;continue;}throw e;}
    assertCurrent(live);
    const deleted=new Set(changes.deleted_job_ids??[]);
    const tombstones=jobsRef.current.filter(j=>deleted.has(j.id)).map(job=>({...job,status:'cancelled' as const,output_asset_id:null,result_available:false,result_expired:true,updated_at:new Date().toISOString()}));
    await attach([...changes.items,...tombstones]);
    cursor=changes.cursor;
    // Cursor and matching records are committed together; a refresh cannot skip unseen records.
    await saveSync({id:scope,cursor,jobs:jobsRef.current});
    if(!changes.has_more)break;
   }
   }finally{syncing=false;}
  }
  async function priorities(){
   if(document.hidden||!windowRef.current.ready().length)return;
   for(const queue of queueRef.current){
    const pages=windowRef.current.targets.filter(t=>t.mode===queue.mode).map(t=>t.page);
    const planned=readingPriority(pages,jobsRef.current,queue.mode,language,queue.realtime_limit);
    if(!planned.ordered_job_ids.length&&!queue.realtime_count)continue;
    const signature=JSON.stringify([queue.mode,planned,queue.version]);
    if(lastPriority.current===signature)continue;
    try{
     const value=await api.priority(queue.mode,{...planned,session_id:session.current,sequence:++sequence.current,expected_version:queue.version,ttl_seconds:90,takeover:true});assertCurrent(live);
     queue.version=value.version;lastPriority.current=JSON.stringify([queue.mode,planned,value.version]);
    }catch(e){if(!(e instanceof ApiError&&['QUEUE_VERSION_CONFLICT','STALE_PRIORITY','READING_SESSION_ACTIVE'].includes(e.code)))throw e;}
   }
  }
  const process=async(manifest:UploadManifest)=>{
   await processManifest({api,manifest,available:1,readingPageIds:[],readingSessionId:session.current,concurrency,getBlob:libraryStore.getBlob,onJobs:attach,onChange:()=>{void reload();}});
   assertCurrent(live);await refresh();config.current.refreshUsage();
  };
  async function translateWindow(){
   // Recover exact submitted requests even after navigation. Never consume old local bulk plans.
   const records=await readManifests(scope);
   for(const manifest of records)if(manifest.pending&&!manifest.paused)await process(manifest);
   const {rights,caps}=config.current;
   if(document.hidden||!rights||!caps)return;
   for(const target of windowRef.current.ready()){
    if(!live()||document.hidden||!windowRef.current.ready().some(t=>targetKey(t.copyId,t.page,t.mode)===targetKey(target.copyId,target.page,target.mode)))break;
    const {copyId,mode}=target;
    if(!caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(caps,mode,language))continue;
    let page=copyRef.current.find(c=>c.id===copyId)?.pages.find(p=>p.id===target.page.id);
    if(!page)continue;
    const id=JSON.stringify([scope,language,targetKey(copyId,page,mode)]);
    let manifest=await readManifest(id);
    if(manifest?.pending)continue;
    if(manifest?.paused&&quotaErrors.has(manifest.errorCode??'')){
     if(manifest.quotaKind===rights.modes[mode].quota_kind&&manifest.rightsVersion===JSON.stringify(rights.modes[mode]))continue;
     manifest=undefined;
    }
    if(manifest?.paused||manifest&&manifest.items.every(i=>i.state!=='local'))continue;
    if(!manifest&&!needsTranslation(page,mode,language,userId!,origin))continue;
    const queue=queueRef.current.find(q=>q.mode===mode);
    if(!queue)continue;
    if(!manifest){
     // Asset IDs belong to one account; content identity may be reused across accounts.
     const owned=page.ownerId===userId&&page.apiOrigin===origin;
     const source=pageSource(page);
     if(source){
      const found=await matchFilePages(api,[page],mode,language);assertCurrent(live);
      const match=found.matches.get(sourceKey(source));
      if(!match){continue;}
      page=applyMatch(page,match,userId!,origin);
      const copy=copyRef.current.find(c=>c.id===copyId);
      if(copy)commitCopy({...copy,pages:copy.pages.map(p=>p.id===page!.id?page!:p)});
      if(!needsTranslation(page,mode,language,userId!,origin))continue;
     }
     if(!page.blobKey&&!page.assetId)continue;
     if(!exhausted(rights.modes[mode])&&(queue.available_slots<=0||availableSlots(queueRef.current,rights.plan==='plus')<=0))continue;
     try{manifest=await automaticManifest({...target,page:owned||source?page:{...page,assetId:undefined}},scope,language,rights.modes[mode],libraryStore.getBlob);}
     catch(e){const copy=copyRef.current.find(c=>c.id===copyId);if(copy)commitCopy({...copy,pages:copy.pages.map(p=>p.id===page!.id?{...p,translationError:(e as Error).message}:p)});continue;}
    }
    if(!live()||!windowRef.current.ready().some(t=>targetKey(t.copyId,t.page,t.mode)===targetKey(target.copyId,target.page,target.mode)))break;
    if(!exhausted(rights.modes[mode])&&(queue.available_slots<=0||availableSlots(queueRef.current,rights.plan==='plus')<=0))continue;
    if(queue.paused){await api.pauseQueue(mode,false);assertCurrent(live);}
    manifest.rightsVersion=JSON.stringify(rights.modes[mode]);
    await withManifestLock(id,async()=>{
     const saved=await readManifest(id);
     if(saved?.pending||saved&&!saved.paused&&saved.items.every(i=>i.state!=='local'))return;
     assertCurrent(live);await saveManifest(manifest!);
    });
    await process(manifest);
   }
  }
  async function downloadVisible(){
   const stamp=generation.current;
   const originals=visible.current.map(p=>copyRef.current.flatMap(c=>c.pages).find(item=>item.id===p.id)??p).filter(p=>!p.blobKey&&p.assetId&&p.ownerId===userId&&p.apiOrigin===origin);
   await mapConcurrent(originals,concurrency,async page=>{
    const current=()=>live()&&stamp===generation.current;
    try{assertCurrent(current);const blob=await api.image(page.assetId!);assertCurrent(current);const key=`original:${origin}:${userId}:${page.assetId}`;await libraryStore.putBlob(key,blob);assertCurrent(current);
     for(const copy of copyRef.current)if(copy.pages.some(p=>p.id===page.id))commitCopy({...copy,pages:copy.pages.map(p=>p.id===page.id?{...p,blobKey:key,fetchError:undefined}:p)});
    }catch{/* The reader keeps the original recovery action and unaffected neighbouring pages. */}
   });
   const needed=[...new Map(visible.current.flatMap(page=>{
    const livePage=copyRef.current.flatMap(c=>c.pages).find(p=>p.id===page.id)??page;
    return livePage.ownerId===userId&&livePage.apiOrigin===origin?latestResults(livePage.jobs).filter(job=>job.target_language===language&&job.output_asset_id&&!livePage.outputBlobs[job.id]):[];
   }).map(job=>[job.id,job])).values()];
   await mapConcurrent(needed,concurrency,async job=>{
    const current=()=>live()&&stamp===generation.current;
    try{
     assertCurrent(current);const key=`result:${origin}:${userId}:${job.id}`;
     const blob=await libraryStore.getBlob(key)??await api.image(job.output_asset_id!);assertCurrent(current);
     await libraryStore.putBlob(key,blob);assertCurrent(current);
     for(const copy of copyRef.current){let changed=false;const pages=copy.pages.map(page=>{if(page.ownerId!==userId||page.apiOrigin!==origin||!page.jobs.some(j=>j.id===job.id))return page;changed=true;return {...page,outputBlobs:{...page.outputBlobs,[job.id]:key},translationError:undefined};});if(changed)commitCopy({...copy,pages});}
    }catch(e){if(!current())return;for(const copy of copyRef.current){const relevant=copy.pages.filter(p=>p.ownerId===userId&&p.apiOrigin===origin&&p.jobs.some(j=>j.id===job.id));if(relevant.length)commitCopy({...copy,pages:copy.pages.map(p=>relevant.includes(p)?{...p,translationError:(e as Error).message}:p)});}}
   });
  }
  async function tick(){
   clearTimeout(timer);if(running||!live())return;running=true;wakeRequested=false;
   try{
    if(Date.now()<retryAt)return;
    await sync();await refresh();assertCurrent(live);
    await priorities();
    await downloadVisible();await translateWindow();await priorities();
    await downloadVisible();retryAt=0;setError('');
   }catch(e){if(live()){setError((e as Error).message);retryAt=Date.now()+8000;}}
   finally{running=false;if(live())timer=setTimeout(()=>{lastPriority.current='';void tick();},document.hidden?12000:wakeRequested?450:4000);}
  }
  wake.current=()=>{wakeRequested=true;if(!running){clearTimeout(timer);timer=setTimeout(()=>void tick(),450);}};
  // A large upload manifest must not prevent already-finished current pages from appearing.
  const stateTimer=setInterval(()=>{if(!running||backgroundState||!live())return;backgroundState=true;void(async()=>{try{await sync();await refresh();await priorities();await downloadVisible();}catch(e){if(live())setError((e as Error).message);}finally{backgroundState=false;}})();},4000);
  void readSync(scope).then(async saved=>{if(!live())return;jobsRef.current=[];cursor=saved?.cursor;await attach(saved?.jobs??[]);await reload();void tick();}).catch(e=>setError(e.message));
  return()=>{stopped=true;clearTimeout(timer);clearInterval(stateTimer);wake.current=()=>{};window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visibility);};
 },[scope,api,attach,refresh,reload,concurrency,language]);
 // A newly imported copy can bind account records even when no new server event is emitted.
 useEffect(()=>{if(!userId)return;for(const copy of copies){const updated=applyAccountJobs(copy,jobsRef.current,userId,origin);if(updated!==copy)commitCopy(updated);}},[copies,userId,origin,commitCopy]);
 const onReadingWindow=useCallback((targets:ReadingTarget[],visiblePages:Page[])=>{
  const changed=windowRef.current.update(targets);visible.current=visiblePages;if(changed)render(n=>n+1);
  const signature=JSON.stringify(visiblePages.map(p=>[p.id,p.blobKey]));
  if(changed||signature!==readingSignature.current){readingSignature.current=signature;++generation.current;wake.current();}
 },[]);
 const retry=useCallback(async(copyId:string,page:Page,mode:Mode)=>{
  if(!scope||!userId||!rights)return;
  const latest=pageTranslation(page,mode,language,userId,origin);
  if(latest.pending||latest.latest?.status==='unknown_released')throw Error('原请求结果待核实，暂不能重复翻译。');
  if(latest.result?.output_asset_id&&!latest.ready&&!latest.expired){wake.current();return;}
  const owned=page.ownerId===userId&&page.apiOrigin===origin;
  const manifest=await automaticManifest({copyId,page:owned?page:{...page,assetId:undefined},mode},scope,language,rights.modes[mode],libraryStore.getBlob,latest.latest?.id);
  await withManifestLock(manifest.id,async()=>{
   const previous=await readManifest(manifest.id);
   if(previous?.pending)throw Error('正在恢复原提交，请稍后重试。');
   if(previous&&!previous.paused&&(previous.items.some(i=>i.state==='local')||previous.regenerate&&previous.rerunJobId===latest.latest?.id))return;
   assertCurrent(api.isCurrent);await saveManifest(manifest);
  });
  await reload();wake.current();
 },[scope,userId,rights,language,origin,reload,api]);
 function stateFor(copyId:string,page:Page,mode:Mode):TranslationState|undefined{
  const t=pageTranslation(page,mode,language,userId,origin);
  const active=windowRef.current.targets.some(target=>target.copyId===copyId&&target.page.id===page.id&&target.mode===mode);
  if(t.pending)return {kind:t.pending.status==='queued'?'waiting':'translating',message:t.pending.status==='outcome_unknown'?'结果核实中':t.pending.status==='queued'?'等待翻译':'翻译中'};
  const manifest=manifests.find(m=>m.automatic&&m.language===language&&m.mode===mode&&m.items.some(i=>i.copyId===copyId&&i.pageId===page.id));
  if(manifest?.pending&&!manifest.paused)return {kind:'translating',message:manifest.error?'正在恢复提交':'翻译中'};
  if(manifest&&!manifest.paused&&manifest.items.some(i=>i.state==='local'))return {kind:'waiting',message:'等待翻译'};
  if(manifest?.error){
   if(quotaErrors.has(manifest.errorCode??''))return {kind:'upgrade',message:'升级权益，继续翻译'};
   if(capacityErrors.has(manifest.errorCode??''))return {kind:'waiting',message:'等待翻译'};
   return {kind:'error',message:manifest.error};
  }
  if(t.latest?.status==='unknown_released')return {kind:'error',message:'原请求结果待核实',retryable:false};
  if(t.latest?.status==='failed')return {kind:'error',message:t.latest.error?.message??'翻译失败'};
  if(t.ready)return;
  if(t.result?.output_asset_id&&!t.expired)return {kind:page.translationError?'error':'translating',message:page.translationError??'正在读取译图',retryLabel:'点击重新加载'};
  if(t.latest?.status==='no_text')return;
  if(t.latest)return {kind:'error',message:t.expired?'译图已失效':t.latest.error?.message??'翻译已停止'};
  if(!active)return;
  if(page.translationError)return {kind:'error',message:page.translationError};
  if(!userId)return {kind:'login',message:'登录后自动翻译'};
  if(!caps)return {kind:error?'error':'waiting',message:error||'正在连接翻译服务'};
  if(!caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(caps,mode,language))return {kind:'error',message:'此翻译方式暂不可用',retryable:false};
  if(rights&&exhausted(rights.modes[mode]))return {kind:'upgrade',message:'升级权益，继续翻译'};
  if(error)return {kind:'error',message:error};
  return {kind:'waiting',message:'等待翻译'};
 }
 return {onReadingWindow,stateFor,retry};
}
