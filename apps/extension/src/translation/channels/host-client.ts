export const LOCAL_HOST_MESSAGE='NC_LOCAL_TRANSLATION_HOST';
const hostPath='/local-translation-host.html';
const extension=()=>typeof chrome!=='undefined'&&!!chrome.runtime?.id;

/** Source bytes stay in storage; task credentials travel only between trusted extension contexts. */
export async function localHostRequest(adapterId:string,message:unknown):Promise<unknown>{
  if(!extension())throw Error('LOCAL_HOST_EXTENSION_REQUIRED');
  const ping=()=>chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'ping'}).then(reply=>reply?.ready===true).catch(()=>false);
  await navigator.locks.request('nc-local-host-launch',async()=>{
    if(await ping())return;
    await chrome.tabs.create({url:chrome.runtime.getURL(hostPath),active:false});
    for(let i=0;i<100;i++){
      if(await ping())return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('LOCAL_HOST_UNAVAILABLE');
  });
  const reply=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'dispatch',adapterId,message});
  if(!reply?.ok)throw Error(reply?.error??'LOCAL_HOST_UNAVAILABLE');
  return reply.value;
}
