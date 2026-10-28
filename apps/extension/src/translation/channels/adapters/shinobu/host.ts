import type {ChannelLocalHost} from '../../contracts';
import DownloadWorker from '../../../../storage/local-assets/download.worker?worker';
import {recheckAsset,recordAssetFailure,removeAsset,type LocalAsset} from '../../../../storage/local-assets/store';
import {saveResultBlob} from '../../../../storage/translations/results';
import {defaultTranslationFont} from '../../../../../../../backend/shared/translation-fonts';
import {fullFont} from '../../../font-resources';
import {modelAssets,resourceAssets,resourceEvents} from './resources';
import {readOperation,readInput,releaseInput,saveOperation,clearCheckpoint,expireCheckpoints} from './operations';
import {runImage,disposeEngine} from './engine';
import {errorMessage} from './errors';
import {executionLock,operationLock} from './locks';
export async function createHost(changed:(busy:boolean)=>void):Promise<ChannelLocalHost>{
  let active:AbortController|undefined,downloader:Worker|undefined,downloads:LocalAsset[]=[],currentDownload:string|undefined;
  const events=new BroadcastChannel(resourceEvents);
  const notify=()=>{events.postMessage(null);changed(!!active||!!downloader);};
  const downloadNext=()=>{
    if(downloader)return;
    const asset=downloads.shift();if(!asset){notify();return;}
    currentDownload=asset.id;downloader=new DownloadWorker();notify();
    const finish=()=>{downloader?.terminate();downloader=undefined;currentDownload=undefined;notify();downloadNext();};
    downloader.onmessage=({data})=>{notify();if(data.type==='done')finish();};downloader.onerror=()=>{void recordAssetFailure(asset).finally(finish);};
    downloader.postMessage({action:'download',asset});
  };
  await expireCheckpoints();
  return {
    async dispatch(message){
      if(!message||typeof message!=='object')throw Error('INVALID_HOST_MESSAGE');
      const {action,id,fontIds,token}=message as {action:string;id?:string;fontIds?:string[];token?:string};
      if(action==='stop'){active?.abort();downloads=[];downloader?.postMessage({action:'pause'});await disposeEngine();return;}
      if(action==='start'){
        if(!id||!/^[a-f0-9]{64}$/.test(id)||token!==undefined&&typeof token!=='string')throw Error('INVALID_OPERATION');
        return new Promise<void>((resolve,reject)=>{
          let accepted=false;
          void navigator.locks.request(executionLock,{ifAvailable:true},async lock=>{
            if(!lock)throw Error('LOCAL_BUSY');
            await navigator.locks.request(operationLock(id),async()=>{
              let record=await readOperation(id);if(!record||record.job.status!=='running')throw Error('OPERATION_STALE');
              const controller=new AbortController();active=controller;notify();accepted=true;resolve();
              try{
                const source=await readInput(record.job.id);if(!source)throw Error('SOURCE_MISSING');
                const output=await runImage(record,source,controller.signal,token??'');
                const now=new Date().toISOString(),job={...record.job,status:output.status==='no-translatable-text'?'no_text' as const:'succeeded' as const,phase:'succeeded',updated_at:now,completed_at:now,result_available:output.status!=='no-translatable-text',...(output.status==='no-translatable-text'?{}:{result:{key:record.job.id,recoverable:false}})};
                if(job.status==='succeeded')await saveResultBlob({scope:{key:record.scope},job,blob:output.image,cacheToken:record.cacheToken,isCurrent:()=>!controller.signal.aborted});
                record={...record,job};await saveOperation(record);await clearCheckpoint(record.job.id);
              }catch(error){
                const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'PIPELINE_FAILED';
                await saveOperation({...record,job:{...record.job,status:'failed',phase:'failed',updated_at:new Date().toISOString(),error:{code,message:errorMessage(code)}}}).catch(()=>{});
              }finally{await releaseInput(record.job.id);active=undefined;notify();}
            });
          }).catch(error=>{if(!accepted)reject(error);});
        });
      }
      const asset=id?resourceAssets().find(item=>item.id===id):undefined;
      if(action==='download'){
        const fonts=Array.isArray(fontIds)&&fontIds.length?fontIds.slice(0,5):[defaultTranslationFont('zh-Hans')!.id];
        const requested=asset?[asset]:id?[]:[...modelAssets,...[...new Set(fonts)].map(fullFont)];
        if(!requested.length)throw Error('ASSET_UNKNOWN');
        for(const item of requested)if(currentDownload!==item.id&&!downloads.some(value=>value.id===item.id))downloads.push(item);
        void navigator.storage.persist?.();downloadNext();return;
      }
      if(action==='pause'){downloads=[];downloader?.postMessage({action:'pause'});return;}
      if(!asset)throw Error('ASSET_UNKNOWN');
      if(action==='remove')await removeAsset(asset);
      else if(action==='verify')await recheckAsset(asset);
      else throw Error('INVALID_HOST_ACTION');notify();
    },
    async dispose(){active?.abort();downloads=[];downloader?.postMessage({action:'pause'});await disposeEngine();events.close();},
  };
}
