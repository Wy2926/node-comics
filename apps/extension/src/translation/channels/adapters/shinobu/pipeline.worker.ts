import {createImagePipeline,type ImagePipeline,type PipelineConfig} from '../../../../../third_party/shinobu/packages/image-pipeline/src/index';
import {createBrowserModelRuntime} from '../../../../../third_party/shinobu/packages/model-runtime/src/browser';
import {configureTypesetFont} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontRuntime';
import {createOffscreenPlatform} from '../../../../../third_party/shinobu/apps/web/src/runtime/offscreenPlatform';
import {Sha256} from '../../../../importers/hash';
import type {ShinobuConfig} from './config';
import type {TextRegion} from './text/protocol';
export interface PipelineStart {type:'run';source:Blob;config:ShinobuConfig;language:string;modelUrls:Record<string,string>;manifestUrl:string;fontUrl:string;fontWeight:number;fontCoverage:number[][];workerUrl:string;ortPath:string;}
let pipeline:ImagePipeline|undefined;
let runtime:ReturnType<typeof createBrowserModelRuntime>|undefined;
let respond:((value:Record<string,string>)=>void)|undefined,rejectText:((error:Error)=>void)|undefined;
let localFailure:string|undefined;
function supported(text:string,coverage:number[][]){
  for(const character of text){
    if(/\s/u.test(character))continue;const point=character.codePointAt(0)!;
    let low=0,high=coverage.length-1,found=false;
    while(low<=high){const mid=(low+high)>>>1,[start,end]=coverage[mid];if(point<start)high=mid-1;else if(point>end)low=mid+1;else{found=true;break;}}
    if(!found)throw Error('FONT_GLYPH_MISSING');
  }
}
async function run(data:PipelineStart){
  localFailure=undefined;
  if(!runtime)runtime=createBrowserModelRuntime({workerUrl:data.workerUrl,ortPath:data.ortPath,workerPolicy:'direct-only',modelSource:{manifestUrl:()=>data.manifestUrl,resolveAsset:path=>{
    const url=data.modelUrls[path];if(!url)throw Error('ASSET_MISSING');return url;
  }}});
  configureTypesetFont('NodeLane Selected Translation Font',data.fontWeight);
  const config:PipelineConfig={sourceLang:'ja',targetLang:data.language==='zh-Hant'?'zh-CHT':'zh',translator:data.config.provider==='google'?'google_web':'llm',llmProvider:'custom',llmAuthMode:'api_key',llmBaseUrl:'',llmModel:data.config.model||'local-text',typesetDebug:false,eraseDebug:false,collectDebugLog:false,ocrEngine:'paddleocr_v6_medium',ocrPostFilter:data.config.ocrFilter,processMode:'translate'};
  if(!pipeline)pipeline=createImagePipeline({platform:createOffscreenPlatform(),modelRuntime:{...runtime,getSession:(name,_preferred,options)=>runtime!.getSession(name,data.config.backend==='cpu'?['wasm']:['webgpu','wasm'],options)},detectionFallbackStrategy:{kind:'strict'},fontSource:()=>data.fontUrl});
    const task=pipeline.run({source:data.source,config,workingCopy:{strategy:'source-native'}},{textTranslator:{async translateRegions(request){
      // Upstream detection creates random IDs. Bind persistent text IDs to geometry and OCR, never UUIDs.
      const keys=request.regions.map((region,index)=>'r'+index+'_'+new Sha256().update(new TextEncoder().encode(JSON.stringify({...region,id:undefined,translatedText:undefined}))).digest().slice(0,32));
      const regions:TextRegion[]=request.regions.map((region,index)=>({id:keys[index],sourceText:region.sourceText,translatedText:''}));
      const result=await new Promise<Record<string,string>>((resolve,reject)=>{respond=resolve;rejectText=reject;postMessage({type:'text',regions});});
      return {regions:request.regions.map((region,index)=>{const translatedText=result[keys[index]];if(typeof translatedText!=='string')throw Error('TEXT_OUTPUT_INVALID');try{supported(translatedText,data.fontCoverage);}catch{localFailure='FONT_GLYPH_MISSING';throw Error(localFailure);}return {...region,translatedText};}),translationDebug:null};
    }}});
    const result=await task.result;postMessage({type:'result',status:result.status,image:result.image});
}
onmessage=({data}:{data:PipelineStart|{type:'text';result:Record<string,string>}|{type:'text-error';code:string}|{type:'stop'}})=>{
  if(data.type==='text'){respond?.(data.result);respond=undefined;rejectText=undefined;return;}
  if(data.type==='text-error'){rejectText?.(Error(data.code));respond=undefined;rejectText=undefined;return;}
  if(data.type==='stop'){rejectText?.(Error('INTERRUPTED'));void (async()=>{await pipeline?.dispose();await runtime?.dispose();postMessage({type:'disposed'});})();return;}
  void run(data).catch(error=>postMessage({type:'error',code:localFailure??(error instanceof Error&&/^(FONT_|ASSET_)[A-Z_]+$/.test(error.message)?error.message:'PIPELINE_FAILED')}));
};
