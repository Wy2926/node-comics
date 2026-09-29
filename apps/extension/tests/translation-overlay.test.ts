import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {hashFile} from '../src/importers/hash';
import * as hashing from '../src/importers/hash';
import {materializeResult} from '../src/translation/materialize';
import {artifactBlobKey,loadDeliveredResult,resultBlobKey} from '../src/storage/translations/results';
import {translationCache} from '../src/storage/translations';
import {invalidateResultMemory} from '../src/storage/translations/memory';
import type {Job,TranslationResult} from '../src/types';

const original=new Blob(['original'],{type:'image/png'}),patch=new Blob(['overlay'],{type:'image/webp'});
let result:TranslationResult;
const draw=vi.fn(),close=vi.fn(),convert=vi.fn(async()=>new Blob(['composed'],{type:'image/png'}));
let context:{drawImage:typeof draw;globalCompositeOperation:string;imageSmoothingEnabled:boolean};
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
  it('accepts a full redraw whose output dimensions differ from the hashed source',async()=>{
    const descriptor={...result,representation:'full-image-v1' as const,width:4,height:5,bbox:undefined,composite:undefined};
    expect(await materializeResult(descriptor,original,patch)).toBe(patch);
    expect(convert).not.toHaveBeenCalled();expect(draw).not.toHaveBeenCalled();
  });
  it('persists only the patch and can recompose from disk without another download',async()=>{
    const scope={key:crypto.randomUUID()},job:Job={id:crypto.randomUUID(),result:{key:result.artifact!.sha256,recoverable:true},delivery:result,mode:'classic',target_language:'en',status:'succeeded',phase:'succeeded',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
    const download=vi.fn(async()=>patch),read={scope,job,original:async()=>original,download,isCurrent:()=>true};
    const hashes=vi.spyOn(hashing,'hashFile');
    expect(await(await loadDeliveredResult(read)).text()).toBe('composed');
    expect(hashes.mock.calls.filter(([blob])=>blob.type==='image/webp')).toHaveLength(1);
    expect(await translationCache.get(resultBlobKey(scope,job))).toBeUndefined();
    expect(await(await translationCache.get(artifactBlobKey(scope,job)))!.text()).toBe('overlay');
    invalidateResultMemory();await loadDeliveredResult(read);expect(download).toHaveBeenCalledOnce();expect(convert).toHaveBeenCalledTimes(2);
    expect(hashes.mock.calls.filter(([blob])=>blob.type==='image/webp')).toHaveLength(2);
    invalidateResultMemory();await expect(loadDeliveredResult({...read,original:async()=>undefined})).rejects.toMatchObject({code:'ORIGINAL_UNAVAILABLE'});expect(download).toHaveBeenCalledOnce();
  });
  it('never caches unverified bytes and evicts corrupt artifacts before a download-only retry',async()=>{
    const scope={key:crypto.randomUUID()},job:Job={id:crypto.randomUUID(),result:{key:result.artifact!.sha256,recoverable:true},delivery:result,mode:'classic',target_language:'en',status:'succeeded',phase:'succeeded',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
    const bad=new Blob(['invalid'],{type:patch.type}),download=vi.fn(async()=>bad);
    const read={scope,job,original:async()=>original,download,isCurrent:()=>true};
    await expect(loadDeliveredResult(read)).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
    expect(await translationCache.get(artifactBlobKey(scope,job))).toBeUndefined();
    await translationCache.put(artifactBlobKey(scope,job),bad,{owner:scope.key});
    await expect(loadDeliveredResult(read)).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
    expect(await translationCache.get(artifactBlobKey(scope,job))).toBeUndefined();
    download.mockResolvedValue(patch);
    expect(await(await loadDeliveredResult(read)).text()).toBe('composed');
    expect(download).toHaveBeenCalledTimes(2);
  });
});
