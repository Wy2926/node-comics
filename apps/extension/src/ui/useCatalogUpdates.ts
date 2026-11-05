import {useCallback,useEffect,useRef,useState} from 'react';
import {checkCatalogUpdates} from '../comics/application/catalog-sync';
import {msg} from '../i18n/runtime';

/** One non-blocking check at a time, independent of reader navigation/loading state. */
export function useCatalogUpdates(comicId:string|undefined, enabled:boolean, notify:(message:string,tone?:'info'|'error'|'success')=>void) {
  const active=useRef<{comicId:string;manual:boolean;controller:AbortController}|undefined>(undefined);
  const [checkingId,setCheckingId]=useState<string>();
  const check=useCallback(async(id:string,manual=true)=>{
    if(active.current){if(manual)notify(msg('正在检查更新…'),'info');return;}
    const task={comicId:id,manual,controller:new AbortController()};
    active.current=task;setCheckingId(id);
    try{
      const result=await checkCatalogUpdates(id,{manual,signal:task.controller.signal});
      if(manual&&!task.controller.signal.aborted){
        if(result.status==='checked')notify(result.hasUpdates?msg('发现新章节，已更新目录。'):msg('已检查，暂无新章节。'));
        else if(result.status==='busy')notify(msg('正在检查更新…'),'info');
        else if(result.status==='unavailable')notify(msg('检查更新失败，已保留原目录，请稍后重试。'),'error');
      }
    }catch{
      if(manual&&!task.controller.signal.aborted)notify(msg('检查更新失败，已保留原目录，请稍后重试。'),'error');
    }finally{
      if(active.current===task){active.current=undefined;setCheckingId(undefined);}
    }
  },[notify]);
  useEffect(()=>{
    if(!enabled||!comicId)return;
    let attempted=false,timer:ReturnType<typeof setTimeout>|undefined;
    const cancel=()=>{
      clearTimeout(timer);
      const task=active.current;
      if(task&&!task.manual&&task.comicId===comicId)task.controller.abort();
    };
    const schedule=()=>{
      cancel();
      if(attempted||document.visibilityState==='hidden')return;
      // Let the reader open first. No due-time timer, shelf scan, or periodic polling.
      timer=setTimeout(()=>{attempted=true;void check(comicId,false);},2000);
    };
    schedule();document.addEventListener('visibilitychange',schedule);
    return()=>{cancel();document.removeEventListener('visibilitychange',schedule);};
  },[comicId,enabled,check]);
  useEffect(()=>()=>{active.current?.controller.abort();active.current=undefined;},[]);
  return {checkingId,check};
}
