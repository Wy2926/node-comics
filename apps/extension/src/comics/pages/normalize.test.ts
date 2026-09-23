import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {prepareComicPage} from './normalize';
const workerFactory=vi.hoisted(()=>vi.fn());
vi.mock('./hash.worker?worker',()=>({default:class {constructor(){return workerFactory();}}}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

function workerPage(){
  const bytes=new Uint8Array(1024*1024);bytes.set([137,80,78,71,13,10,26,10]);
  const close=vi.fn();vi.stubGlobal('createImageBitmap',async()=>({width:1024,height:1024,close}));
  vi.stubGlobal('Worker',class {});
  let sent!:()=>void;const started=new Promise<void>(resolve=>{sent=resolve;});
  const worker={onmessage:null as null|((event:{data:{sha256:string}})=>void),onerror:null as null|(()=>void),postMessage:vi.fn(()=>sent()),terminate:vi.fn()};
  workerFactory.mockReturnValue(worker);
  return {bytes,blob:new Blob([bytes],{type:'image/png'}),close,worker,started};
}
describe('materialized image normalization',()=>{
  it('uses the bundled worker for large page digests and releases both resources',async()=>{
    const {bytes,blob,close,worker,started}=workerPage(),digest=createHash('sha256').update(bytes).digest('hex');
    const pending=prepareComicPage({name:'large',blob});await started;
    expect(worker.postMessage).toHaveBeenCalledWith(blob);worker.onmessage!({data:{sha256:digest}});
    expect((await pending).imageSha256).toBe(digest);expect(worker.terminate).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  });
  it('cancels large page hashing and releases the worker and bitmap',async()=>{
    const {blob,close,worker,started}=workerPage(),controller=new AbortController();
    const pending=prepareComicPage({name:'large',blob},controller.signal);await started;controller.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(worker.terminate).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  });
  it('does not publish a digest when its worker fails',async()=>{
    const {blob,close,worker,started}=workerPage(),pending=prepareComicPage({name:'large',blob});await started;worker.onerror!();
    await expect(pending).rejects.toThrow('摘要 Worker');expect(worker.terminate).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  });
  it('derives MIME from actual bytes and computes the exact upload digest without retaining a bitmap',async()=>{
    const close=vi.fn(),decode=vi.fn(async()=>({width:100,height:200,close}));vi.stubGlobal('createImageBitmap',decode);
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
    const prepared=await prepareComicPage({name:'page',blob:new Blob([bytes],{type:'application/octet-stream'})});
    expect(prepared.blob.type).toBe('image/png');expect(prepared.imageSha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(close).toHaveBeenCalledOnce();
  });
  it('rejects oversized decoded dimensions and always releases the bitmap',async()=>{
    const close=vi.fn();vi.stubGlobal('createImageBitmap',async()=>({width:40000,height:200,close}));
    await expect(prepareComicPage({name:'huge',blob:new Blob([new Uint8Array([255,216,255])],{type:'image/jpeg'})})).rejects.toThrow('尺寸');expect(close).toHaveBeenCalledOnce();
  });
  it('refuses an unsupported payload before handing it to an image decoder',async()=>{
    const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);
    await expect(prepareComicPage({name:'page',blob:new Blob(['<svg><script>test</script></svg>'],{type:'image/png'})})).rejects.toThrow('无法解码');expect(decode).not.toHaveBeenCalled();
  });
});
