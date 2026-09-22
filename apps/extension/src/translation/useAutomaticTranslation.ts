import {msg} from '../i18n/runtime';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Api,ApiError} from '../api';
import {supportsLanguage,type Capabilities,type Entitlements,type Job,type Mode,type Page,type ReadingCopy} from '../types';
import {mergeJobs} from '../reader/jobs';
import {latestResults,pageTranslation} from '../reader/presentation';
import {assertCurrent} from '../concurrency';
import * as libraryStore from '../library/store';
import {loadResultBlob,resultBlobKey} from '../library/result-cache';
import {applyAccountJobs} from './sync';
import {TranslationCoordinator} from './coordinator';
import {readOperations,translationScope,type LocalOperation} from './store';
import {ReadingWindow,operationId,type ReadingTarget,type TranslationState} from './automatic';
import {translationState} from './state';

function readingSessionSlot(scope:string){const key='nc-reading-session:'+scope;try{const saved=sessionStorage.getItem(key);if(saved)return saved;const id=crypto.randomUUID();sessionStorage.setItem(key,id);return id;}catch{return crypto.randomUUID();}}
export function useAutomaticTranslation({api,userId,origin,copies,updateCopy,language,currentId,caps,rights,onPolicy,refreshConfiguration}:{api:Api;userId?:string;origin:string;copies:ReadingCopy[];updateCopy:(copy:ReadingCopy)=>void;language:string;currentId?:string;caps?:Capabilities;rights?:Entitlements|null;onPolicy?:(rights:Entitlements)=>void;refreshConfiguration?:()=>Promise<Entitlements>}){
 const [,render]=useState(0),[operations,setOperations]=useState<LocalOperation[]>([]),[error,setError]=useState('');
 const scope=userId?translationScope(origin,userId):'',copyRef=useRef(copies);copyRef.current=copies;
 const config=useRef({caps,rights,onPolicy});config.current={caps,rights,onPolicy};
 const jobs=useRef<Job[]>([]),windowRef=useRef(new ReadingWindow()),visible=useRef<Page[]>([]);
 const coordinator=useRef<TranslationCoordinator|undefined>(undefined),wake=useRef<()=>void>(()=>{}),stamp=useRef(0);
 const commit=useCallback((copy:ReadingCopy)=>{copyRef.current=copyRef.current.map(c=>c.id===copy.id?copy:c);updateCopy(copy);},[updateCopy]);
 const attach=useCallback(async(incoming:Job[])=>{if(!api.isCurrent()||!userId)return;jobs.current=mergeJobs(jobs.current,incoming);for(const copy of copyRef.current){const changed=applyAccountJobs(copy,incoming,userId,origin);if(changed!==copy)commit(changed);}},[api,userId,origin,commit]);
 const downloadResult=useCallback(async(job:Job,current=api.isCurrent)=>{
   assertCurrent(current);if(!userId)return;const key=resultBlobKey(origin,userId,job);
   await loadResultBlob({origin,userId,job,download:()=>api.image(job.output_asset_id!),isCurrent:api.isCurrent});assertCurrent(current);
   for(const copy of copyRef.current){let changed=false;const pages=copy.pages.map(page=>{if(page.ownerId!==userId||page.apiOrigin!==origin||!page.jobs.some(j=>j.id===job.id))return page;changed=true;return {...page,outputBlobs:{...page.outputBlobs,[job.id]:key},translationError:undefined};});if(changed)commit({...copy,pages});}
 },[api,userId,origin,commit]);
 useEffect(()=>{stamp.current++;if(!currentId){windowRef.current.update([]);visible.current=[];wake.current();}},[currentId,language]);
 useEffect(()=>{
   setError('');
   if(!scope||!userId){jobs.current=[];setOperations([]);return;}
   let stopped=false,running=false,wakePending=false,timer:ReturnType<typeof setTimeout>|undefined,watching=false;
   let watchController=new AbortController(),retry=0;
   const live=()=>!stopped&&api.isCurrent();
   const reload=()=>{void readOperations(scope).then(records=>{if(live())setOperations(records);});};
   const core=new TranslationCoordinator({api,userId,language,sessionId:readingSessionSlot(scope),getBlob:libraryStore.getBlob,rights:()=>config.current.rights??undefined,onJobs:attach,onChange:()=>{reload();wake.current();},onPolicy:value=>{config.current.rights=value;config.current.onPolicy?.(value);}});
   coordinator.current=core;
   async function downloads(){
     const generation=stamp.current,current=()=>live()&&generation===stamp.current;
     // Download ahead even in single-page mode; decoding remains viewport bounded.
     const wanted=[...visible.current,...windowRef.current.targets.map(t=>t.page)];
     const pages=[...new Map(wanted.map(p=>[p.id,copyRef.current.flatMap(c=>c.pages).find(v=>v.id===p.id)??p])).values()];
     const needed=[...new Map(pages.flatMap(p=>p.ownerId===userId&&p.apiOrigin===origin?latestResults(p.jobs).filter(j=>j.target_language===language&&j.output_asset_id&&!p.outputBlobs[j.id]):[]).map(j=>[j.id,j])).values()];
     await Promise.allSettled([
       ...needed.map(async job=>{try{await downloadResult(job,current);}catch(e){if(current())for(const copy of copyRef.current){if(copy.pages.some(p=>p.jobs.some(j=>j.id===job.id)))commit({...copy,pages:copy.pages.map(p=>p.jobs.some(j=>j.id===job.id)?{...p,translationError:(e as Error).message}:p)});}}}),
       ...pages.filter(p=>!p.blobKey&&p.assetId&&p.ownerId===userId&&p.apiOrigin===origin).map(async page=>{try{const key=page.imageSha256?'original:'+page.imageSha256:'original:'+origin+':'+userId+':'+page.assetId;const blob=await libraryStore.getBlob(key)??await api.image(page.assetId!);assertCurrent(current);await libraryStore.putBlob(key,blob);assertCurrent(current);for(const copy of copyRef.current)if(copy.pages.some(p=>p.id===page.id))commit({...copy,pages:copy.pages.map(p=>p.id===page.id?{...p,blobKey:key,fetchError:undefined}:p)});}catch{/* Preserve the reader's original recovery action. */}}),
     ]);
   }
   const schedule=(delay=0)=>{clearTimeout(timer);if(live()&&!document.hidden&&navigator.onLine!==false)timer=setTimeout(()=>void tick(),Math.max(0,delay));};
   async function tick(){
     if(running){wakePending=true;return;}if(!live()||document.hidden||navigator.onLine===false)return;
     running=true;wakePending=false;let pendingPrefetch=false;
     try{
       const now=performance.now(),window=windowRef.current;
       if(window.targets.length&&now<window.readyAt){schedule(window.readyAt-now);return;}
       const targets=window.ready().map(t=>({...t,page:copyRef.current.find(c=>c.id===t.copyId)?.pages.find(p=>p.id===t.page.id)??t.page}));
       if(targets.length&&(!config.current.caps||!config.current.rights))return;
       const generation=stamp.current;await core.recover();await core.plan(targets.filter(t=>config.current.caps?.modes.find(m=>m.id===t.mode)?.enabled&&supportsLanguage(config.current.caps,t.mode,language)),false,()=>live()&&!document.hidden&&generation===stamp.current);
       pendingPrefetch=targets.length<window.targets.length;
       setError('');retry=0;void downloads();
     }catch(e){if(live()){setError((e as Error).message);retry=Math.min(30000,Math.max(1000,retry*2));}}
     finally{running=false;if(live()){const prefetch=windowRef.current.prefetchAt-performance.now();if(wakePending)schedule();else if(pendingPrefetch||prefetch>0)schedule(Math.max(0,prefetch));else if(core.retryDelay>0)schedule(core.retryDelay);else if(retry)schedule(retry);}}
   }
   async function watch(){
     if(watching||document.hidden||!live()||!windowRef.current.targets.length||navigator.onLine===false)return;watching=true;const signal=watchController.signal;let failures=0;
     try{while(live()&&!document.hidden&&windowRef.current.targets.length&&!signal.aborted){
       try{const policy=core.state.policyRevision;const changes=await core.wait(signal);failures=0;if(!live()||signal.aborted)return;void downloads();if(policy!==core.state.policyRevision)schedule();if(changes?.has_more)continue;}
       catch(e){if(!live()||signal.aborted)return;setError((e as Error).message);const delay=e instanceof ApiError&&e.retryAfterSeconds?e.retryAfterSeconds*1000:Math.min(30000,1000*2**failures++);await new Promise<void>(resolve=>{const t=setTimeout(resolve,delay+Math.random()*100);signal.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});});}
     }}finally{watching=false;if(live()&&!document.hidden&&windowRef.current.targets.length&&signal!==watchController.signal)void watch();}
   }
   async function foreground(){if(!live())return;if(document.hidden){watchController.abort();clearTimeout(timer);return;}if(watchController.signal.aborted)watchController=new AbortController();schedule();void watch();if(core.session.sequence)void core.renew([...new Set(windowRef.current.targets.map(t=>t.mode))]).catch(()=>{});}
   const lease=setInterval(()=>{if(live()&&!document.hidden&&windowRef.current.targets.length)void core.renew([...new Set(windowRef.current.targets.map(t=>t.mode))]).catch(()=>{});},30000);
   wake.current=()=>{schedule();if(!windowRef.current.targets.length){watchController.abort();return;}if(watchController.signal.aborted)watchController=new AbortController();void watch();};
   document.addEventListener('visibilitychange',foreground);window.addEventListener('online',foreground);window.addEventListener('focus',foreground);
   void core.init().then(async()=>{if(!live())return;await core.recover();reload();schedule();void watch();}).catch(e=>{if(live()){setError(e.message);schedule(1000);void watch();}});
   return()=>{stopped=true;watchController.abort();clearTimeout(timer);clearInterval(lease);wake.current=()=>{};coordinator.current=undefined;document.removeEventListener('visibilitychange',foreground);window.removeEventListener('online',foreground);window.removeEventListener('focus',foreground);};
 },[scope,api,userId,origin,language,attach,commit,downloadResult]);
 useEffect(()=>{if(!userId)return;for(const copy of copies){const changed=applyAccountJobs(copy,jobs.current,userId,origin);if(changed!==copy)commit(changed);}},[copies,userId,origin,commit]);
 const previousRights=useRef<string|undefined>(undefined);
 useEffect(()=>{if(!rights)return;const signature=JSON.stringify([rights.modes,rights.plan,rights.image_rate_limit]);if(previousRights.current&&signature!==previousRights.current)void coordinator.current?.refreshPolicy(rights).then(()=>wake.current());else if(!previousRights.current)wake.current();previousRights.current=signature;},[rights]);
 useEffect(()=>{if(caps)wake.current();},[caps]);
 const onReadingWindow=useCallback((targets:ReadingTarget[],visiblePages:Page[],immediate=false)=>{const changed=windowRef.current.update(targets,performance.now(),immediate);const imagesChanged=JSON.stringify(visible.current.map(p=>[p.id,p.blobKey]))!==JSON.stringify(visiblePages.map(p=>[p.id,p.blobKey]));visible.current=visiblePages;if(changed||imagesChanged){stamp.current++;render(n=>n+1);wake.current();}},[]);
 const retry=useCallback(async(copyId:string,page:Page,mode:Mode)=>{if(!userId||!coordinator.current)throw Error(msg("请先登录"));const latest=pageTranslation(page,mode,language,userId,origin);if(latest.result?.output_asset_id&&!latest.ready&&!latest.expired&&latest.latest?.status==='succeeded'){await downloadResult(latest.result);return;}const rights=await (refreshConfiguration?refreshConfiguration():api.entitlements());await coordinator.current.refreshPolicy(rights);await coordinator.current.manual({copyId,page,mode});wake.current();},[api,userId,origin,language,refreshConfiguration,downloadResult]);
 function stateFor(copyId:string,page:Page,mode:Mode):TranslationState|undefined {const target={copyId,page,mode};return translationState({page,mode,language,userId,origin,active:windowRef.current.targets.some(t=>t.copyId===copyId&&t.page.id===page.id&&t.mode===mode),caps,rights,error,operation:operations.find(o=>o.id===operationId(scope,language,target))});}
 return {onReadingWindow,stateFor,retry};
}
