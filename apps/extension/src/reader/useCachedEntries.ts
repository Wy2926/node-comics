import {useEffect,useState} from 'react';
import {cachedEntryIds,subscribeCachedEntries} from '../comics/application/offline-entries';

export function useCachedEntries(comicId:string|undefined,entryIds:readonly string[]){
  const key=JSON.stringify(entryIds),[cached,setCached]=useState(new Set<string>());
  useEffect(()=>{
    const ids=JSON.parse(key) as string[],pending=new Set(ids);
    let stopped=false,loading=false,timer:ReturnType<typeof setTimeout>|undefined;
    setCached(new Set());
    const refresh=async()=>{
      timer=undefined;if(stopped||loading||!pending.size)return;
      loading=true;const batch=[...pending];pending.clear();
      const complete=await cachedEntryIds(batch).catch(()=>new Set<string>());
      if(!stopped)setCached(previous=>{
        const next=new Set(previous);for(const id of batch)next.delete(id);for(const id of complete)next.add(id);
        return next.size===previous.size&&[...next].every(id=>previous.has(id))?previous:next;
      });
      loading=false;if(!stopped&&pending.size)timer=setTimeout(()=>void refresh(),500);
    };
    const unsubscribe=subscribeCachedEntries(comicId,ids,changed=>{
      for(const id of changed)pending.add(id);
      if(pending.size&&!loading&&!timer)timer=setTimeout(()=>void refresh(),500);
    });
    void refresh();
    return()=>{stopped=true;clearTimeout(timer);unsubscribe();};
  },[comicId,key]);
  return cached;
}
