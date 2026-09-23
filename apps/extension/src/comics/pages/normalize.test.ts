import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {prepareComicPage} from './normalize';
afterEach(()=>vi.unstubAllGlobals());
describe('materialized image normalization',()=>{
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
