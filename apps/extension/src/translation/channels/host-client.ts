export const LOCAL_HOST_MESSAGE='NC_LOCAL_TRANSLATION_HOST';
export const LOCAL_HOST_PATH='/local-translation-host.html';
const extension=()=>typeof chrome!=='undefined'&&!!chrome.runtime?.id;
let fromBackground:((adapterId:string,message:unknown)=>Promise<unknown>)|undefined;
export function setBackgroundHostRequest(request:typeof fromBackground){fromBackground=request;}

export async function dispatchLocalHost(adapterId:string,message:unknown){
  const reply=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'dispatch',adapterId,message});
  if(reply?.ok!==true)throw Error(reply?.ok===false?reply.error??'LOCAL_HOST_UNAVAILABLE':'INTERRUPTED');
  return reply.value;
}

/** Source bytes stay in storage; task credentials travel only between trusted extension contexts. */
export async function localHostRequest(adapterId:string,message:unknown):Promise<unknown>{
  if(!extension())throw Error('LOCAL_HOST_EXTENSION_REQUIRED');
  if(fromBackground)return fromBackground(adapterId,message);
  const started=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'ensure'}).catch(()=>undefined);
  if(!started?.ok)throw Error(started?.error??'LOCAL_HOST_UNAVAILABLE');
  return dispatchLocalHost(adapterId,message);
}
