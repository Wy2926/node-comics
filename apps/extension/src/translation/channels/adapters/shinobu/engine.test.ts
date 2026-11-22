import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {disposeEngine,runImage} from './engine';
import {parseConfig} from './config';
import type {LocalOperation} from './operations';
import type {PipelineStart} from './pipeline.worker';

const {workers,TestWorker,translate,read}=vi.hoisted(()=>{
  class TestWorker{
    onmessage:((event:{data:unknown})=>void)|null=null;
    sent=vi.fn((data:{type:string})=>{if(data.type==='stop')this.emit({type:'disposed'});});
    terminate=vi.fn();postMessage=this.sent;
    constructor(){workers.push(this);}
    emit(data:unknown){this.onmessage?.({data});}
  }
  const workers:TestWorker[]=[];
  return {TestWorker,workers,translate:vi.fn(),read:vi.fn(async()=>new Blob(['asset']))};
});
vi.mock('./pipeline.worker?worker',()=>({default:TestWorker}));
vi.mock('./onnx.worker?worker&url',()=>({default:'/test-model-worker.js'}));
vi.mock('./text/execute',()=>({translateText:translate}));
vi.mock('../../../../storage/local-assets/store',()=>({assetLock:(a:{id:string})=>a.id,readAsset:read}));

beforeEach(()=>{
  vi.useFakeTimers();workers.length=0;
  vi.stubGlobal('navigator',{locks:{request:(_name:string,_opts:unknown,run:()=>Promise<unknown>)=>Promise.resolve().then(run)}});
  vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>path}});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({'noto-sans-cjk':[[32,126]]}))));
});
afterEach(async()=>{await disposeEngine();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();});
const source=new Blob(['original']);
const start=(backend:'auto'|'cpu',signal=new AbortController().signal)=>runImage({
  config:parseConfig({backend}),fontId:'noto-sans-cjk',job:{target_language:'zh-Hans'},
} as LocalOperation,source,signal,'',vi.fn());
const running=()=>vi.waitFor(()=>expect(workers[0]?.sent).toHaveBeenCalled());

it('renews on completed OCR batches, then replaces only a silent model before sending text once',async()=>{
  const task=start('auto');await running();
  const first=workers[0],late=first.onmessage!,reads=read.mock.calls.length;
  first.emit({type:'progress',stage:'ocr'});await vi.advanceTimersByTimeAsync(80_000);
  first.emit({type:'activity',gpu:'paddleocr_v6_medium_rec'});await vi.advanceTimersByTimeAsync(80_000);
  expect(workers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_000);
  const fresh=workers[1],retry=fresh.sent.mock.calls[0][0] as PipelineStart;
  expect(first.terminate).toHaveBeenCalledOnce();expect(retry).toMatchObject({wasmModels:['paddleocr_v6_medium_rec'],source,backend:'auto'});
  expect(retry).not.toHaveProperty('config');
  expect(read.mock.calls).toHaveLength(reads);
  late({data:{type:'text',regions:[]}});expect(translate).not.toHaveBeenCalled();
  const text=Promise.withResolvers<Record<string,string>>();translate.mockReturnValueOnce(text.promise);
  fresh.emit({type:'text',regions:[]});await vi.advanceTimersByTimeAsync(240_000);
  expect(workers).toHaveLength(2);expect(translate).toHaveBeenCalledOnce();
  text.resolve({});await text.promise;
  fresh.emit({type:'result',image:source});await expect(task).resolves.toBe(source);
});
it('identifies a silent postfilter, then times out a silent renderer without resending paid text',async()=>{
  const task=start('auto'),failed=expect(task).rejects.toThrow('PIPELINE_TYPESET_TIMEOUT');await running();
  workers[0].emit({type:'progress',stage:'ocr_postfilter'});workers[0].emit({type:'activity',gpu:'paddleocr_v6_medium_rec'});await vi.advanceTimersByTimeAsync(90_000);
  const fresh=workers[1];expect(fresh.sent.mock.calls[0][0]).toMatchObject({wasmModels:['paddleocr_v6_medium_rec']});
  translate.mockResolvedValueOnce({r:'translated'});fresh.emit({type:'text',regions:[]});await vi.advanceTimersByTimeAsync(0);
  fresh.emit({type:'text',regions:[]});await vi.advanceTimersByTimeAsync(90_000);
  await failed;expect(workers).toHaveLength(2);expect(translate).toHaveBeenCalledOnce();
});
it('reports ordering stalls without switching an unrelated model to CPU',async()=>{
  const task=start('auto'),failed=expect(task).rejects.toThrow('PIPELINE_ORDER_TIMEOUT');await running();
  workers[0].emit({type:'progress',stage:'ocr'});workers[0].emit({type:'progress',stage:'order'});
  await vi.advanceTimersByTimeAsync(90_000);await failed;expect(workers).toHaveLength(1);
});
it('does not cache an empty render as a success or as a no-text page',async()=>{
  const task=start('auto'),failed=expect(task).rejects.toThrow('PIPELINE_FAILED');await running();
  workers[0].emit({type:'result',image:new Blob()});await failed;expect(workers).toHaveLength(1);
});
it.each(['auto','cpu'] as const)('releases an unresponsive %s worker and reports the last stage',async backend=>{
  const task=start(backend),failed=expect(task).rejects.toThrow('PIPELINE_BUBBLE_TIMEOUT');await running();
  workers[0].emit({type:'progress',stage:'bubble'});workers[0].emit({type:'activity',gpu:backend==='auto'?'bubble':undefined});await vi.advanceTimersByTimeAsync(90_000);
  if(backend==='auto'){workers[1].emit({type:'progress',stage:'bubble'});await vi.advanceTimersByTimeAsync(90_000);}
  await failed;expect(workers).toHaveLength(backend==='auto'?2:1);
  expect(workers.every(worker=>worker.terminate.mock.calls.length===1)).toBe(true);
  expect(translate).not.toHaveBeenCalled();
});
it('recovers a rejected GPU inference but never replays OCR that already ran on WASM',async()=>{
  const task=start('auto'),failed=expect(task).rejects.toThrow('PIPELINE_OCR_TIMEOUT');await running();
  workers[0].emit({type:'progress',stage:'bubble'});workers[0].emit({type:'error',code:'PIPELINE_BUBBLE',gpu:'bubble'});
  await vi.waitFor(()=>expect(workers[1]?.sent).toHaveBeenCalled());
  workers[1].emit({type:'progress',stage:'ocr'});workers[1].emit({type:'activity'});
  await vi.advanceTimersByTimeAsync(90_000);await failed;expect(workers).toHaveLength(2);expect(translate).not.toHaveBeenCalled();
});
it.each(['stop','timeout'] as const)('releases a queued resource lease on %s before a pipeline can start',async reason=>{
  const requested=Promise.withResolvers<void>(),controller=new AbortController();
  const deadline=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
  vi.stubGlobal('navigator',{locks:{request:(_name:string,{signal}:{signal:AbortSignal})=>new Promise((_ok,fail)=>{
    signal.addEventListener('abort',()=>fail(signal.reason),{once:true});requested.resolve();
  })}});
  const task=start('auto',controller.signal);await requested.promise;
  (reason==='stop'?controller:deadline).abort();
  await expect(task).rejects.toThrow(reason==='stop'?'INTERRUPTED':'PIPELINE_PRELOAD_TIMEOUT');expect(workers).toHaveLength(0);
});
