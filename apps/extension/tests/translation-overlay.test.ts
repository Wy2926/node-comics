import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {hashFile} from '../src/importers/hash';
import * as hashing from '../src/importers/hash';
import {materializeResult,validateResult} from '../src/translation/materialize';
import {loadDeliveredResult,resultBlobKey} from '../src/storage/translations/results';
import {setTranslationCacheLimitMb,translationCache} from '../src/storage/translations';
import {invalidateResultMemory,resultInMemory} from '../src/storage/translations/memory';
import type {Job,TranslationResult} from '../src/types';
import {englishDictionary,installDictionary} from '../src/i18n/runtime';

const original=new Blob(['original'],{type:'image/png'}),patch=new Blob(['overlay'],{type:'image/webp'});
let result:TranslationResult;
const draw=vi.fn(),close=vi.fn(),convert=vi.fn(async()=>new Blob(['composed'],{type:'image/png'}));
let context:{drawImage:typeof draw;globalCompositeOperation:string;imageSmoothingEnabled:boolean};
function deliveredRead(){
  const scope={key:crypto.randomUUID()},job:Job={id:crypto.randomUUID(),result:{key:result.artifact!.sha256,recoverable:true},delivery:result,mode:'classic',target_language:'en',status:'succeeded',phase:'succeeded',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
  return {scope,job,original:vi.fn(async():Promise<Blob|undefined>=>original),download:vi.fn(async()=>patch),isCurrent:()=>true};
}
beforeEach(async()=>{
  result={kind:'translated',representation:'overlay-v1',normalization_version:1,input_sha256:await hashFile(original),width:8,height:12,bbox:{x:2,y:3,width:4,height:5},composite:'source-atop',artifact:{sha256:await hashFile(patch),byte_size:patch.size,mime:patch.type,path:'/v1/translations/test/result'}};
  draw.mockClear();close.mockClear();convert.mockClear();context={drawImage:draw,globalCompositeOperation:'source-over',imageSmoothingEnabled:true};
  vi.stubGlobal('createImageBitmap',vi.fn(async(blob:Blob)=>({width:blob.type==='image/webp'?4:8,height:blob.type==='image/webp'?5:12,close})));
  vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){}getContext(){return context;}convertToBlob=convert;});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();invalidateResultMemory();});
describe('official translation overlays',()=>{
  it('composes at native dimensions with integer source-atop placement and releases decoded images',async()=>{
    expect(await(await materializeResult(result,original,patch)).text()).toBe('composed');
    expect(draw.mock.calls.map(call=>call.slice(1))).toEqual([[0,0],[2,3]]);
    expect(context.globalCompositeOperation).toBe('source-atop');expect(context.imageSmoothingEnabled).toBe(false);expect(close).toHaveBeenCalledTimes(2);
  });
  it('rejects another original without decoding or drawing',async()=>{
    await expect(materializeResult(result,new Blob(['different']),patch)).rejects.toThrow('原图内容');expect(draw).not.toHaveBeenCalled();
  });
  it('reports unavailable original instead of treating a patch as a complete image',async()=>{
    await expect(materializeResult(result,undefined,patch)).rejects.toMatchObject({code:'ORIGINAL_UNAVAILABLE'});expect(draw).not.toHaveBeenCalled();
  });
  it('localizes missing-source failures from both composition and cache recovery',async()=>{
    installDictionary('en',englishDictionary);
    try{
      const expected={code:'ORIGINAL_UNAVAILABLE',message:englishDictionary['原图不可用，请恢复所属来源或本地原图缓存。']};
      await expect(materializeResult(result,undefined,patch)).rejects.toMatchObject(expected);
      const read=deliveredRead();read.original.mockResolvedValue(undefined);
      await expect(loadDeliveredResult(read)).rejects.toMatchObject(expected);
    }finally{installDictionary('zh-CN',{});}
  });
  it.each([{bbox:{x:7,y:3,width:4,height:5}},{bbox:{x:1.5,y:3,width:4,height:5}},{normalization_version:2},{composite:'source-over'}])('rejects invalid frozen descriptors %j',async change=>{
    await expect(materializeResult({...result,...change} as TranslationResult,original,patch)).rejects.toThrow();expect(draw).not.toHaveBeenCalled();
  });
  it('rejects changed artifact bytes and wrong decoded patch dimensions',async()=>{
    await expect(materializeResult(result,original,new Blob(['invalid'],{type:patch.type}))).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
    vi.mocked(createImageBitmap).mockResolvedValue({width:8,height:12,close} as ImageBitmap);
    await expect(materializeResult(result,original,patch)).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});expect(close).toHaveBeenCalledTimes(2);
  });
  it('returns the exact original without downloading for no-text and unchanged translated results',async()=>{
    for(const kind of ['no_text','translated'] as const){
      const descriptor={...result,kind,representation:'original' as const,bbox:undefined,composite:undefined,artifact:null};
      expect(await materializeResult(descriptor,original)).toBe(original);
    }
    expect(convert).not.toHaveBeenCalled();
  });
  it('reads a frozen long result beyond the former pixel ceiling and still verifies its native dimensions',async()=>{
    const descriptor={...result,kind:'no_text' as const,representation:'original' as const,width:1000,height:100000,bbox:undefined,composite:undefined,artifact:null};
    vi.mocked(createImageBitmap).mockResolvedValue({width:1000,height:100000,close} as ImageBitmap);
    expect(await materializeResult(descriptor,original)).toBe(original);
    vi.mocked(createImageBitmap).mockResolvedValue({width:1000,height:100001,close} as ImageBitmap);
    expect(await materializeResult({...descriptor,height:100001},original)).toBe(original);
    vi.mocked(createImageBitmap).mockResolvedValue({width:1000,height:100000,close} as ImageBitmap);
    await expect(materializeResult({...descriptor,height:100001},original)).rejects.toThrow('原图内容');
    expect(createImageBitmap).toHaveBeenCalledTimes(3);expect(convert).not.toHaveBeenCalled();
  });
  it('accepts large delivered file descriptors and still checks exact artifact bytes',async()=>{
    const descriptor={...result,representation:'full-image-v1' as const,width:100001,height:5,bbox:undefined,composite:undefined,
      artifact:{...result.artifact!,byte_size:129*1024*1024}};
    expect(()=>validateResult(descriptor)).not.toThrow();
    await expect(materializeResult(descriptor,undefined,patch)).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('accepts a full-image result whose output dimensions differ from the hashed source',async()=>{
    const descriptor={...result,representation:'full-image-v1' as const,width:4,height:5,bbox:undefined,composite:undefined};
    expect(await materializeResult(descriptor,original,patch)).toBe(patch);
    expect(convert).not.toHaveBeenCalled();expect(draw).not.toHaveBeenCalled();
  });
  it('persists only the complete image and reopens it without the source, download, hashing or composition',async()=>{
    const read=deliveredRead(),key=resultBlobKey(read.scope,read.job);
    const hashes=vi.spyOn(hashing,'hashFile');
    expect(await(await loadDeliveredResult(read)).text()).toBe('composed');
    const cached=await translationCache.get(key);expect(cached?.type).toBe('image/png');expect(await cached!.text()).toBe('composed');
    expect((await translationCache.inventory([read.scope.key])).map(item=>item.key)).toEqual([key]);
    invalidateResultMemory();hashes.mockClear();vi.mocked(createImageBitmap).mockClear();
    read.original.mockRejectedValue(Error('source offline'));read.download.mockRejectedValue(Error('network offline'));
    expect(await(await loadDeliveredResult(read)).text()).toBe('composed');
    expect(read.original).toHaveBeenCalledOnce();expect(read.download).toHaveBeenCalledOnce();expect(convert).toHaveBeenCalledOnce();
    expect(hashes).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('never caches unverified bytes and retries downloading the same result',async()=>{
    const read=deliveredRead(),key=resultBlobKey(read.scope,read.job);
    read.download.mockResolvedValueOnce(new Blob(['invalid'],{type:patch.type}));
    await expect(loadDeliveredResult(read)).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
    expect(await translationCache.get(key)).toBeUndefined();expect(resultInMemory(key)).toBeUndefined();
    expect(await translationCache.inventory([read.scope.key])).toEqual([]);
    expect(await(await loadDeliveredResult(read)).text()).toBe('composed');
    expect(read.download).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent reads into one download and composition',async()=>{
    const read=deliveredRead();
    const blobs=await Promise.all([loadDeliveredResult(read),loadDeliveredResult(read)]);
    expect(blobs[0]).toBe(blobs[1]);expect(read.original).toHaveBeenCalledOnce();expect(read.download).toHaveBeenCalledOnce();expect(convert).toHaveBeenCalledOnce();
  });
  it('requires the source only after the complete image has been evicted',async()=>{
    const read=deliveredRead();await loadDeliveredResult(read);
    await translationCache.delete(resultBlobKey(read.scope,read.job));read.original.mockResolvedValue(undefined);
    await expect(loadDeliveredResult(read)).rejects.toMatchObject({code:'ORIGINAL_UNAVAILABLE'});expect(read.download).toHaveBeenCalledOnce();
    read.original.mockResolvedValue(original);expect(await(await loadDeliveredResult(read)).text()).toBe('composed');expect(read.download).toHaveBeenCalledTimes(2);
  });
  it('keeps the complete image in memory when disk caching is disabled',async()=>{
    await setTranslationCacheLimitMb(0);
    try{
      const read=deliveredRead();await loadDeliveredResult(read);
      expect(await translationCache.has(resultBlobKey(read.scope,read.job))).toBe(false);
      read.original.mockRejectedValue(Error('source offline'));
      expect(await(await loadDeliveredResult(read)).text()).toBe('composed');expect(read.original).toHaveBeenCalledOnce();expect(convert).toHaveBeenCalledOnce();
    }finally{await setTranslationCacheLimitMb(1024);}
  });
  it.each(['clear','owner'])('does not resurrect complete images when %s invalidates an in-flight composition',async operation=>{
    const read=deliveredRead(),key=resultBlobKey(read.scope,read.job);
    convert.mockImplementationOnce(async()=>{
      if(operation==='clear')await translationCache.clear();else await translationCache.deleteOwner(read.scope.key,true);
      return new Blob(['composed'],{type:'image/png'});
    });
    await expect(loadDeliveredResult(read)).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});
    expect(await translationCache.has(key)).toBe(false);expect(resultInMemory(key)).toBeUndefined();
  });
});
