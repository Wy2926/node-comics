import {Api,ApiError} from '../api';
import {assertCurrent} from '../concurrency';
import {applyMatch,pageSource} from '../reader/recovery';
import {pageTranslation} from '../reader/presentation';
import {mergeJobs} from '../reader/jobs';
import {automaticManifest,availableSlots,exhausted,needsTranslation,quotaErrors,targetKey} from '../translation/automatic';
import {processManifest} from '../translation/processor';
import {readManifest,saveManifest,translationScope} from '../translation/store';
import {translationState} from '../translation/state';
import type {Capabilities,Entitlements,Job,Mode,ModeQueue,Page} from '../types';

/** One bounded step. Jobs and exact submission keys outlive the browser/service worker. */
export async function translateInlinePage({api,page,mode,language,userId,caps,rights,getBlob,retry=false,sessionId}:{api:Api;page:Page;mode:Mode;language:string;userId:string;caps:Capabilities;rights:Entitlements;getBlob:(key:string)=>Promise<Blob|undefined>;retry?:boolean;sessionId:string}){
  const origin=new URL(api.base).origin,scope=translationScope(origin,userId),copyId='inline';
  // Display tokens are not a local image cache; validate access again on each match.
  page={...page,outputBlobs:{}};
  const id=JSON.stringify([scope,language,targetKey(copyId,page,mode)]);
  let manifest=await readManifest(id);
  const attach=async(jobs:Job[])=>{page={...page,ownerId:userId,apiOrigin:origin,assetId:jobs.find(j=>j.input_asset_id)?.input_asset_id??page.assetId,jobs:mergeJobs(page.ownerId===userId&&page.apiOrigin===origin?page.jobs:[],jobs)};};
  const process=async()=>{
    await processManifest({api,manifest:manifest!,available:1,readingPageIds:[],readingSessionId:sessionId,concurrency:1,getBlob,onJobs:attach,onChange:()=>{}});
    assertCurrent(api.isCurrent);manifest=await readManifest(id);
  };
  // Recover an uncertain POST using its frozen body/key before considering any new work.
  if(manifest?.pending&&!manifest.paused)await process();
  const source=pageSource(page)!;
  const match=(await api.matchPages([source],mode,language)).items[0];
  assertCurrent(api.isCurrent);page=applyMatch(page,match,userId,origin);
  if(mode==='redraw'){
    const fallback=(await api.matchPages([source],'classic',language)).items[0];
    assertCurrent(api.isCurrent);page={...page,jobs:mergeJobs(page.jobs,[...fallback.jobs,...(fallback.display_jobs??[])])};
  }
  const t=pageTranslation(page,mode,language,userId,origin);
  if(retry&&!t.pending&&t.latest?.status!=='unknown_released'&&!manifest?.pending&&!(t.result?.output_asset_id&&!t.expired&&t.latest?.status!=='failed')){
    manifest=await automaticManifest({copyId,page,mode},scope,language,rights.modes[mode],getBlob,t.latest?.id);
    await saveManifest(manifest);
  }
  if(manifest?.paused&&quotaErrors.has(manifest.errorCode??'')&&manifest.rightsVersion!==JSON.stringify(rights.modes[mode]))manifest=undefined;
  let queues:ModeQueue[]|undefined;
  const admission=async()=>{
    queues??=(await api.queues()).items;assertCurrent(api.isCurrent);
    const queue=queues.find(q=>q.mode===mode);
    return queue&&(exhausted(rights.modes[mode])||queue.available_slots>0&&availableSlots(queues,rights.plan==='plus')>0)?queue:undefined;
  };
  if(!manifest&&needsTranslation(page,mode,language,userId,origin)&&await admission())manifest=await automaticManifest({copyId,page,mode},scope,language,rights.modes[mode],getBlob);
  if(manifest&&!manifest.paused&&!manifest.pending&&manifest.items.some(i=>i.state==='local')){
    const queue=await admission();
    if(queue){
      if(queue.paused)await api.pauseQueue(mode,false);
      manifest.rightsVersion=JSON.stringify(rights.modes[mode]);await saveManifest(manifest);await process();
    }
  }
  const current=pageTranslation(page,mode,language,userId,origin);
  const fallback=mode==='redraw'?pageTranslation(page,'classic',language,userId,origin):undefined;
  const result=current.result&&!current.expired?current.result:fallback?.result&&!fallback.expired?fallback.result:undefined;
  // Known delivery is ready for display; the caller downloads and validates the bytes.
  if(result?.output_asset_id)page={...page,outputBlobs:{[result.id]:result.output_asset_id}};
  return {page,manifest,result,state:translationState({page,mode,language,userId,origin,caps,rights,active:true,manifest})};
}

export function inlineError(error:unknown){
  return {kind:error instanceof ApiError&&[401,403].includes(error.status)?'login' as const:'error' as const,message:error instanceof Error?error.message:'翻译暂未完成，请重试。'};
}
