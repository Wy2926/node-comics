import {createBrowserModelRuntime,type ModelRuntime} from '../../../../../third_party/shinobu/packages/model-runtime/src/browser';
import {configureTypesetFont} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontRuntime';
import {createOffscreenPlatform} from '../../../../../third_party/shinobu/apps/web/src/runtime/offscreenPlatform';
import type {ShinobuConfig} from './config';
import type {RegionTexts,TextRegion} from './text/protocol';
import {localFailureCode,type LocalStage,type LocalModel} from './failure-code';
import {processPage} from './page-pipeline';

export interface PipelineStart {type:'run';source:Blob;backend:ShinobuConfig['backend'];filter:ShinobuConfig['ocrFilter'];language:string;modelUrls:Record<string,string>;manifestUrl:string;fontUrl:string;fontWeight:number;fontCoverage:number[][];workerUrl:string;ortPath:string;wasmModels:LocalModel[];}
const platform=createOffscreenPlatform(),lifetime=new AbortController();
let runtime:ModelRuntime|undefined,pending:{resolve:(result:RegionTexts)=>void;reject:(error:Error)=>void}|undefined,failedGpu:LocalModel|undefined;

async function modelCall<T>(gpu:LocalModel|undefined,call:()=>Promise<T>){
  failedGpu=undefined;postMessage({type:'activity',gpu});
  try{
    const result=await call();
    if(result&&typeof result==='object'&&'error' in result&&result.error)failedGpu=gpu;
    return result;
  }catch(error){failedGpu=gpu;throw error;}
  finally{postMessage({type:'activity'});}
}

async function run(data:PipelineStart){
  let stage:LocalStage='preload';
  const progress=(next:LocalStage)=>{stage=next;failedGpu=undefined;postMessage({type:'progress',stage});};
  try{
    progress('preload');
    if(!runtime){
      const {manifestUrl,modelUrls,wasmModels,backend}=data;
      const model=createBrowserModelRuntime({workerUrl:data.workerUrl,ortPath:data.ortPath,workerPolicy:'direct-only',
        modelSource:{manifestUrl:()=>manifestUrl,resolveAsset:path=>{
          const url=modelUrls[path];if(!url)throw Error('ASSET_MISSING');return url;
        }}});
      const gpuSessions=new Map<string,LocalModel>();
      runtime={...model,async getSession(name,preferred=['webgpu','wasm'],options){
        const gpu=backend==='auto'&&!wasmModels.includes(name)&&preferred.includes('webgpu');
        const handle=await modelCall(gpu?name:undefined,()=>model.getSession(name,gpu?['webgpu','wasm']:['wasm'],options));
        if(handle.provider==='webgpu')gpuSessions.set(handle.sessionId,name);
        return handle;
      },run:(id,feeds)=>modelCall(gpuSessions.get(id),()=>model.run(id,feeds)),
      runImage:(id,image,onSubmitted)=>modelCall(gpuSessions.get(id),()=>model.runImage(id,image,onSubmitted))};
      const family='NodeLane Selected Translation Font';
      configureTypesetFont(family,data.fontWeight,data.fontCoverage);
      platform.registerFont(data.fontUrl,family,{style:'normal',weight:String(data.fontWeight)});
      await platform.waitForFonts().catch(()=>{throw Error('FONT_UNAVAILABLE');});
    }
    const translate=(regions:TextRegion[])=>new Promise<RegionTexts>((resolve,reject)=>{pending={resolve,reject};postMessage({type:'text',regions});});
    const image=await processPage(data.source,platform,runtime,data.language,data.filter,progress,translate,lifetime.signal);
    postMessage({type:'result',image});
  }catch(error){
    const code=localFailureCode(error);
    postMessage({type:'error',code:code==='PIPELINE_FAILED'?'PIPELINE_'+stage.toUpperCase():code,gpu:failedGpu});
  }
}
onmessage=({data}:{data:PipelineStart|{type:'text';result:RegionTexts}|{type:'stop'}})=>{
  if(data.type==='text'){pending?.resolve(data.result);pending=undefined;return;}
  if(data.type==='stop'){
    lifetime.abort();pending?.reject(Error('INTERRUPTED'));
    const done=()=>postMessage({type:'disposed'});
    void Promise.resolve(runtime?.dispose()).then(done,done);return;
  }
  void run(data);
};
