import onnxWorkerUrl from './onnx.worker?worker&url';
import PipelineWorker from './pipeline.worker?worker';
import modelManifest from '../../../../../third_party/shinobu/public/models/models.json';
import {readAsset,assetLock,type LocalAsset} from '../../../../storage/local-assets/store';
import {fullFont} from '../../../font-resources';
import {modelAssets} from './resources';
import type {LocalOperation} from './operations';
import type {PipelineStart} from './pipeline.worker';
import {translateText} from './text/execute';
import type {TextRegion} from './text/protocol';
import {localLanguage} from './languages';
interface Context {key:string;worker:Worker;urls:Record<string,string>;fontUrl:string;fontCoverage:number[][];manifestUrl:string;release:()=>void;closed:Promise<void>;}
let context:Context|undefined,idle:ReturnType<typeof setTimeout>|undefined;
async function leases<T>(assets:LocalAsset[],run:()=>Promise<T>):Promise<T>{
  if(!assets.length)return run();return navigator.locks.request(assetLock(assets[0]),{mode:'shared'},()=>leases(assets.slice(1),run));
}
export async function disposeEngine(){
  clearTimeout(idle);const previous=context;context=undefined;if(!previous)return;
  await new Promise<void>(resolve=>{
    const timer=setTimeout(resolve,5000);previous.worker.onmessage=({data})=>{if(data.type==='disposed'){clearTimeout(timer);resolve();}};
    previous.worker.postMessage({type:'stop'});
  });
  previous.release();await previous.closed;
}
async function ready(operation:LocalOperation):Promise<Context>{
  const font=fullFont(operation.fontId),key=font.sha256+':'+operation.config.backend;
  clearTimeout(idle);if(context?.key===key)return context;
  await disposeEngine();
  let release!:()=>void;
  const retained=new Promise<void>(resolve=>{release=resolve;});
  let initialized!:(value:Context)=>void,failed!:(error:unknown)=>void;
  const result=new Promise<Context>((resolve,reject)=>{initialized=resolve;failed=reject;});
  const closed=leases([...modelAssets,font].sort((a,b)=>a.sha256.localeCompare(b.sha256)),async()=>{
    const urls:Record<string,string>={},created:string[]=[];
    const url=(blob:Blob)=>{const value=URL.createObjectURL(blob);created.push(value);return value;};
    let worker:Worker|undefined;
    try{
      for(const model of modelAssets)urls['/models/'+model.label]=url(await readAsset(model));
      const fontUrl=url(await readAsset(font)),manifestUrl=url(new Blob([JSON.stringify(modelManifest)],{type:'application/json'}));
      // Keep the large coverage table out of reader/background bundles and parse it only in the host.
      const coverage=await (await fetch(chrome.runtime.getURL('local-runtime/font-coverage.json'))).json() as Record<string,number[][]>;
      const fontCoverage=coverage[operation.fontId];if(!fontCoverage?.length)throw Error('FONT_UNAVAILABLE');
      worker=new PipelineWorker();
      initialized({key,worker,urls,fontUrl,fontCoverage,manifestUrl,release,closed});await retained;
    }catch(error){failed(error);}
    finally{worker?.terminate();for(const value of created)URL.revokeObjectURL(value);}
  });
  void closed.catch(failed);
  context=await result;return context;
}
/** One warm runtime; verify assets once per host/font/backend generation. */
export async function runImage(operation:LocalOperation,source:Blob,signal:AbortSignal,token:string){
  localLanguage(operation.job.target_language);
  const current=await ready(operation),worker=current.worker,font=fullFont(operation.fontId);
  const start:PipelineStart={type:'run',source,config:operation.config,language:operation.job.target_language,modelUrls:current.urls,manifestUrl:current.manifestUrl,fontUrl:current.fontUrl,fontWeight:font.weight,fontCoverage:current.fontCoverage,workerUrl:onnxWorkerUrl,ortPath:chrome.runtime.getURL('local-runtime/')};
  try{
    signal.throwIfAborted();
    return await new Promise<{status:string;image:Blob}>((resolve,reject)=>{
      const abort=()=>reject(Error('INTERRUPTED'));signal.addEventListener('abort',abort,{once:true});let textError:string|undefined;
      const finish=(value?:{status:string;image:Blob},error?:Error)=>{signal.removeEventListener('abort',abort);value?resolve(value):reject(error);};
      worker.onerror=()=>finish(undefined,Error('PIPELINE_FAILED'));
      worker.onmessage=({data}:{data:{type:string;code?:string;status:string;image:Blob;regions:TextRegion[]}})=>{
        if(data.type==='text')void translateText(operation,data.regions,signal,token).then(result=>{if(context===current)worker.postMessage({type:'text',result});},error=>{
          textError=error instanceof Error&&/^(TEXT_|FONT_)/.test(error.message)?error.message:'TEXT_OUTCOME_UNKNOWN';if(context===current)worker.postMessage({type:'text-error',code:textError});
        });
        else if(data.type==='result')finish({status:data.status,image:data.image});
        else if(data.type==='error')finish(undefined,Error(textError??(data.code&&/^(FONT_|ASSET_)[A-Z_]+$/.test(data.code)?data.code:'PIPELINE_FAILED')));
      };
      worker.postMessage(start);
    });
  }catch(error){await disposeEngine();throw error;}
  finally{idle=setTimeout(()=>void disposeEngine(),60_000);}
}
