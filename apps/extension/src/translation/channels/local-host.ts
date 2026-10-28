import {channelDefinition} from './registry';
import {LOCAL_HOST_MESSAGE} from './host-client';
import type {ChannelLocalHost} from './contracts';
export function registerLocalHost(changed:(busy:boolean)=>void){
  const hosts=new Map<string,Promise<ChannelLocalHost>>();
  const active=new Set<string>();
  let closing=false,pendingRequests=0;
  let timer:ReturnType<typeof setTimeout>;
  const idle=()=>{
    clearTimeout(timer);
    if(active.size||pendingRequests||closing)return;
    timer=setTimeout(()=>{closing=true;void Promise.allSettled([...hosts.values()].map(async pending=>(await pending).dispose())).then(()=>chrome.tabs.getCurrent()).then(tab=>tab?.id===undefined?undefined:chrome.tabs.remove(tab.id));},60_000);
  };
  chrome.runtime.onMessage.addListener((request,sender,reply)=>{
    if(request?.type!==LOCAL_HOST_MESSAGE||sender.id!==chrome.runtime.id||(sender.url?!sender.url.startsWith(chrome.runtime.getURL('/')):sender.tab!==undefined))return;
    if(request.action==='ping'){reply({ready:!closing});idle();return;}
    if(request.action!=='dispatch'||typeof request.adapterId!=='string')return;
    if(closing){reply({ok:false,error:'LOCAL_HOST_UNAVAILABLE'});return;}
    pendingRequests++;
    clearTimeout(timer);
    void (async()=>{
      const definition=channelDefinition(request.adapterId);
      if(!definition.startLocalHost)throw Error('UNSUPPORTED_HOST');
      let pending=hosts.get(definition.id);
      if(!pending){
        pending=definition.startLocalHost(busy=>{busy?active.add(definition.id):active.delete(definition.id);changed(active.size>0);idle();});
        hosts.set(definition.id,pending);
        void pending.catch(()=>hosts.delete(definition.id));
      }
      const host=await pending;return host.dispatch(request.message);
    })().then(value=>reply({ok:true,value}),error=>reply({ok:false,error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_HOST_UNAVAILABLE'})).finally(()=>{pendingRequests--;idle();});
    return true;
  });
  idle();
  return async()=>{for(const pending of hosts.values())await (await pending).dispatch({action:'stop'});};
}
