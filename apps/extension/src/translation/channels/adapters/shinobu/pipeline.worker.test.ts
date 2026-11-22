import {afterEach,expect,it,vi} from 'vitest';
import type {PipelineStart} from './pipeline.worker';

const {runImage,run}=vi.hoisted(()=>({
  runImage:vi.fn(async()=>{throw Error('GPU device lost');}),
  run:vi.fn(async(session:string)=>{
    if(session!=='wasm')throw Error('GPU device lost');
    return {outputs:{seg:{type:'float32',dims:[1,1,1,1],data:Float32Array.of(0)}}};
  }),
}));
vi.mock('../../../../../third_party/shinobu/packages/model-runtime/src/browser',()=>({createBrowserModelRuntime:()=>({
  getSession:async(_name:string,[provider]:string[])=>({provider,sessionId:provider,inputNames:['images'],outputNames:['seg']}),
  runImage,run,
})}));
vi.mock('../../../../../third_party/shinobu/apps/web/src/runtime/offscreenPlatform',async importOriginal=>({...await importOriginal<object>(),createOffscreenPlatform:()=>({
  registerFont(){},async waitForFonts(){},async createImageBitmap(){return {};},
  createCanvas:(width:number,height:number)=>({width,height,convertToBlob:async()=>new Blob(['blank'],{type:'image/png'}),
    getContext:()=>({drawImage(){},fillRect(){},getImageData:()=>({data:new Uint8ClampedArray(width*height*4)})})}),
})}));

afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it.each([['auto',undefined,1],['cpu',undefined,0],['auto','detector',0],['auto','bubble',1]] as const)('finishes detection on WASM in %s with override %s',async(backend,wasmModel,gpuAttempts)=>{
  vi.resetModules();
  const reply=Promise.withResolvers<unknown>(),stages:{type:string;stage:string}[]=[];
  vi.stubGlobal('self',globalThis);vi.stubGlobal('onmessage',null);vi.stubGlobal('postMessage',(data:{type:string;stage:string})=>{
    if(data.type==='progress')stages.push(data);
    else if(data.type!=='activity')reply.resolve(data);
  });
  vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  await import('./pipeline.worker');
  const data:PipelineStart={type:'run',source:new Blob(['blank'],{type:'image/png'}),backend,filter:'balanced',language:'ja',
    modelUrls:{},manifestUrl:'',fontUrl:'',fontWeight:400,fontCoverage:[],workerUrl:'',ortPath:'',wasmModels:wasmModel?[wasmModel]:[]};
  self.onmessage!(new MessageEvent('message',{data}));
  await expect(reply.promise).resolves.toEqual({type:'result',image:null});
  expect(stages).toEqual(expect.arrayContaining([{type:'progress',stage:'preload'},{type:'progress',stage:'detect'}]));
  expect(stages.every(stage=>Object.keys(stage).length===2)).toBe(true);
  expect(runImage).toHaveBeenCalledTimes(gpuAttempts);
  expect(run.mock.calls.map(([provider])=>provider)).toEqual(['wasm']);
});
