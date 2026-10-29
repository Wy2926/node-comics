export const LOCAL_HOST_MESSAGE='NC_LOCAL_TRANSLATION_HOST';
export const LOCAL_HOST_PATH='/local-translation-host.html';
const extension=()=>typeof chrome!=='undefined'&&!!chrome.runtime?.id;

/** Source bytes stay in storage; task credentials travel only between trusted extension contexts. */
export async function localHostRequest(adapterId:string,message:unknown):Promise<unknown>{
  if(!extension())throw Error('LOCAL_HOST_EXTENSION_REQUIRED');
  const started=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'ensure'});
  if(!started?.ok)throw Error(started?.error??'LOCAL_HOST_UNAVAILABLE');
  const reply=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'dispatch',adapterId,message});
  if(!reply?.ok)throw Error(reply?.error??'LOCAL_HOST_UNAVAILABLE');
  return reply.value;
}
