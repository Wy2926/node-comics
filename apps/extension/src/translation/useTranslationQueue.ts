import {useCallback,useEffect,useRef,useState} from 'react';
import {Api,ApiError} from '../api';
import type {Job,Mode,ModeQueue,Page,ReadingCopy} from '../types';
import {mergeJobs} from '../reader/jobs';
import {latestResults} from '../reader/presentation';
import {assertCurrent,mapConcurrent} from '../concurrency';
import * as libraryStore from '../library/store';
import {applyAccountJobs,readingPriority} from './sync';
import {processManifest} from './processor';
import {readManifests,saveManifest,setManifestPaused,readSync,saveSync,translationScope,type UploadManifest} from './store';

export function useTranslationQueue({api,userId,origin,copies,updateCopy,concurrency,language,currentId}:{api:Api;userId?:string;origin:string;copies:ReadingCopy[];updateCopy:(copy:ReadingCopy)=>void;concurrency:number;language:string;currentId?:string}){
 const [queues,setQueues]=useState<ModeQueue[]>([]),[jobs,setJobs]=useState<Job[]>([]),[manifests,setManifests]=useState<UploadManifest[]>([]),[error,setError]=useState(''),[priorityStatus,setPriorityStatus]=useState('');
 const scope=userId?translationScope(origin,userId):'',copyRef=useRef(copies);copyRef.current=copies;
 const commitCopy=useCallback((copy:ReadingCopy)=>{copyRef.current=copyRef.current.map(value=>value.id===copy.id?copy:value);updateCopy(copy);},[updateCopy]);
 const jobsRef=useRef(jobs);jobsRef.current=jobs;const queueRef=useRef(queues);queueRef.current=queues;
 const reading=useRef<Page[]>([]),visible=useRef<Page[]>([]),readingSignature=useRef(''),generation=useRef(0),wake=useRef(()=>{}),takeover=useRef(false);
 const session=useRef(crypto.randomUUID()),sequence=useRef(0),lastPriority=useRef('');
 const reload=useCallback(async()=>{if(!scope)return;const records=await readManifests(scope);if(api.isCurrent())setManifests(records.sort((a,b)=>b.createdAt-a.createdAt));},[scope,api]);
 const attach=useCallback(async(incoming:Job[])=>{
  if(!api.isCurrent()||!userId)return;
  jobsRef.current=mergeJobs(jobsRef.current,incoming);setJobs(jobsRef.current);
  for(const copy of copyRef.current){const updated=applyAccountJobs(copy,incoming,userId,origin);if(updated!==copy)commitCopy(updated);}
 },[api,userId,origin,commitCopy]);
 const refresh=useCallback(async()=>{if(!scope)return;const data=await api.queues();if(api.isCurrent()){queueRef.current=data.items;setQueues(data.items);}await reload();},[scope,api,reload]);
 useEffect(()=>{
  ++generation.current;reading.current=[];visible.current=[];readingSignature.current='';setPriorityStatus('');lastPriority.current='';
 },[currentId,language]);
 useEffect(()=>{
  if(!scope){setQueues([]);setJobs([]);jobsRef.current=[];setManifests([]);return;}
  let stopped=false,timer:ReturnType<typeof setTimeout>,running=false,syncing=false,backgroundState=false;let cursor:string|undefined;let retryAt=0;
  const live=()=>!stopped&&api.isCurrent();
  const focus=()=>{takeover.current=true;lastPriority.current='';wake.current();};window.addEventListener('focus',focus);
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
   if(document.hidden||!reading.current.length)return;
   const local=await readManifests(scope);
   for(const queue of queueRef.current){
    const planned=readingPriority(reading.current,jobsRef.current,queue.mode,language,queue.realtime_limit);
    const nearby=new Set(reading.current.slice(0,queue.realtime_limit).map(p=>p.id));
    const reserve=local.some(m=>m.mode===queue.mode&&m.language===language&&!m.paused&&m.items.some(i=>i.state==='local'&&nearby.has(i.pageId)));
    if(!planned.ordered_job_ids.length&&!queue.realtime_count&&!reserve)continue;
    const signature=JSON.stringify([queue.mode,planned,queue.version,reserve]);
    if(lastPriority.current===signature&&!takeover.current)continue;
    try{
     const value=await api.priority(queue.mode,{...planned,session_id:session.current,sequence:++sequence.current,expected_version:queue.version,ttl_seconds:90,takeover:takeover.current,reserve_next_upload:reserve});assertCurrent(live);
     queue.version=value.version;lastPriority.current=JSON.stringify([queue.mode,planned,value.version,reserve]);
     setPriorityStatus(value.realtime_job_ids.length?`实时阅读优先 · ${value.realtime_job_ids.length} / ${queue.realtime_limit} 页`:'当前页为预存翻译');
    }catch(e){if(e instanceof ApiError&&['QUEUE_VERSION_CONFLICT','PRIORITY_CONFLICT','STALE_PRIORITY','READING_SESSION_ACTIVE'].includes(e.code))setPriorityStatus(e.code==='QUEUE_VERSION_CONFLICT'?'队列已更新，正在合并当前阅读顺序':'另一阅读会话正在控制优先级；点击接管后更新');else throw e;}
   }
   takeover.current=false;
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
   clearTimeout(timer);if(running||!live())return;running=true;
   try{
    if(Date.now()<retryAt)return;
    await sync();await refresh();assertCurrent(live);
    await priorities();
    const records=await readManifests(scope);
    for(const mode of ['classic','redraw'] as const){
     let queue=queueRef.current.find(q=>q.mode===mode);if(!queue)continue;
     // Existing uncertain/uploading batches recover first. New batches borrow only current server space.
     const nearest=new Set(reading.current.slice(0,queue.realtime_limit).map(p=>p.id));
     const urgent=(m:UploadManifest)=>m.items.some(i=>i.state==='local'&&nearest.has(i.pageId));
     const candidates=records.filter(m=>m.mode===mode&&!m.paused&&(m.pending||m.items.some(i=>i.state==='local'))).sort((a,b)=>Number(!!b.pending)-Number(!!a.pending)||Number(urgent(b))-Number(urgent(a))||a.createdAt-b.createdAt);
     for(const manifest of candidates){
      const reserved=queue.upload_reserved&&queue.upload_reservation_session_id===session.current&&urgent(manifest)?1:0;
      if(!manifest.pending&&queue.available_slots+reserved<=0)continue;
      await processManifest({api,manifest,available:queue.available_slots+reserved,readingPageIds:reading.current.map(p=>p.id),readingSessionId:session.current,concurrency,getBlob:libraryStore.getBlob,onJobs:async incoming=>{await attach(incoming);await priorities();},onChange:()=>{void reload();}});
      assertCurrent(live);await refresh();
      queue=queueRef.current.find(q=>q.mode===mode)!;
     }
    }
    await downloadVisible();retryAt=0;setError('');
   }catch(e){if(live()){setError((e as Error).message);retryAt=Date.now()+8000;}}
   finally{running=false;if(live())timer=setTimeout(()=>{lastPriority.current='';void tick();},document.hidden?12000:4000);}
  }
  wake.current=()=>{if(!running){clearTimeout(timer);timer=setTimeout(()=>void tick(),250);}};
  // A large upload manifest must not prevent already-finished current pages from appearing.
  const stateTimer=setInterval(()=>{if(!running||backgroundState||!live())return;backgroundState=true;void(async()=>{try{await sync();await refresh();await priorities();await downloadVisible();}catch(e){if(live())setError((e as Error).message);}finally{backgroundState=false;}})();},4000);
  void readSync(scope).then(async saved=>{if(!live())return;jobsRef.current=[];cursor=saved?.cursor;await attach(saved?.jobs??[]);await reload();void tick();}).catch(e=>setError(e.message));
  return()=>{stopped=true;clearTimeout(timer);clearInterval(stateTimer);wake.current=()=>{};window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visibility);};
 },[scope,api,attach,refresh,reload,concurrency,language]);
 // A newly imported copy can bind account records even when no new server event is emitted.
 useEffect(()=>{if(!userId)return;for(const copy of copies){const updated=applyAccountJobs(copy,jobsRef.current,userId,origin);if(updated!==copy)commitCopy(updated);}},[copies,userId,origin,commitCopy]);
 const onReadingWindow=useCallback((pages:Page[],visiblePages:Page[])=>{reading.current=pages;visible.current=visiblePages;const signature=JSON.stringify([pages.map(p=>p.id),visiblePages.map(p=>[p.id,p.blobKey])]);if(signature!==readingSignature.current){readingSignature.current=signature;++generation.current;wake.current();}},[]);
 const addManifest=useCallback(async(manifest:UploadManifest)=>{await saveManifest({...manifest,readingSessionId:session.current});await reload();takeover.current=true;wake.current();},[reload]);
 const toggleManifest=useCallback(async(id:string,paused:boolean)=>{await setManifestPaused(id,paused);await reload();wake.current();},[reload]);
 const pauseQueue=useCallback(async(mode:Mode,paused:boolean)=>{await api.pauseQueue(mode,paused);await refresh();wake.current();},[api,refresh]);
 const claimReading=useCallback(()=>{takeover.current=true;lastPriority.current='';wake.current();},[]);
 return {queues,jobs,manifests,error,priorityStatus,onReadingWindow,addManifest,toggleManifest,pauseQueue,claimReading,refresh};
}
