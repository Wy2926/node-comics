import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {prepareTranslationInput,restoreTranslationInput} from '../src/translation/input/prepare';
import {prepareComicPage} from '../src/comics/pages/normalize';
import * as metadata from '../src/comics/pages/image-metadata';
import {hashFile} from '../src/importers/hash';
import {materializeResult} from '../src/translation/materialize';
import type {Page,TranslationResult} from '../src/types';
import * as png from '../../../backend/shared/translation-images/png';

const workerFactory=vi.hoisted(()=>vi.fn());
vi.mock('../src/translation/input/resize.worker?worker',()=>({default:class {constructor(){return workerFactory();}}}));
const source=new Blob([new Uint8Array([255,216,255,224]),new Uint8Array(1024*1024)],{type:'image/jpeg'});
const page=(width=1800,height=26000):Page=>({id:'boundary',name:'Synthetic long source',width,height,imageByteSize:source.size,imageMime:source.type,jobs:[],outputBlobs:{}});
const close=vi.fn(),draw=vi.fn();
const canvases:{width:number;height:number}[]=[];
beforeEach(()=>{
  close.mockReset();draw.mockReset();
  vi.stubGlobal('Worker',undefined);
  vi.stubGlobal('createImageBitmap',vi.fn(async(_blob:Blob,options?:ImageBitmapOptions)=>({width:options?.resizeWidth??1800,height:options?.resizeHeight??26000,close})));
  vi.stubGlobal('OffscreenCanvas',class {
    constructor(public width:number,public height:number){canvases.push(this);}
    getContext(){return {drawImage:draw,getImageData:(_x:number,_y:number,width:number,height:number)=>({data:new Uint8ClampedArray(width*height*4)})};}
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
  it('reuses exact source bytes only when optional same-size PNG encoding exceeds its output budget',async()=>{
    outputLimit();const prepared=await prepareTranslationInput(page(),async()=>source,()=>true);
    expect(prepared.image).toMatchObject({sha256:await hashFile(source),byte_size:source.size,content_type:'image/jpeg'});
    expect(prepared.blob).toBeUndefined();expect(prepared.profile).toBeUndefined();expect(close).toHaveBeenCalledOnce();
  });
  it('does not reuse an oversized source or skip required resizing',async()=>{
    outputLimit();
    await expect(prepareTranslationInput(page(2400,26000),async()=>source,()=>true)).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);
    await expect(prepareTranslationInput(page(),async()=>source,()=>true,{max_bytes:source.size-1,max_dimension:100000,max_pixels:100000**2,max_translation_ids:100})).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);
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
  it('never substitutes source bytes when rebuilding frozen encoded input',async()=>{
    outputLimit();const sha=await hashFile(source);
    await expect(restoreTranslationInput(source,1800,26000,sha,sha,()=>true)).rejects.toBeInstanceOf(png.ImageOutputTooLargeError);
    expect(close).toHaveBeenCalledOnce();
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
