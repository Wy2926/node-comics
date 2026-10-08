import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {prepareTranslationInput,restoreTranslationInput} from '../src/translation/input/prepare';
import {INPUT_PROFILE,LEGACY_INPUT_PROFILE} from '../src/translation/input/limits';
import {prepareComicPage} from '../src/comics/pages/normalize';
import * as metadata from '../src/comics/pages/image-metadata';
import {hashFile} from '../src/importers/hash';
import {materializeResult} from '../src/translation/materialize';
import type {Page,TranslationResult} from '../src/types';
import * as png from '../../../backend/shared/translation-images/png';
import {resizeInput} from '../src/translation/input/resize';
import {jpegWithSize} from './image-encoding-fixture';

const workerFactory=vi.hoisted(()=>vi.fn());
vi.mock('../src/translation/input/resize.worker?worker',()=>({default:class {constructor(){return workerFactory();}}}));
const source=new Blob([new Uint8Array([255,216,255,224]),new Uint8Array(1024*1024)],{type:'image/jpeg'});
let sourceSha:string;
const page=(width=1800,height=26000):Page=>({id:'boundary',name:'Synthetic long source',width,height,imageSha256:sourceSha,imageByteSize:source.size,imageMime:source.type,jobs:[],outputBlobs:{}});
const close=vi.fn(),draw=vi.fn(),fill=vi.fn();
const jpeg=jpegWithSize(1800,26000),encode=vi.fn(async()=>jpeg);
const canvases:{width:number;height:number}[]=[];
beforeEach(async()=>{
  sourceSha=await hashFile(source);
  close.mockReset();draw.mockReset();fill.mockReset();
  encode.mockReset();encode.mockResolvedValue(jpeg);
  vi.stubGlobal('Worker',undefined);
  vi.stubGlobal('createImageBitmap',vi.fn(async(_blob:Blob,options?:ImageBitmapOptions)=>({width:options?.resizeWidth??1800,height:options?.resizeHeight??26000,close})));
  vi.stubGlobal('OffscreenCanvas',class {
    constructor(public width:number,public height:number){canvases.push(this);}
    getContext(){return {drawImage:draw,fillRect:fill,getImageData:(_x:number,_y:number,width:number,height:number)=>({data:new Uint8ClampedArray(width*height*4)})};}
    convertToBlob=encode;
  });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();canvases.length=0;});
const outputLimit=()=>vi.spyOn(png,'bitmapPng').mockRejectedValue(new png.ImageOutputTooLargeError());
function replyingWorker(error:string,beforeReply=()=>{}){
  vi.stubGlobal('Worker',class {});
  const worker={onmessage:null as null|((event:{data:{error:string}})=>void),onerror:null as null|(()=>void),
    postMessage:vi.fn(()=>queueMicrotask(()=>{beforeReply();worker.onmessage!({data:{error}});})),terminate:vi.fn()};
  workerFactory.mockReturnValue(worker);return worker;
}

describe('optional input encoding boundaries',()=>{
  it.each([[64,65500],[65500,64]])('preserves the actual JPEG encoder boundary %i x %i',async(width,height)=>{
    const output=jpegWithSize(width,height);encode.mockResolvedValueOnce(output);
    expect(await resizeInput(source,width,height)).toEqual({blob:output,sha256:await hashFile(output)});
    expect(createImageBitmap).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  });
  it.each([[64,65501],[65501,64],[64,65535],[65535,64]])('rejects JPEG encoding beyond its implementation boundary %i x %i before decoding',async(width,height)=>{
    await expect(resizeInput(source,width,height)).rejects.toThrow('IMAGE_DIMENSIONS_LIMIT');
    expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
  });
  it.each([[1799,26000],[1800,25999]])('rejects a successful encoder that silently crops to %i x %i',async(width,height)=>{
    encode.mockResolvedValueOnce(jpegWithSize(width,height));
    await expect(prepareTranslationInput(page(),async()=>source,()=>true)).rejects.toThrow('dimensions');
    expect(close).toHaveBeenCalledOnce();expect(canvases[0]).toMatchObject({width:1,height:1});
  });
  it('encodes a long new input as JPEG without a PNG attempt and releases the full canvas',async()=>{
    const pngEncode=vi.spyOn(png,'bitmapPng');
    const prepared=await prepareTranslationInput(page(),async()=>source,()=>true);
    expect(prepared).toMatchObject({width:1800,height:26000,profile:INPUT_PROFILE,image:{sha256:await hashFile(jpeg),byte_size:jpeg.size,content_type:'image/jpeg'}});
    expect(prepared.blob).toBe(jpeg);expect(pngEncode).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/jpeg',quality:expect.any(Number)});
    expect(fill).toHaveBeenCalledExactlyOnceWith(0,0,1800,26000);
    expect(canvases).toHaveLength(1);expect(canvases[0]).toMatchObject({width:1,height:1});
  });
  it('does not reuse source bytes when JPEG encoding fails during required resizing',async()=>{
    const error=Error('JPEG encoding failed');encode.mockRejectedValueOnce(error);
    await expect(prepareTranslationInput(page(2400,26000),async()=>source,()=>true)).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();expect(canvases.every(canvas=>canvas.width===1&&canvas.height===1)).toBe(true);
  });
  it('checks the service byte budget for both resized JPEG and unchanged source fallback',async()=>{
    encode.mockResolvedValueOnce(jpegWithSize(1800,19500,source.size)).mockResolvedValueOnce(jpegWithSize(1800,26000,source.size));
    const limits={max_bytes:source.size-1,max_dimension:100000,max_pixels:100000**2,max_translation_ids:100};
    await expect(prepareTranslationInput(page(2400,26000),async()=>source,()=>true,limits)).rejects.toThrow('大小限制');
    await expect(prepareTranslationInput(page(),async()=>source,()=>true,limits)).rejects.toThrow('大小限制');
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('does not hide actual image decode failures',async()=>{
    const error=new DOMException('Corrupt synthetic image','EncodingError');vi.mocked(createImageBitmap).mockRejectedValueOnce(error);
    await expect(prepareTranslationInput(page(),async()=>source,()=>true)).rejects.toBe(error);
    expect(close).not.toHaveBeenCalled();
  });
  it('keeps required source normalization failures fatal and releases its bitmap',async()=>{
    outputLimit();vi.spyOn(metadata,'needsNormalization').mockResolvedValue(true);
    await expect(prepareComicPage({name:'tagged long image',blob:source})).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);
    expect(close).toHaveBeenCalledOnce();
  });
  it('never substitutes source bytes when rebuilding legacy frozen PNG input',async()=>{
    outputLimit();const sha=await hashFile(source);
    await expect(restoreTranslationInput(source,1800,26000,sha,sha,()=>true,LEGACY_INPUT_PROFILE)).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([LEGACY_INPUT_PROFILE,INPUT_PROFILE])('passes frozen profile %s to a recovery Worker',async profile=>{
    vi.stubGlobal('Worker',class {});
    const sha256=await hashFile(jpeg),worker={onmessage:null as null|((event:{data:{blob:Blob;sha256:string}})=>void),onerror:null as null|(()=>void),
      postMessage:vi.fn(()=>queueMicrotask(()=>worker.onmessage!({data:{blob:jpeg,sha256}}))),terminate:vi.fn()};
    workerFactory.mockReturnValue(worker);
    expect(await restoreTranslationInput(source,1800,26000,await hashFile(source),sha256,()=>true,profile)).toBe(jpeg);
    expect(worker.postMessage).toHaveBeenCalledWith({blob:source,width:1800,height:26000,profile});expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('preserves the typed worker output-limit failure and terminates the worker before fallback',async()=>{
    const worker=replyingWorker('IMAGE_OUTPUT_TOO_LARGE'),prepared=await prepareTranslationInput(page(),async()=>source,()=>true);
    expect(prepared.image.sha256).toBe(await hashFile(source));expect(prepared.profile).toBeUndefined();expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('keeps worker decode failures and required resizing fatal',async()=>{
    const invalid=replyingWorker('IMAGE_INVALID');
    await expect(prepareTranslationInput(page(),async()=>source,()=>true)).rejects.toThrow('无法解码');expect(invalid.terminate).toHaveBeenCalledOnce();
    const oversized=replyingWorker('IMAGE_OUTPUT_TOO_LARGE');
    await expect(prepareTranslationInput(page(2400,26000),async()=>source,()=>true)).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);expect(oversized.terminate).toHaveBeenCalledOnce();
  });
  it('does not publish fallback input after the operation becomes stale',async()=>{
    let current=true;const worker=replyingWorker('IMAGE_OUTPUT_TOO_LARGE',()=>{current=false;});
    await expect(prepareTranslationInput(page(),async()=>source,()=>current)).rejects.toThrow('停止');expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe('streamed PNG bitmap ownership',()=>{
  function documentCanvas(){
    const canvas={width:0,height:0,getContext:()=>({drawImage:draw,getImageData:(_x:number,_y:number,width:number,height:number)=>({data:new Uint8ClampedArray(width*height*4)})})};
    const createElement=vi.fn(()=>{canvases.push(canvas);return canvas;});
    vi.stubGlobal('OffscreenCanvas',undefined);vi.stubGlobal('document',{createElement});
    return {canvas,createElement};
  }
  it('reuses a document canvas across columns without taking ownership of borrowed bitmaps',async()=>{
    const {canvas,createElement}=documentCanvas();
    const base={width:4097,height:1,close:vi.fn()} as unknown as ImageBitmap,patch={width:4097,height:1,close:vi.fn()} as unknown as ImageBitmap;
    const blob=await png.bitmapPng(base,[{x:0,y:0,width:4097,height:1,bitmap:patch}]);
    expect(blob.type).toBe('image/png');expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');
    expect(draw.mock.calls.filter(call=>call[0]===base)).toEqual([
      [base,0,0,2048,1,0,0,2048,1],[base,2048,0,2048,1,0,0,2048,1],[base,4096,0,1,1,0,0,1,1],
    ]);
    expect(draw.mock.calls.filter(call=>call[0]===patch)).toHaveLength(3);
    expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
    expect(base.close).not.toHaveBeenCalled();expect(patch.close).not.toHaveBeenCalled();expect(canvas).toMatchObject({width:1,height:1});
  });
  it('normalizes a long source through document canvas bands and releases both canvas and bitmap',async()=>{
    const {canvas,createElement}=documentCanvas(),base={width:1,height:16384,close} as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValue(base);vi.spyOn(metadata,'needsNormalization').mockResolvedValue(true);
    const prepared=await prepareComicPage({name:'document canvas long source',blob:source});
    expect(prepared).toMatchObject({width:1,height:16384,imageSha256:await hashFile(prepared.blob)});expect(prepared.blob.type).toBe('image/png');
    const dimensions=new DataView(await prepared.blob.slice(16,24).arrayBuffer());
    expect([dimensions.getUint32(0),dimensions.getUint32(4)]).toEqual([1,16384]);
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');expect(draw).toHaveBeenCalledTimes(4);
    expect(draw).toHaveBeenLastCalledWith(base,0,12288,1,4096,0,0,1,4096);
    expect(encode).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();expect(canvas).toMatchObject({width:1,height:1});
  });
  it('releases the document canvas and owned tile when streaming fails without closing the borrowed base',async()=>{
    const {canvas}=documentCanvas(),base={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap,tile={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValue(tile);draw.mockImplementation(bitmap=>{if(bitmap===tile)throw Error('Synthetic document drawing failure');});
    await expect(png.bitmapPng(base,[{x:0,y:0,width:2,height:2,blob:new Blob()}])).rejects.toThrow('Synthetic document drawing failure');
    expect(tile.close).toHaveBeenCalledOnce();expect(base.close).not.toHaveBeenCalled();expect(canvas).toMatchObject({width:1,height:1});
  });
  it('borrows a decoded patch across canvas columns without decoding or closing it',async()=>{
    const base={width:4097,height:1,close:vi.fn()} as unknown as ImageBitmap,patch={width:4097,height:1,close:vi.fn()} as unknown as ImageBitmap;
    expect((await png.bitmapPng(base,[{x:0,y:0,width:4097,height:1,bitmap:patch}])).type).toBe('image/png');
    expect(createImageBitmap).not.toHaveBeenCalled();expect(patch.close).not.toHaveBeenCalled();expect(base.close).not.toHaveBeenCalled();
    expect(draw.mock.calls.filter(call=>call[0]===patch)).toHaveLength(3);expect(canvases.every(canvas=>canvas.width===1&&canvas.height===1)).toBe(true);
  });
  it('reports an output-limit error without taking ownership of caller bitmaps',async()=>{
    const base={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap,patch={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap;
    await expect(png.bitmapPng(base,[{x:0,y:0,width:2,height:2,bitmap:patch}],1)).rejects.toMatchObject({code:'IMAGE_OUTPUT_TOO_LARGE'});
    expect(base.close).not.toHaveBeenCalled();expect(patch.close).not.toHaveBeenCalled();expect(canvases.every(canvas=>canvas.width===1&&canvas.height===1)).toBe(true);
  });
  it('closes owned tile bitmaps if drawing fails',async()=>{
    const base={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap,tile={width:2,height:2,close:vi.fn()} as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValue(tile);draw.mockImplementation(bitmap=>{if(bitmap===tile)throw Error('Synthetic drawing failure');});
    await expect(png.bitmapPng(base,[{x:0,y:0,width:2,height:2,blob:new Blob()}])).rejects.toThrow('Synthetic drawing failure');
    expect(tile.close).toHaveBeenCalledOnce();expect(base.close).not.toHaveBeenCalled();expect(canvases.every(canvas=>canvas.width===1&&canvas.height===1)).toBe(true);
  });
  it('lets the materializer close its borrowed patch and base exactly once after a stream failure',async()=>{
    const original=new Blob(['source']),artifact=new Blob(['patch'],{type:'image/webp'});
    const base={width:20000,height:1,close:vi.fn()} as unknown as ImageBitmap,patch={width:4097,height:1,close:vi.fn()} as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockImplementation(async blob=>blob===original?base:patch);
    draw.mockImplementation(bitmap=>{if(bitmap===patch)throw Error('Synthetic drawing failure');});
    const result:TranslationResult={kind:'translated',representation:'overlay-v1',normalization_version:1,input_sha256:await hashFile(original),width:20000,height:1,bbox:{x:0,y:0,width:4097,height:1},composite:'source-atop',artifact:{mime:artifact.type,byte_size:artifact.size,sha256:await hashFile(artifact),path:'unused-local-fixture'}};
    await expect(materializeResult(result,original,artifact)).rejects.toThrow('Synthetic drawing failure');
    expect(createImageBitmap).toHaveBeenCalledTimes(2);expect(base.close).toHaveBeenCalledOnce();expect(patch.close).toHaveBeenCalledOnce();
  });
});
