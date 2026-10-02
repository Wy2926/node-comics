import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {prepareTranslationInput,restoreTranslationInput} from '../src/translation/input/prepare';
import {INPUT_PROFILE,TRANSLATION_JPEG_MAX_DIMENSION,TRANSLATION_REENCODE_BYTES} from '../src/translation/input/limits';
import {ImageOutputTooLargeError} from '../src/translation/input/resize';
import {hashFile} from '../src/importers/hash';
import {makeOperation} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation,saveOperation} from '../src/translation/channels/adapters/nodelane/store';
import {fixture,target,snapshot} from './translation-fixture';
import type {Page} from '../src/types';

const workerFactory=vi.hoisted(()=>vi.fn());
vi.mock('../src/translation/input/resize.worker?worker',()=>({default:class {constructor(){return workerFactory();}}}));
const source=new Blob(['original AVIF bytes'],{type:'image/avif'});
function webp(bytes=32){
  const header=new Uint8Array(20),view=new DataView(header.buffer);
  header.set(new TextEncoder().encode('RIFF'));view.setUint32(4,12+bytes,true);
  header.set(new TextEncoder().encode('WEBPVP8 '),8);view.setUint32(16,bytes,true);
  return new Blob([header,new Uint8Array(bytes)],{type:'image/webp'});
}
const encoded=webp(),encode=vi.fn(async()=>encoded),close=vi.fn();
async function page(blob=source):Promise<Page>{
  return {id:'avif',name:'AVIF page',width:800,height:1200,imageMime:blob.type,
    imageByteSize:blob.size,imageSha256:await hashFile(blob),jobs:[],outputBlobs:{}};
}
beforeEach(()=>{
  encode.mockReset();encode.mockResolvedValue(encoded);
  vi.stubGlobal('Worker',undefined);
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:800,height:1200,close})));
  vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){} getContext(){return {drawImage:vi.fn()};}convertToBlob=encode;});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});

describe('official AVIF input conversion',()=>{
  it.each([false,true])('keeps a larger supported encoding for an AVIF above 1 MiB=%s without changing its original identity',async large=>{
    const original=large?new Blob([new Uint8Array(TRANSLATION_REENCODE_BYTES+1)],{type:'image/avif'}):source;
    const output=large?webp(original.size+1):encoded;encode.mockResolvedValue(output);
    const inputPage=await page(original),before={...inputPage},read=vi.fn(async()=>original);
    const result=await prepareTranslationInput(inputPage,read,()=>true);
    expect(output.size).toBeGreaterThan(original.size);
    expect(result).toMatchObject({width:800,height:1200,sourceSha256:inputPage.imageSha256,profile:INPUT_PROFILE,
      image:{sha256:await hashFile(output),byte_size:output.size,content_type:'image/webp'}});
    expect(result.blob).toBe(output);expect(result.image.sha256).not.toBe(inputPage.imageSha256);
    expect(inputPage).toEqual(before);expect(original.type).toBe('image/avif');
    expect(read).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/webp',quality:0.9});
  });
  it('rejects required AVIF conversion above the encoder dimension limit before reading pixels',async()=>{
    const read=vi.fn(),inputPage={...await page(),height:TRANSLATION_JPEG_MAX_DIMENSION+1};
    await expect(prepareTranslationInput(inputPage,read,()=>true)).rejects.toThrow('尺寸');
    expect(read).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('does not fall back to AVIF when its required encoding exceeds the output budget',async()=>{
    const error=new ImageOutputTooLargeError();encode.mockRejectedValueOnce(error);
    await expect(prepareTranslationInput(await page(),async()=>source,()=>true)).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });
  it('applies the channel byte limit to the converted copy instead of reusing a smaller AVIF',async()=>{
    const limits={max_bytes:source.size+1,max_dimension:100000,max_pixels:100000**2,max_translation_ids:32};
    await expect(prepareTranslationInput(await page(),async()=>source,()=>true,limits)).rejects.toThrow('大小限制');
    expect(encode).toHaveBeenCalledOnce();
  });
  it('restores the supported copy with its frozen profile and rejects a changed output hash',async()=>{
    const result=await prepareTranslationInput(await page(),async()=>source,()=>true);
    expect(await restoreTranslationInput(source,result.width,result.height,result.sourceSha256,result.image.sha256,()=>true,result.profile)).toBe(encoded);
    encode.mockResolvedValueOnce(webp(34));
    await expect(restoreTranslationInput(source,result.width,result.height,result.sourceSha256,result.image.sha256,()=>true,result.profile)).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    expect(encode).toHaveBeenCalledTimes(3);
  });
  it('marks an unrecoverable frozen current-profile input as changed instead of repeatedly retrying encoding',async()=>{
    await expect(restoreTranslationInput(source,800,TRANSLATION_JPEG_MAX_DIMENSION+1,await hashFile(source),await hashFile(encoded),()=>true,INPUT_PROFILE)).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
  });
  it('uses the existing Worker path and freezes the conversion profile',async()=>{
    vi.stubGlobal('Worker',class {});
    const sha256=await hashFile(encoded),worker={onmessage:null as null|((event:{data:{blob:Blob;sha256:string}})=>void),onerror:null as null|(()=>void),
      postMessage:vi.fn(()=>queueMicrotask(()=>worker.onmessage!({data:{blob:encoded,sha256}}))),terminate:vi.fn()};
    workerFactory.mockReturnValue(worker);
    const result=await prepareTranslationInput(await page(),async()=>source,()=>true);
    expect(result).toMatchObject({profile:INPUT_PROFILE,sourceSha256:await hashFile(source),image:{sha256,content_type:'image/webp'}});
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({blob:source,width:800,height:1200,profile:INPUT_PROFILE});
    expect(worker.terminate).toHaveBeenCalledOnce();expect(encode).not.toHaveBeenCalled();
  });
  it('rebuilds an old rejected AVIF only after an explicit retry, with a new UUID and the unchanged source identity',async()=>{
    const f=fixture(),t=target(1);Object.assign(t.page,await page());
    f.core.options.getBlob=vi.fn(async()=>source);
    const originalHash=await hashFile(source),old=makeOperation(t,f.core.scope,'zh-Hans',{width:t.page.width,height:t.page.height,sourceSha256:originalHash,
      image:{sha256:originalHash,byte_size:source.size,content_type:'image/avif',normalization_version:1}});
    old.state='blocked';old.errorCode='INVALID_REQUEST';old.error='AVIF descriptor rejected';await saveOperation(old);
    await f.core.submit([t]);await f.core.submit([t]);
    expect(f.submit).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
    expect(await readOperation(old.id)).toEqual(old);
    const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id,blob)=>{
      expect(blob.type).toBe('image/webp');expect(await hashFile(blob)).toBe(await hashFile(encoded));
      return snapshot(id,{image:{sha256:await hashFile(blob),byte_size:blob.size,content_type:blob.type,normalization_version:1},mode:'classic',target_language:'zh-Hans'});
    });
    f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_input'}));
    await f.core.manual(t);await f.core.finishUploads();await f.core.submit([t]);
    const current=(await readOperation(old.id))!;
    expect(current.requestId).not.toBe(old.requestId);expect(current.sourceSha256).toBe(originalHash);
    expect(current.image).toMatchObject({sha256:await hashFile(encoded),content_type:'image/webp'});
    expect(current.inputProfile).toBe(INPUT_PROFILE);expect(t.page.imageSha256).toBe(originalHash);
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(current.requestId,expect.objectContaining({image:expect.objectContaining({content_type:'image/webp'})}));
    expect(upload).toHaveBeenCalledOnce();expect(encode).toHaveBeenCalledOnce();
  });
  it.each([
    {mime:'image/avif',code:'DAILY_QUOTA_EXHAUSTED'},
    {mime:'image/png',code:'INVALID_REQUEST'},
  ])('keeps the existing retry identity for $mime rejected with $code',async({mime,code})=>{
    const f=fixture(),t=target(1),old=makeOperation(t,f.core.scope,'zh-Hans',{width:t.page.width,height:t.page.height,sourceSha256:t.page.imageSha256,
      image:{sha256:t.page.imageSha256,byte_size:t.page.imageByteSize,content_type:mime,normalization_version:1}});
    old.state='blocked';old.errorCode=code;await saveOperation(old);
    await f.core.manual(t);
    expect((await readOperation(old.id))?.requestId).toBe(old.requestId);
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(old.requestId,old.request);expect(encode).not.toHaveBeenCalled();
  });
});
