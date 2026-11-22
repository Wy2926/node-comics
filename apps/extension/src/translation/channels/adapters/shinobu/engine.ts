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
import {abortable} from '../../../../concurrency';
import {isLocalStage,stageModels,type LocalStage,type LocalModel} from './failure-code';
type Phase=LocalStage|'translating_text';
interface Context {key:string;worker:Worker;urls:Record<string,string>;fontUrl:string;fontCoverage:number[][];manifestUrl:string;release:()=>void;closed:Promise<void>;wasmModels:LocalModel[];}
const localIdleMs=90_000;
let context:Context|undefined,idle:ReturnType<typeof setTimeout>|undefined;
async function leases<T>(assets:LocalAsset[],signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  if(!assets.length)return run();return navigator.locks.request(assetLock(assets[0]),{mode:'shared',signal},()=>leases(assets.slice(1),signal,run));
}
export async function disposeEngine(){
  clearTimeout(idle);const previous=context;context=undefined;if(!previous)return;
  try{await new Promise<void>(resolve=>{
    const timer=setTimeout(resolve,5000);previous.worker.onmessage=({data})=>{if(data.type==='disposed'){clearTimeout(timer);resolve();}};
    previous.worker.postMessage({type:'stop'});
  });}finally{previous.worker.terminate();previous.release();await previous.closed;}
}
async function ready(operation:LocalOperation,signal:AbortSignal):Promise<Context>{
  signal.throwIfAborted();
  const font=fullFont(operation.fontId),key=font.sha256+':'+operation.config.backend;
  clearTimeout(idle);if(context?.key===key)return context;
  await disposeEngine();
  let release!:()=>void;
  const retained=new Promise<void>(resolve=>{release=resolve;});
  let initialized!:(value:Context)=>void,failed!:(error:unknown)=>void;
  const result=new Promise<Context>((resolve,reject)=>{initialized=resolve;failed=reject;});
  const closed=leases([...modelAssets,font].sort((a,b)=>a.sha256.localeCompare(b.sha256)),signal,async()=>{
    const urls:Record<string,string>={},created:string[]=[];
    const url=(blob:Blob)=>{const value=URL.createObjectURL(blob);created.push(value);return value;};
    try{
      for(const model of modelAssets)urls['/models/'+model.label]=url(await abortable(readAsset(model,signal),signal));
      const fontUrl=url(await abortable(readAsset(font,signal),signal)),manifestUrl=url(new Blob([JSON.stringify(modelManifest)],{type:'application/json'}));
      // Keep the large coverage table out of reader/background bundles and parse it only in the host.
      const coverage=await (await fetch(chrome.runtime.getURL('local-runtime/font-coverage.json'),{signal})).json() as Record<string,number[][]>;
      const fontCoverage=coverage[operation.fontId];if(!fontCoverage?.length)throw Error('FONT_UNAVAILABLE');
      signal.throwIfAborted();
      initialized({key,worker:new PipelineWorker(),urls,fontUrl,fontCoverage,manifestUrl,release,closed,wasmModels:[]});await retained;
    }catch(error){failed(error);}
    finally{for(const value of created)URL.revokeObjectURL(value);}
  });
  void closed.catch(failed);
  context=await result;return context;
}
/** One warm runtime; verify assets once per host/font/backend generation. */
export async function runImage(operation:LocalOperation,source:Blob,signal:AbortSignal,token:string,onPhase:(phase:Phase)=>void){
  const language=localLanguage(operation.job.target_language).pipeline;
  const loading=AbortSignal.timeout(localIdleMs);
  const current=await ready(operation,AbortSignal.any([signal,loading])).catch(error=>{
    if(signal.aborted)throw Error('INTERRUPTED');
    if(loading.aborted)throw Error('PIPELINE_PRELOAD_TIMEOUT');
    throw error;
  });
  const font=fullFont(operation.fontId);
  const start:PipelineStart={type:'run',source,backend:operation.config.backend,filter:operation.config.ocrFilter,language,modelUrls:current.urls,manifestUrl:current.manifestUrl,fontUrl:current.fontUrl,fontWeight:font.weight,fontCoverage:current.fontCoverage,workerUrl:onnxWorkerUrl,ortPath:chrome.runtime.getURL('local-runtime/'),wasmModels:current.wasmModels};
  try{
    for(;;){
      const worker=current.worker;
      let retryModel:LocalModel|undefined;
      try{
        return await new Promise<Blob|null>((resolve,reject)=>{
          let phase:Phase='preload',gpu:LocalModel|undefined,submitted=false,timer:ReturnType<typeof setTimeout>;
          const lifetime=new AbortController();
          const setPhase=(next:Phase)=>{if(next!==phase){phase=next;onPhase(next);}};
          const finish=(value:Blob|null|Error)=>{
            lifetime.abort();clearTimeout(timer);signal.removeEventListener('abort',abort);
            worker.onmessage=worker.onerror=worker.onmessageerror=null;
            value instanceof Error?reject(value):resolve(value);
          };
          const abort=()=>finish(Error('INTERRUPTED'));
          const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{
            retryModel=submitted?undefined:gpu;
            finish(Error('PIPELINE_'+phase.toUpperCase()+'_TIMEOUT'));
          },localIdleMs);};
          if(signal.aborted){abort();return;}
          signal.addEventListener('abort',abort,{once:true});
          worker.onerror=worker.onmessageerror=()=>{retryModel=submitted?undefined:gpu;finish(Error('PIPELINE_FAILED'));};
          worker.onmessage=({data}:{data:{type:string;stage?:string;gpu?:LocalModel;code?:string;image?:Blob|null;regions:TextRegion[]}})=>{
            if(worker!==current.worker||context!==current||signal.aborted)return;
            if(data.type==='activity'||data.type==='progress'){
              if(phase==='translating_text')return;
              if(data.type==='progress'&&isLocalStage(data.stage))setPhase(data.stage);
              gpu=isLocalStage(phase)&&stageModels[phase]===data.gpu?data.gpu:undefined;
              arm();
            }else if(data.type==='text'&&!submitted){
              submitted=true;clearTimeout(timer);setPhase('translating_text');
              void translateText(operation,data.regions,lifetime.signal,token).then(result=>{
                if(!lifetime.signal.aborted){setPhase('typeset');arm();worker.postMessage({type:'text',result});}
              }).catch(error=>{
                if(!lifetime.signal.aborted)finish(Error(error instanceof Error&&/^(TEXT_|FONT_)/.test(error.message)?error.message:'TEXT_OUTCOME_UNKNOWN'));
              });
            }else if(data.type==='result')finish(data.image===null||data.image instanceof Blob&&data.image.size>0?data.image:Error('PIPELINE_FAILED'));
            else if(data.type==='error'){
              retryModel=!submitted&&isLocalStage(phase)&&stageModels[phase]===data.gpu?data.gpu:undefined;
              finish(Error(data.code??'PIPELINE_FAILED'));
            }
          };
          arm();
          try{worker.postMessage(start);}catch{finish(Error('PIPELINE_FAILED'));}
        });
      }catch(error){
        if(!retryModel||current.wasmModels.includes(retryModel)||operation.config.backend!=='auto'||signal.aborted)throw error;
        // A wedged ONNX worker cannot consume another request, even for WASM.
        worker.terminate();current.wasmModels.push(retryModel);current.worker=new PipelineWorker();onPhase('preload');
      }
    }
  }catch(error){await disposeEngine();throw error;}
  finally{idle=setTimeout(()=>void disposeEngine(),60_000);}
}
