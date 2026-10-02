import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compositeImage} from '../../../backend/shared/translation-images/composite';
import * as png from '../../../backend/shared/translation-images/png';
import {jpegWithSize} from './image-encoding-fixture';

const convert=vi.fn(async ({type}:{type:string})=>new Blob(['encoded'],{type}));
const alpha=vi.fn(()=>({data:new Uint8ClampedArray([10,20,30,255])}));
const draw=vi.fn();const surfaces:{width:number;height:number}[]=[];
const base=(width:number,height:number)=>({width,height,close:vi.fn()}) as unknown as ImageBitmap;
beforeEach(()=>{
  convert.mockReset();alpha.mockClear();draw.mockClear();surfaces.length=0;
  convert.mockImplementation(async({type})=>{
    const {width,height}=surfaces.at(-1)!;
    return type==='image/jpeg'?jpegWithSize(width,height):new Blob(['encoded'],{type});
  });
  vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){surfaces.push(this);}getContext(){return {drawImage:draw,getImageData:alpha};}convertToBlob=convert;});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('complete-result encoding without touching frozen inputs',()=>{
  it('uses one high-quality WebP encode at native dimensions for ordinary pages',async()=>{
    const result=await compositeImage(base(1200,1600),[],'image/png');
    expect(result.type).toBe('image/webp');expect(convert).toHaveBeenCalledExactlyOnceWith({type:'image/webp',quality:.95});
    expect(alpha).not.toHaveBeenCalled();expect(surfaces[0]).toMatchObject({width:1,height:1});
  });
  it('uses JPEG for opaque long pages without scanning known-opaque JPEG input',async()=>{
    const result=await compositeImage(base(800,30000),[],'image/jpeg');
    expect(result.type).toBe('image/jpeg');expect(convert).toHaveBeenCalledExactlyOnceWith({type:'image/jpeg',quality:.95});expect(alpha).not.toHaveBeenCalled();
  });
  it('keeps real transparency on a long page instead of flattening it',async()=>{
    alpha.mockReturnValueOnce({data:new Uint8ClampedArray([10,20,30,128])});
    expect((await compositeImage(base(800,20000),[],'image/png')).type).toBe('image/png');expect(alpha).toHaveBeenCalledOnce();
  });
  it('allows opaque PNG long sources to use JPEG',async()=>{
    expect((await compositeImage(base(8,20000),[],'image/png')).type).toBe('image/jpeg');expect(alpha).toHaveBeenCalled();
  });
  it.each([[64,65500],[65500,64]])('encodes the exact JPEG boundary %i x %i without another bitmap decode',async(width,height)=>{
    const result=await compositeImage(base(width,height),[],'image/jpeg');
    expect(result.type).toBe('image/jpeg');expect(convert).toHaveBeenCalledOnce();expect(alpha).not.toHaveBeenCalled();
  });
  it.each([[64,65501],[65501,64],[64,65535],[65535,64],[64,100000],[100000,64],[9000,9000]])('streams exceptional %i x %i pages without a full-page canvas',async(width,height)=>{
    const stream=vi.spyOn(png,'bitmapPng').mockResolvedValue(new Blob(['png'],{type:'image/png'}));const image=base(width,height);
    expect((await compositeImage(image,[],'image/jpeg')).type).toBe('image/png');
    expect(stream).toHaveBeenCalledExactlyOnceWith(image,[]);expect(surfaces).toHaveLength(0);expect(convert).not.toHaveBeenCalled();
  });
  it('releases the native surface before a bounded fallback when the browser encoder rejects it',async()=>{
    convert.mockRejectedValueOnce(Error('encoder limit'));
    vi.spyOn(png,'bitmapPng').mockImplementation(async()=>{expect(surfaces[0]).toMatchObject({width:1,height:1});return new Blob(['png']);});
    await compositeImage(base(800,50000),[],'image/jpeg');expect(convert).toHaveBeenCalledOnce();
  });
  it('streams the original dimensions if a successful JPEG encode silently crops pixels',async()=>{
    const image=base(64,30000),fallback=new Blob(['complete PNG'],{type:'image/png'});
    convert.mockResolvedValueOnce(jpegWithSize(64,29999));
    const stream=vi.spyOn(png,'bitmapPng').mockImplementation(async()=>{
      expect(surfaces[0]).toMatchObject({width:1,height:1});return fallback;
    });
    expect(await compositeImage(image,[],'image/jpeg')).toBe(fallback);
    expect(stream).toHaveBeenCalledExactlyOnceWith(image,[]);expect(convert).toHaveBeenCalledOnce();
  });
});
