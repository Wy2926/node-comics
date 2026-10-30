import {LOCAL_HOST_MESSAGE,LOCAL_HOST_PATH} from './host-client';

let fallback:Promise<void>|undefined;
const contexts=()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL(LOCAL_HOST_PATH)]});
const ready=()=>chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'ping'}).then(value=>value?.ready as boolean|undefined).catch(()=>undefined);
/** Also callable by the service worker, whose messages cannot reach its own listeners. */
export async function ensureLocalHost(){
  await navigator.locks.request('nc-local-host-lifecycle',async()=>{
    if(!chrome.offscreen){
      if(typeof document==='undefined')throw Error('LOCAL_HOST_UNAVAILABLE');
      fallback??=import('./local-host').then(({registerLocalHost})=>{registerLocalHost(async()=>{});}).catch(error=>{fallback=undefined;throw error;});
      await fallback;return;
    }
    const existing=await contexts();
    if(existing.length){
      if(await ready()===true)return;
      await chrome.offscreen.closeDocument();
    }
    await chrome.offscreen.createDocument({url:LOCAL_HOST_PATH,reasons:['WORKERS','BLOBS','LOCAL_STORAGE'],justification:'Run user-configured translation workers, URL rules and model downloads without opening a tab.'});
  });
}
/** Owns the browser document lifecycle, never model execution or translation scheduling. */
export function registerLocalHostBackground(){
  chrome.runtime.onMessage.addListener((request,sender,reply)=>{
    if(request?.type!==LOCAL_HOST_MESSAGE||!['ensure','close'].includes(request.action)||sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('/')))return;
    void (request.action==='ensure'?ensureLocalHost():navigator.locks.request('nc-local-host-lifecycle',async()=>{
      if(!chrome.offscreen)return;
      const existing=await contexts();
      // Offscreen senders may omit documentId. Recheck the current host under
      // the lifecycle lock so an old close cannot interrupt a ready replacement.
      if(sender.url===chrome.runtime.getURL(LOCAL_HOST_PATH)&&existing.length&&await ready()===false)await chrome.offscreen.closeDocument();
    })).then(()=>reply({ok:true}),error=>reply({ok:false,error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_HOST_UNAVAILABLE'}));
    return true;
  });
}
