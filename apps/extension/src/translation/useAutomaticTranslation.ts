import {useCallback,useEffect,useRef,useState} from 'react';
import {acquirePage} from '../comics/pages/service';
import {readImage} from '../comics/application/image-access';
import {msg} from '../i18n/runtime';
import {supportsLanguage,type Job,type Mode,type Page,type ReadingEntry} from '../types';
import {mergeJobs} from '../reader/jobs';
import {latestResults,pageTranslation} from '../reader/presentation';
import {assertCurrent} from '../concurrency';
import {resultBlobKey,registerResultReader,assertResult} from '../storage/translations/results';
import {applyChannelJobs} from './sync';
import type {ChannelConnection,ChannelRuntime} from './channels/contracts';
import {targetKey,type ReadingTarget,type TranslationState} from './automatic';
import {ReadingWindow} from '../reading-window';
import {TranslationResultPrefetch} from './result-prefetch';

interface Options {
  channel?:ChannelConnection;connectionError?:string;copies:ReadingEntry[];
  updateEntry:(copy:ReadingEntry)=>void;language:string;currentId?:string;
}
export function useAutomaticTranslation({channel,connectionError='',copies,updateEntry,language,currentId}:Options){
  const [,render]=useState(0),[error,setError]=useState('');
  const copyRef=useRef(copies);copyRef.current=copies;
  const jobs=useRef<Job[]>([]),windowRef=useRef(new ReadingWindow<ReadingTarget>(t=>targetKey(t.entryId,t.page,t.mode))),visible=useRef<Page[]>([]);
  const runtime=useRef<ChannelRuntime|undefined>(undefined),wake=useRef<()=>void>(()=>{}),stamp=useRef(0);
  const resultReaders=useRef(new Map<string,()=>void>());
  const commit=useCallback((copy:ReadingEntry)=>{copyRef.current=copyRef.current.map(c=>c.id===copy.id?copy:c);updateEntry(copy);},[updateEntry]);
  const attach=useCallback(async(incoming:Job[])=>{
    if(!channel?.isCurrent())return;
    jobs.current=mergeJobs(jobs.current,incoming);
    for(const copy of copyRef.current){const changed=applyChannelJobs(copy,incoming,channel.scope);if(changed!==copy)commit(changed);}
  },[channel,commit]);
  const prepareResult=useCallback(async(job:Job,current=()=>channel?.isCurrent()===true)=>{
    if(!channel)return;
    assertResult({scope:channel.scope,job,isCurrent:current});
    const key=resultBlobKey(channel.scope,job);
    // Publish identity independently of bytes so original display never waits for prefetch.
    await channel.validateResult();assertCurrent(current);
    resultReaders.current.set(key,registerResultReader(channel.scope,job,
      signal=>channel.readResult(job,signal,async()=>{
        for(const copy of copyRef.current){
          const page=copy.pages.find(page=>page.translationScope===channel.scope.key&&page.jobs.some(value=>value.id===job.id));
          if(page)return page.blobKey?readImage(page.blobKey,signal):undefined;
        }
      }),
      async()=>{
        const latest=jobs.current.find(value=>value.id===job.id)??job;
        assertResult({scope:channel.scope,job:latest,isCurrent:()=>channel.isCurrent()&&latest.result?.key===job.result?.key});
        await channel.validateResult();
      }));
    for(const copy of copyRef.current){let changed=false;const pages=copy.pages.map(page=>{
      if(page.translationScope!==channel.scope.key||!page.jobs.some(j=>j.id===job.id))return page;
      changed=true;return {...page,outputBlobs:{...page.outputBlobs,[job.id]:key},translationError:undefined};
    });if(changed)commit({...copy,pages});}
  },[channel,commit]);
  useEffect(()=>{stamp.current++;if(!currentId){windowRef.current.update([]);visible.current=[];wake.current();}},[currentId,language]);
  // Delivered results belong to the channel, not its language-specific runtime.
  useEffect(()=>{
    jobs.current=[];
    return()=>{for(const release of resultReaders.current.values())release();resultReaders.current.clear();};
  },[channel]);
  useEffect(()=>{
    setError('');
    if(!channel?.available)return;
    let stopped=false,running=false,wakePending=false,watching=false,pendingPrefetch=false,retry=0,watchedWindow='',submittedWindow='';
    let watchedIds=new Set<string>();
    let timer:ReturnType<typeof setTimeout>|undefined,watchController=new AbortController();
    const live=()=>!stopped&&channel.isCurrent();
    const online=()=>!channel.requiresInternet||navigator.onLine!==false;
    const resultPrefetch=new TranslationResultPrefetch();
    function prefetchResults(){
      resultPrefetch.update(live()&&!document.hidden&&online()?windowRef.current.targets.flatMap(target=>{
        const page=copyRef.current.find(copy=>copy.id===target.entryId)?.pages.find(page=>page.id===target.page.id)??target.page;
        const job=pageTranslation(page,target.mode,language,channel!.scope.key).result;
        if(!job?.result||job.result_expired||job.result_available===false)return [];
        const key=resultBlobKey(channel!.scope,job);
        return resultReaders.current.has(key)?[key]:[];
      }):[]);
    }
    const core=channel.createRuntime({language,getBlob:readImage,readOriginal:ref=>acquirePage({...ref,purpose:'translation'}),isCurrent:live,onJobs:attach,onChange:()=>{if(live()){render(n=>n+1);wake.current();}}});
    runtime.current=core;
    async function prepareResults(){
      prefetchResults();
      const generation=stamp.current,current=()=>live()&&generation===stamp.current;
      const wanted=[...visible.current,...windowRef.current.targets.map(t=>t.page)];
      const currentPages=copyRef.current.flatMap(copy=>copy.pages);
      const pages=[...new Map(wanted.map(p=>[p.id,currentPages.find(v=>v.id===p.id)??p])).values()];
      const needed=[...new Map(pages.flatMap(p=>p.translationScope===channel!.scope.key?latestResults(p.jobs).filter(j=>j.target_language===language&&j.result&&(!p.outputBlobs[j.id]||!resultReaders.current.has(resultBlobKey(channel!.scope,j)))):[]).map(j=>[j.id,j])).values()];
      const retained=new Set(pages.flatMap(p=>p.jobs.map(job=>resultBlobKey(channel!.scope,job))));
      const removed=new Set<string>();
      for(const [key,release] of resultReaders.current)if(!retained.has(key)){release();resultReaders.current.delete(key);removed.add(key);}
      if(removed.size)for(const copy of copyRef.current){let changed=false;const pages=copy.pages.map(page=>{
        const refs=Object.entries(page.outputBlobs);if(!refs.some(([,key])=>removed.has(key)))return page;
        changed=true;return {...page,outputBlobs:Object.fromEntries(refs.filter(([,key])=>!removed.has(key)))};
      });if(changed)commit({...copy,pages});}
      await Promise.allSettled(needed.map(async job=>{
        try{await prepareResult(job,current);if(current())prefetchResults();}catch(e){if(current())for(const copy of copyRef.current){if(copy.pages.some(p=>p.jobs.some(j=>j.id===job.id)))commit({...copy,pages:copy.pages.map(p=>p.jobs.some(j=>j.id===job.id)?{...p,translationError:(e as Error).message}:p)});}}
      }));
    }
    const schedule=(delay=0)=>{clearTimeout(timer);if(live()&&!document.hidden&&online())timer=setTimeout(()=>void tick(),Math.max(0,delay));};
    async function tick(){
      if(running){wakePending=true;return;}if(!live()||document.hidden||!online())return;
      running=true;wakePending=false;
      try{
        const window=windowRef.current,now=performance.now();
        if(window.targets.length&&now<window.readyAt){schedule(window.readyAt-now);return;}
        const targets=window.ready().map(t=>({...t,page:copyRef.current.find(c=>c.id===t.entryId)?.pages.find(p=>p.id===t.page.id)??t.page}));
        const generation=stamp.current,caps=channel!.capabilities,signature=JSON.stringify(window.targets.map(t=>[t.entryId,t.page.id,t.mode]));
        pendingPrefetch=targets.length<window.targets.length;
        await core.submit(targets.filter(t=>caps.modes.some(m=>m.id===t.mode&&m.enabled)&&supportsLanguage(caps,t.mode,language)),()=>live()&&!document.hidden&&generation===stamp.current);
        if(generation===stamp.current)submittedWindow=signature;
        setError('');retry=0;void prepareResults();
      }catch(e){if(live()){setError((e as Error).message);retry=Math.min(30000,Math.max(1000,retry*2));}}
      finally{running=false;if(live()){void watch();const delay=windowRef.current.prefetchAt-performance.now();if(wakePending)schedule();else if(pendingPrefetch||delay>0)schedule(Math.max(0,delay));else if(core.retryDelay>0)schedule(core.retryDelay);else if(retry)schedule(retry);}}
    }
    async function watch(){
      if(running||watching||pendingPrefetch||submittedWindow!==watchedWindow||document.hidden||!live()||!windowRef.current.targets.length||!core.hasPending||!online())return;
      watching=true;const signal=watchController.signal;let failures=0;
      try{while(live()&&!document.hidden&&windowRef.current.targets.length&&!signal.aborted){
        try{const waiting=await core.wait(signal);failures=0;if(!live()||signal.aborted)return;void prepareResults();if(!waiting||!core.hasPending)break;}
        catch(e){if(!live()||signal.aborted)return;setError((e as Error).message);const delay=Math.max(core.retryDelay,Math.min(30000,1000*2**failures++));await new Promise<void>(resolve=>{const done=()=>{clearTimeout(t);signal.removeEventListener('abort',done);resolve();};const t=setTimeout(done,delay);signal.addEventListener('abort',done,{once:true});});}
      }}finally{watching=false;if(live()&&!document.hidden&&windowRef.current.targets.length&&signal!==watchController.signal)void watch();}
    }
    async function foreground(){
      if(!live())return;
      if(document.hidden||!online()){resultPrefetch.dispose();watchController.abort();clearTimeout(timer);return;}
      if(watchController.signal.aborted)watchController=new AbortController();schedule();void watch();
      try{await core.refresh();if(live()){render(n=>n+1);schedule();}}catch{/* The runtime reports connection errors per image. */}
    }
    wake.current=()=>{
      const key=JSON.stringify(windowRef.current.targets.map(t=>[t.entryId,t.page.id,t.mode]));
      if(key!==watchedWindow||core.waitingIds.some(id=>!watchedIds.has(id))){watchedWindow=key;submittedWindow='';watchedIds=new Set(core.waitingIds);watchController.abort();watchController=new AbortController();}
      void prepareResults();schedule();if(!windowRef.current.targets.length){watchController.abort();return;}
      if(watchController.signal.aborted)watchController=new AbortController();void watch();
    };
    document.addEventListener('visibilitychange',foreground);window.addEventListener('online',foreground);window.addEventListener('offline',foreground);window.addEventListener('focus',foreground);
    void core.init().then(()=>{if(live()){render(n=>n+1);void prepareResults();schedule();void watch();}}).catch(e=>{if(live())setError(e.message);});
    return()=>{stopped=true;resultPrefetch.dispose();watchController.abort();clearTimeout(timer);core.dispose();wake.current=()=>{};runtime.current=undefined;document.removeEventListener('visibilitychange',foreground);window.removeEventListener('online',foreground);window.removeEventListener('offline',foreground);window.removeEventListener('focus',foreground);};
  },[channel,language,attach,commit,prepareResult]);
  useEffect(()=>{if(!channel)return;for(const copy of copies){const changed=applyChannelJobs(copy,jobs.current,channel.scope);if(changed!==copy)commit(changed);}},[copies,channel,commit]);
  const onReadingWindow=useCallback((targets:ReadingTarget[],visiblePages:Page[],immediate=false)=>{
    const changed=windowRef.current.update(targets,performance.now(),immediate),imagesChanged=JSON.stringify(visible.current.map(p=>[p.id,p.blobKey]))!==JSON.stringify(visiblePages.map(p=>[p.id,p.blobKey]));
    visible.current=visiblePages;if(changed||imagesChanged){stamp.current++;render(n=>n+1);wake.current();}
  },[]);
  const retry=useCallback(async(entryId:string,page:Page,mode:Mode)=>{
    if(!channel?.available||!runtime.current)throw Error(channel?.unavailable?.message??msg('正在连接翻译服务'));
    const latest=pageTranslation(page,mode,language,channel.scope.key);
    if(latest.result?.result?.recoverable&&!latest.ready&&!latest.expired&&latest.latest?.status==='succeeded'){await prepareResult(latest.result);return;}
    await runtime.current.manual({entryId,page,mode});wake.current();
  },[channel,language,prepareResult]);
  function stateFor(entryId:string,page:Page,mode:Mode):TranslationState|undefined {
    const active=windowRef.current.targets.some(t=>t.entryId===entryId&&t.page.id===page.id&&t.mode===mode);
    if(!channel)return active?{kind:connectionError?'error':'waiting',message:connectionError||msg('准备翻译…')}:undefined;
    if(!channel.available)return active?channel.unavailable:undefined;
    return runtime.current?.stateFor({entryId,page,mode},active,error);
  }
  return {onReadingWindow,stateFor,retry};
}
