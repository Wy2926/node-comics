import {afterEach,beforeEach,expect,it,vi} from 'vitest';
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
