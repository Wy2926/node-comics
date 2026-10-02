import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {INPUT_PROFILE,LEGACY_INPUT_PROFILE,type InputProfile} from '../src/translation/input/limits';
const encode=vi.hoisted(()=>vi.fn());
vi.mock('../src/translation/input/resize',async original=>({...await original<object>(),resizeInput:encode}));
beforeEach(()=>vi.resetModules());
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

it.each(['limit','decode'] as const)('reports a typed %s failure through the actual resize worker handler',async kind=>{
  const {ImageOutputTooLargeError}=await import('../src/translation/input/resize');
  const worker={onmessage:undefined as undefined|((event:{data:{blob:Blob;width:number;height:number}})=>Promise<void>),postMessage:vi.fn()};
  vi.stubGlobal('self',worker);
  encode.mockRejectedValueOnce(kind==='limit'?new ImageOutputTooLargeError():new DOMException('Invalid bytes','EncodingError'));
  await import('../src/translation/input/resize.worker');
  await worker.onmessage!({data:{blob:new Blob(),width:1800,height:26000}});
  expect(worker.postMessage).toHaveBeenCalledWith({error:kind==='limit'?'IMAGE_OUTPUT_TOO_LARGE':'IMAGE_INVALID'});
});

it.each([LEGACY_INPUT_PROFILE,INPUT_PROFILE])('forwards frozen encoder profile %s through the actual worker',async profile=>{
  const worker={onmessage:undefined as undefined|((event:{data:{blob:Blob;width:number;height:number;profile:InputProfile}})=>Promise<void>),postMessage:vi.fn()};
  vi.stubGlobal('self',worker);
  const blob=new Blob(['source']),output={blob:new Blob(['output']),sha256:'a'.repeat(64)};encode.mockResolvedValueOnce(output);
  await import('../src/translation/input/resize.worker');
  await worker.onmessage!({data:{blob,width:800,height:20000,profile}});
  expect(encode).toHaveBeenCalledWith(blob,800,20000,profile);expect(worker.postMessage).toHaveBeenCalledWith(output);
});
