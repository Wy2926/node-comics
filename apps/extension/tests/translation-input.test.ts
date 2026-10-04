import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {prepareTranslationInput,restoreTranslationInput} from '../src/translation/input/prepare';
import {readInput,cacheInput,INPUT_BUDGET_BYTES} from '../src/translation/input/cache';
import {loadTranslationInput} from '../src/translation/input/load';
import {ByteCache} from '../src/storage/cache';
import {setTranslationCacheLimitMb} from '../src/storage/translations';
import {INPUT_PROFILE,LEGACY_INPUT_PROFILE,translationSize} from '../src/translation/input/limits';
import {hashFile} from '../src/importers/hash';
import {matchesPage} from '../src/translation/sync';
import {TranslationCoordinator,translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
import {readOperation,saveOperation,saveReceipt,readJobs} from '../src/translation/channels/adapters/nodelane/store';
import {operationId,makeOperation} from '../src/translation/channels/adapters/nodelane/operations';
import {ApiError} from '../src/api';
import {canvasJpeg,canvasWebp} from '../src/translation/input/resize';
import * as png from '../../../backend/shared/translation-images/png';
import {fixture,target,snapshot,originalInput,originalBytes} from './translation-fixture';
import {jpegWithSize} from './image-encoding-fixture';

const encoded=new Blob(['RIFF',new Uint8Array([14,0,0,0]),'WEBPVP8 ',new Uint8Array([2,0,0,0]),'ok'],{type:'image/webp'}),close=vi.fn(),draw=vi.fn(),encode=vi.fn(async()=>encoded);
const inputs=new ByteCache({name:'translation-inputs-v1',budgetBytes:INPUT_BUDGET_BYTES});
beforeEach(async()=>{
  await inputs.clear();
  encode.mockReset();encode.mockResolvedValue(encoded);
  vi.stubGlobal('Worker',undefined);
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1800,height:3600,close})));
  vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){} getContext(){return {drawImage:draw,fillRect:vi.fn()};}convertToBlob=encode;});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();await setTranslationCacheLimitMb(1024);});
const large=()=>{const t=target(1);t.page.width=2400;t.page.height=4800;return t;};

it('shrinks the short edge once, preserves ratio and never upscales',()=>{
  expect(translationSize(2400,12000)).toEqual({width:1800,height:9000});
  expect(translationSize(800,12000)).toEqual({width:800,height:12000});
  expect(translationSize(3200,2400)).toEqual({width:2400,height:1800});
});
it('reuses unchanged bytes without reading, decoding or saving another input',async()=>{
  const read=vi.fn(),prepared=await prepareTranslationInput(target(1).page,read,()=>true);
  expect(prepared.image.sha256).toBe(target(1).page.imageSha256);expect(prepared.blob).toBeUndefined();
  expect(read).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
});
it.each([[900,1300],[0,0],[900,100001]])('uses actual source dimensions instead of unmaterialized layout %s x %s',async(width,height)=>{
  const source=jpegWithSize(800,20687,2*1024*1024),output=jpegWithSize(800,20687,128);
  const page={...target(1).page,width,height,imageSha256:undefined,imageByteSize:undefined,imageMime:undefined},before={...page};
  encode.mockResolvedValueOnce(output);
  const read=vi.fn(async()=>source),prepared=await prepareTranslationInput(page,read,()=>true);
  expect(prepared).toMatchObject({width:800,height:20687,sourceSha256:await hashFile(source),profile:INPUT_PROFILE,image:{byte_size:output.size,content_type:'image/jpeg'}});
  expect(page).toEqual(before);expect(read).toHaveBeenCalledOnce();expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(source,expect.objectContaining({resizeWidth:800,resizeHeight:20687}));
  expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/jpeg',quality:0.3});expect(close).toHaveBeenCalledOnce();
});
it('reads only bounded headers without decoding an unidentified small image',async()=>{
  const source=jpegWithSize(800,20687),page={...target(1).page,width:900,height:1300,imageSha256:undefined,imageByteSize:undefined};
  const prepared=await prepareTranslationInput(page,async()=>source,()=>true);
  expect(prepared).toMatchObject({width:800,height:20687,image:{sha256:await hashFile(source),byte_size:source.size,content_type:'image/jpeg'}});
  expect(prepared.blob).toBeUndefined();expect(prepared.profile).toBeUndefined();expect(createImageBitmap).not.toHaveBeenCalled();
});
it('rejects unreadable unidentified input instead of encoding layout placeholders',async()=>{
  const page={...target(1).page,imageSha256:undefined};
  await expect(prepareTranslationInput(page,async()=>new Blob(['invalid'],{type:'image/png'}),()=>true)).rejects.toThrow('无法解码');
  expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
});
it.each([false,true])('negotiates actual unmaterialized long-image dimensions with tiles=%s before encoding or admission',async tiles=>{
  const f=fixture(),t=target(1),source=jpegWithSize(800,20687,2*1024*1024);
  const page={...t.page,width:900,height:1300,imageSha256:undefined,imageByteSize:undefined};
  encode.mockResolvedValueOnce(jpegWithSize(800,20687));
  const core=new TranslationCoordinator({...f.core.options,tiles:()=>tiles,getBlob:async()=>source});
  await core.submit([{...t,page}]);
  if(tiles){
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.any(String),expect.objectContaining({result_format:'overlay-tiles-v1',image:expect.objectContaining({content_type:'image/jpeg'})}));
    expect(encode).toHaveBeenCalledOnce();
  }else{
    expect(page.translationError).toBe('翻译服务暂不可用');expect(f.submit).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
  }
});
it('uses durably prepared screenshot bytes without re-encoding on submit or recovery',async()=>{
  const f=fixture(),wanted=target(1),prepareInput=vi.fn(async()=>originalInput(1));
  // Its byte size would normally trigger another optional lossy encode.
  wanted.page.imageByteSize=2*1024*1024;
  const core=new TranslationCoordinator({...f.core.options,prepareInput});
  await core.submit([wanted]);await core.submit([wanted]);
  expect(prepareInput).toHaveBeenCalledOnce();expect(encode).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  const restored=new TranslationCoordinator({...f.core.options,prepareInput});await restored.submit([wanted]);
  expect(prepareInput).toHaveBeenCalledOnce();expect(encode).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
});
it('does not admit a screenshot when its mandatory frozen-input preparation fails',async()=>{
  const f=fixture(),wanted=target(1),prepareInput=vi.fn(async()=>{throw Error('snapshot storage unavailable');});
  const core=new TranslationCoordinator({...f.core.options,prepareInput});await core.submit([wanted]);
  expect(f.submit).not.toHaveBeenCalled();expect(await readOperation(operationId(core.scope,'zh-Hans',wanted))).toBeUndefined();
});
it('keeps source identity separate and encodes only once',async()=>{
  const f=fixture(),t=large(),before={...t.page};await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  expect(t.page).toEqual(before);expect(record.sourceSha256).toBe(t.page.imageSha256);
  expect(record.inputProfile).toBe(INPUT_PROFILE);
  expect(record.image.sha256).toBe(await hashFile(encoded));expect(record.inputSize).toEqual({width:1800,height:3600});
  expect(await hashFile((await readInput(f.core.scope,record.image.sha256))!)).toBe(await hashFile(encoded));
  expect(matchesPage(t.page,translationJob(record.result!,record))).toBe(true);
  await f.core.submit([t]);expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/webp',quality:.9});expect(close).toHaveBeenCalledOnce();
});
it('negotiates long delivery explicitly and retains the same frozen UUID on window updates',async()=>{
  const f=fixture(),t=target(1);t.page.width=64;t.page.height=100000;
  const core=new TranslationCoordinator({...f.core.options,tiles:()=>true});
  await core.submit([t]);await core.submit([t]);
  expect(f.submit).toHaveBeenCalledOnce();expect(f.submit.mock.calls[0][1]).toMatchObject({result_format:'overlay-tiles-v1'});
  expect(createImageBitmap).not.toHaveBeenCalled();
});
it('refuses an unsupported long result format before acquiring source pixels or creating a paid request',async()=>{
  const f=fixture(),t=target(1);t.page.width=64;t.page.height=100000;t.page.imageByteSize=2*1024*1024;
  await f.core.submit([t]);
  expect(t.page.translationError).toBe('翻译服务暂不可用');expect(f.core.records).toHaveLength(0);
  expect(f.submit).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
});
it('rejects excessive strips before acquiring source pixels',async()=>{
  const read=vi.fn(),page={...target(1).page,width:800,height:20000};
  await expect(prepareTranslationInput(page,read,()=>true,{max_bytes:128*1024*1024,max_pixels:32_000_000,max_dimension:16000,max_translation_ids:32})).rejects.toThrow('尺寸');
  expect(read).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
});
it('uses the current center dimension ceiling without an independent source-pixel limit',async()=>{
  const read=vi.fn();
  const strip={...target(1).page,width:1000,height:100000};
  const prepared=await prepareTranslationInput(strip,read,()=>true);
  expect(prepared).toMatchObject({width:1000,height:100000,image:{sha256:strip.imageSha256}});
  const largePage={...target(1).page,width:8000,height:6000};
  await prepareTranslationInput(largePage,async()=>originalBytes(1),()=>true);
  expect(encode).toHaveBeenCalledOnce();
  await expect(prepareTranslationInput({...strip,height:100001},read,()=>true)).rejects.toThrow('尺寸');
  expect(read).not.toHaveBeenCalled();
});
it.each([65501,65535,100000])('reuses admissible same-size input with edge %i beyond the JPEG limit without decoding or encoding it',async height=>{
  const source=new Blob([new Uint8Array(1024*1024+1)],{type:'image/png'}),sha=await hashFile(source);
  const page={...target(1).page,width:800,height,imageByteSize:source.size,imageSha256:sha,imageMime:source.type};
  const result=await prepareTranslationInput(page,async()=>source,()=>true);
  expect(result).toMatchObject({width:800,height,image:{sha256:sha,byte_size:source.size,content_type:'image/png'}});
  expect(result.blob).toBeUndefined();expect(result.profile).toBeUndefined();expect(createImageBitmap).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
});
it('rejects required resized input beyond the JPEG limit before reading or decoding its source',async()=>{
  const read=vi.fn(),page={...target(1).page,width:2400,height:100000};
  await expect(prepareTranslationInput(page,read,()=>true)).rejects.toThrow('尺寸');
  expect(read).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
});
it('compresses a large narrow strip without changing its dimensions',async()=>{
  const source=new Blob([new Uint8Array(1024*1024+1)],{type:'image/png'}),sha=await hashFile(source);
  const page={...target(1).page,width:800,height:12000,imageByteSize:source.size,imageSha256:sha};
  const result=await prepareTranslationInput(page,async()=>source,()=>true);
  expect(result).toMatchObject({width:800,height:12000,sourceSha256:sha,image:{content_type:'image/webp'}});
  expect(result.blob).toBe(encoded);expect(result.profile).toBeDefined();expect(encode).toHaveBeenCalledOnce();
});
it('retains original bytes if same-size recompression would grow the file',async()=>{
  const source=new Blob([new Uint8Array(1024*1024+1)],{type:'image/jpeg'}),sha=await hashFile(source);
  const header=new Uint8Array(20),view=new DataView(header.buffer);header.set(new TextEncoder().encode('RIFF'));view.setUint32(4,source.size+21,true);header.set(new TextEncoder().encode('WEBPVP8 '),8);view.setUint32(16,source.size+8,true);
  encode.mockResolvedValueOnce(new Blob([header,new Uint8Array(source.size+8),new Uint8Array(1)],{type:'image/webp'}));
  const page={...target(1).page,imageByteSize:source.size,imageSha256:sha,imageMime:source.type};
  const result=await prepareTranslationInput(page,async()=>source,()=>true);
  expect(result.image.sha256).toBe(sha);expect(result.image.content_type).toBe(source.type);expect(result.blob).toBeUndefined();expect(result.profile).toBeUndefined();
});
it('removes only canvas metadata and preserves alpha flags and compressed pixel bytes',async()=>{
  const chunk=(name:string,data:Uint8Array<ArrayBuffer>)=>{const header=new Uint8Array(8);header.set(new TextEncoder().encode(name));new DataView(header.buffer).setUint32(4,data.length,true);return new Blob([header,data,...(data.length%2?[new Uint8Array(1)]:[])]);};
  const vp8x=new Uint8Array(10);vp8x[0]=0x20|0x10;
  const chunks=[chunk('VP8X',vp8x),chunk('ICCP',new Uint8Array([1,2,3])),chunk('VP8 ',new Uint8Array([77,88]))],header=new Uint8Array(12);
  header.set(new TextEncoder().encode('RIFF'));header.set(new TextEncoder().encode('WEBP'),8);new DataView(header.buffer).setUint32(4,chunks.reduce((n,b)=>n+b.size,4),true);
  const clean=await canvasWebp(new Blob([header,...chunks],{type:'image/webp'})),bytes=new Uint8Array(await clean.arrayBuffer());
  expect(new DataView(bytes.buffer).getUint32(4,true)).toBe(clean.size-8);expect(bytes[20]).toBe(0x10);expect([...bytes.slice(-2)]).toEqual([77,88]);expect(await clean.text()).not.toContain('ICCP');
});
it('strips canvas JPEG EXIF and ICC without changing quantization or scan bytes',async()=>{
  const segment=(marker:number,data:number[])=>new Uint8Array([255,marker,0,data.length+2,...data]);
  const header=new Uint8Array([255,216]),jfif=segment(0xe0,[74,70]),quant=segment(0xdb,[42,43]),scan=new Uint8Array([255,218,0,2,70,255,0,80,255,217]);
  const plain=new Blob([header,jfif,quant,scan],{type:'image/jpeg'});
  const tagged=new Blob([header,jfif,segment(0xe1,[69,88]),segment(0xe2,[73,67]),quant,scan],{type:'image/jpeg'});
  expect(await canvasJpeg(plain)).toBe(plain);
  expect(await (await canvasJpeg(tagged)).arrayBuffer()).toEqual(await plain.arrayBuffer());
});
it.each([
  new Blob(['not JPEG'],{type:'image/jpeg'}),
  new Blob([new Uint8Array([255,216,255,225,0,1])],{type:'image/jpeg'}),
  new Blob([new Uint8Array([255,216,255,225,0,8,1])],{type:'image/jpeg'}),
  new Blob([new Uint8Array([255,216])],{type:'image/png'}),
])('rejects malformed or unavailable canvas JPEG output',async blob=>{
  await expect(canvasJpeg(blob)).rejects.toThrow();
});
it('recovery verifies the frozen output hash instead of assuming deterministic encoders',async()=>{
  const source=new Blob(['source']),sha=await hashFile(source);
  expect(await restoreTranslationInput(source,1800,3600,sha,await hashFile(encoded),()=>true)).toBe(encoded);
  await expect(restoreTranslationInput(source,1800,3600,sha,'a'.repeat(64),()=>true)).rejects.toThrow('变化');
});
it('shared input loading returns unprocessed source bytes without cache or encoding work',async()=>{
  const source=originalBytes(0),read=vi.fn(async()=>source),get=vi.spyOn(ByteCache.prototype,'get');
  expect(await loadTranslationInput('scope',{sha256:originalInput(0).image.sha256},read,()=>true)).toBe(source);
  expect(read).toHaveBeenCalledOnce();expect(get).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
});
it('shared input loading rebuilds once and then skips the source on a cache hit',async()=>{
  const scope=crypto.randomUUID(),source=originalBytes(0),read=vi.fn(async()=>source);
  const input={sha256:await hashFile(encoded),sourceSha256:await hashFile(source),profile:'short-edge-1800-webp90-v1' as const,size:{width:1800,height:3600}};
  expect(await loadTranslationInput(scope,input,read,()=>true)).toBe(encoded);
  expect(await hashFile((await loadTranslationInput(scope,input,read,()=>true))!)).toBe(input.sha256);
  expect(read).toHaveBeenCalledOnce();expect(encode).toHaveBeenCalledOnce();
});
it.each([LEGACY_INPUT_PROFILE,INPUT_PROFILE])('restores evicted long input with its frozen encoder profile %s',async profile=>{
  const scope=crypto.randomUUID(),source=originalBytes(0),read=vi.fn(async()=>source);
  const legacy=new Blob(['frozen legacy PNG'],{type:'image/png'}),current=jpegWithSize(800,20000);
  const pngEncode=vi.spyOn(png,'bitmapPng').mockResolvedValue(legacy);encode.mockResolvedValueOnce(current);
  vi.mocked(createImageBitmap).mockResolvedValue({width:800,height:20000,close} as unknown as ImageBitmap);
  const output=profile===LEGACY_INPUT_PROFILE?legacy:current;
  const input={sha256:await hashFile(output),sourceSha256:await hashFile(source),profile,size:{width:800,height:20000}};
  expect(await loadTranslationInput(scope,input,read,()=>true)).toBe(output);
  expect(await hashFile((await loadTranslationInput(scope,input,read,()=>true))!)).toBe(input.sha256);
  expect(read).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  if(profile===LEGACY_INPUT_PROFILE){expect(pngEncode).toHaveBeenCalledOnce();expect(encode).not.toHaveBeenCalled();}
  else {expect(pngEncode).not.toHaveBeenCalled();expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/jpeg',quality:expect.any(Number)});}
});
it('shared input loading stops on cancellation, missing source or mismatched bytes without caching them',async()=>{
  const scope=crypto.randomUUID(),source=originalBytes(0),read=vi.fn(async()=>source),put=vi.spyOn(ByteCache.prototype,'put');
  const input={sha256:'a'.repeat(64),sourceSha256:await hashFile(source),profile:'short-edge-1800-webp90-v1' as const,size:{width:1800,height:3600}};
  await expect(loadTranslationInput(scope,input,read,()=>false)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  expect(await loadTranslationInput(scope,input,async()=>undefined,()=>true)).toBeUndefined();expect(encode).not.toHaveBeenCalled();
  await expect(loadTranslationInput(scope,input,read,()=>true)).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  expect(put).not.toHaveBeenCalled();expect(await readInput(scope,input.sha256)).toBeUndefined();
});
it('shared input loading returns verified bytes even if the cache write is refused',async()=>{
  const source=originalBytes(0),input={sha256:await hashFile(encoded),sourceSha256:await hashFile(source),profile:'short-edge-1800-webp90-v1' as const,size:{width:1800,height:3600}};
  vi.spyOn(ByteCache.prototype,'put').mockResolvedValue(false);
  expect(await loadTranslationInput(crypto.randomUUID(),input,async()=>source,()=>true)).toBe(encoded);
});
it('does not automatically re-encode a permanently mismatching restored input',async()=>{
  const f=fixture(),t=large();await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  await inputs.clear();
  record.image.sha256='a'.repeat(64);await saveOperation(record);
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:'input',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]});
  const upload=vi.spyOn(f.api,'translationInput');
  const reopened=new TranslationCoordinator(f.core.options);await reopened.submit([t]);await reopened.finishUploads();
  expect(await readOperation(record.id)).toMatchObject({state:'blocked',errorCode:'SOURCE_CHANGED',retryAt:undefined});
  const calls=encode.mock.calls.length;
  await reopened.submit([t]);await reopened.finishUploads();
  const again=new TranslationCoordinator(f.core.options);await again.submit([t]);await again.finishUploads();
  expect(encode).toHaveBeenCalledTimes(calls);expect(upload).not.toHaveBeenCalled();
});
it('reopens terminal metadata without scanning or changing the input cache',async()=>{
  const f=fixture(),t=large();await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  record.result=snapshot(record.requestId,record.request,{state:'failed'});await saveOperation(record);
  const remove=vi.spyOn(ByteCache.prototype,'delete'),get=vi.spyOn(ByteCache.prototype,'get'),inventory=vi.spyOn(ByteCache.prototype,'inventory');
  await new TranslationCoordinator(f.core.options).init();
  expect(remove).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(inventory).not.toHaveBeenCalled();
});
it('watches only the reading window and recovers prepared requests when revisited',async()=>{
  const f=fixture(),t=large();await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  vi.mocked(f.api.translations).mockClear();
  await f.core.submit([]);await f.core.submit([]);await f.core.submit([]);
  expect(f.api.translations).not.toHaveBeenCalled();expect(f.core.waitingIds).toEqual([]);
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:'revisit',missing_ids:[],items:[record.result!]});
  await f.core.submit([t]);expect(f.api.translations).toHaveBeenCalledOnce();expect(f.core.waitingIds).toEqual([record.requestId]);
});
it('isolates cached input by account and frozen content hash',async()=>{
  const scope=crypto.randomUUID(),other=crypto.randomUUID();
  const sha=await hashFile(encoded);await cacheInput(scope,sha,encoded);
  expect(await readInput(scope,sha)).toBeDefined();expect(await readInput(other,sha)).toBeUndefined();expect(await readInput(scope,'different')).toBeUndefined();
});
it('still saves and uploads the same request if optional input persistence fails',async()=>{
  const f=fixture(),t=large();vi.spyOn(ByteCache.prototype,'put').mockResolvedValue(false);
  f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_input'}));
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id)=>snapshot(id,f.submit.mock.calls[0][1]));
  await f.core.submit([t]);await f.core.finishUploads();
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  expect(record.state).toBe('accepted');expect(upload).toHaveBeenCalledOnce();expect(upload.mock.calls[0][0]).toBe(record.requestId);
  expect(await hashFile(upload.mock.calls[0][1])).toBe(record.image.sha256);expect(encode).toHaveBeenCalledTimes(2);
});
it('evicts old input at capacity without blocking a new request when result caching is disabled',async()=>{
  await setTranslationCacheLimitMb(0);
  const scope=crypto.randomUUID(),full=new Blob([new Uint8Array(INPUT_BUDGET_BYTES)]);
  expect(await cacheInput(scope,'old',full)).toBe(true);
  const f=fixture(),t=large();await f.core.submit([t]);
  expect(f.submit).toHaveBeenCalledOnce();expect(await readInput(scope,'old')).toBeUndefined();
  expect(await readInput(f.core.scope,await hashFile(encoded))).toBeDefined();
  expect((await inputs.usage()).bytes).toBe(encoded.size);
});
it('discards obsolete queued image work before reading or decoding another large page',async()=>{
  let release!:()=>void,current=true;
  encode.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(encoded);}));
  const t=large(),f=fixture(),first=prepareTranslationInput(t.page,()=>f.core.options.getBlob(t.page.blobKey!),()=>true);
  await vi.waitFor(()=>expect(encode).toHaveBeenCalledOnce());
  const read=vi.fn(),second=prepareTranslationInput(t.page,read,()=>current);
  const rejected=expect(second).rejects.toThrow();current=false;release();
  await first;await rejected;
  expect(read).not.toHaveBeenCalled();expect(createImageBitmap).toHaveBeenCalledOnce();
});
it.each([false,true])('reopens the frozen UUID after input cache eviction=%s',async evicted=>{
  const f=fixture(),t=large();await f.core.submit([t]);const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  if(evicted)await inputs.clear();
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:'new',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]});
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id,blob)=>{expect(await hashFile(blob)).toBe(record.image.sha256);return snapshot(id,record.request);});
  const reopened=new TranslationCoordinator(f.core.options);await reopened.submit([t]);await reopened.finishUploads();
  expect(upload).toHaveBeenCalledOnce();expect(upload.mock.calls[0][0]).toBe(record.requestId);expect(encode).toHaveBeenCalledTimes(evicted?2:1);expect(f.submit).toHaveBeenCalledOnce();
});
it.each(['cached','restored','changed'] as const)('upload owns and releases source leases for %s input',async kind=>{
  const f=fixture(),t=large();await f.core.submit([t]);const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  record.pageRef={entryId:'book',contentId:'revision',pageId:t.page.id,renderProfileId:'original-v2-static-srgb'};record.blobKey=undefined;await saveOperation(record);
  if(kind!=='cached')await inputs.clear();
  const release=vi.fn(),readOriginal=vi.fn(async()=>({blob:kind==='changed'?new Blob(['changed']):originalBytes(1),release}));
  vi.mocked(f.api.translations).mockResolvedValue({unchanged:false,etag:'lease',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]});
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async id=>snapshot(id,record.request));
  const reopened=new TranslationCoordinator({...f.core.options,readOriginal});await reopened.submit([t]);await reopened.finishUploads();
  expect(readOriginal).toHaveBeenCalledTimes(kind==='cached'?0:1);expect(release).toHaveBeenCalledTimes(kind==='cached'?0:1);
  if(kind==='changed'){expect(upload).not.toHaveBeenCalled();expect(await readOperation(record.id)).toMatchObject({state:'blocked',errorCode:'SOURCE_CHANGED'});}
  else expect(upload).toHaveBeenCalledWith(record.requestId,expect.any(Blob));
});
it.each(['failed','succeeded'] as const)('reuses frozen scaled metadata and cached bytes for explicit retry of %s without another encoding',async state=>{
  const f=fixture(),t=large();await f.core.submit([t]);
  const previous=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  previous.result=snapshot(previous.requestId,previous.request,{state});await saveOperation(previous);
  f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_input'}));
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id)=>snapshot(id,previous.request));
  await f.core.manual(t);await f.core.finishUploads();
  const next=(await readOperation(previous.id))!;
  expect(next.requestId).not.toBe(previous.requestId);expect(next.request).toEqual(state==='failed'?{retry_of:previous.requestId}:{regenerate_of:previous.requestId});
  expect(next.image).toEqual(previous.image);expect(next.inputSize).toEqual(previous.inputSize);expect(next.inputProfile).toBe(previous.inputProfile);
  expect(upload).toHaveBeenCalledOnce();expect(await hashFile(upload.mock.calls[0][1])).toBe(previous.image.sha256);expect(encode).toHaveBeenCalledOnce();
});
it.each([true,false])('rebuilds a mis-sized no-text upload only on explicit retry, with local operation=%s',async stored=>{
  const f=fixture(),t=target(1),source=jpegWithSize(800,20687,2*1024*1024),sha=await hashFile(source),output=jpegWithSize(800,20687);
  Object.assign(t.page,{width:800,height:20687,imageSha256:sha,imageByteSize:source.size,imageMime:source.type,translationScope:f.core.scope});
  const previous=makeOperation(t,f.core.scope,'zh-Hans',{image:{sha256:await hashFile(encoded),byte_size:encoded.size,content_type:'image/webp'},sourceSha256:sha,width:900,height:1300,profile:INPUT_PROFILE});
  previous.state='accepted';previous.result=snapshot(previous.requestId,previous.request,{state:'succeeded',result:{kind:'no_text',representation:'original',width:900,height:1300,input_sha256:previous.image.sha256,normalization_version:1}});
  t.page.jobs=[translationJob(previous.result,previous)];
  const core=new TranslationCoordinator({...f.core.options,tiles:()=>true,getBlob:async()=>source});
  if(stored){
    await saveReceipt(previous,t.page.jobs[0]);
    vi.mocked(f.api.translations).mockResolvedValue({items:[previous.result],missing_ids:[],unchanged:false,etag:'no-text'});
    await core.submit([t]);await core.submit([t]);
    expect(f.submit).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
    expect((await readOperation(previous.id))?.requestId).toBe(previous.requestId);
  }
  encode.mockResolvedValueOnce(output);
  f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_input'}));
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id,blob)=>{
    expect(await hashFile(blob)).toBe(await hashFile(output));return snapshot(id,f.submit.mock.calls[0][1]);
  });
  await core.manual(t);await core.finishUploads();
  const next=(await readOperation(previous.id))!;
  expect(next.requestId).not.toBe(previous.requestId);expect(next.sourceSha256).toBe(sha);
  expect(next.inputSize).toEqual({width:800,height:20687});expect(next.image.sha256).not.toBe(previous.image.sha256);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(next.requestId,expect.objectContaining({image:next.image,result_format:'overlay-tiles-v1'}));
  expect(next.request).not.toHaveProperty('regenerate_of');expect(upload).toHaveBeenCalledOnce();expect(encode).toHaveBeenCalledOnce();
  expect(next.image).toMatchObject({byte_size:output.size,content_type:'image/jpeg'});
  if(stored)expect((await readJobs(core.scope,[sha])).map(job=>job.id)).toContain(previous.requestId);
  await expect(core.manual(t)).rejects.toThrow('核实');expect(f.submit).toHaveBeenCalledOnce();
});
it.each(['needs_input','queued','running','needs_attention'] as const)('never replaces a mis-sized upload while the original is %s',async state=>{
  const f=fixture(),t=large(),previous=makeOperation(t,f.core.scope,'zh-Hans',{...originalInput(1),width:900,height:1300,profile:INPUT_PROFILE});
  previous.state='accepted';previous.result=snapshot(previous.requestId,previous.request,{state});await saveOperation(previous);
  await expect(f.core.manual(t)).rejects.toThrow('核实');
  expect((await readOperation(previous.id))?.requestId).toBe(previous.requestId);expect(f.submit).not.toHaveBeenCalled();expect(encode).not.toHaveBeenCalled();
});
it('rejects changed page identity before reusing frozen input for a manual retry',async()=>{
  const f=fixture(),t=large();await f.core.submit([t]);
  const previous=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  previous.result=snapshot(previous.requestId,previous.request,{state:'failed'});await saveOperation(previous);
  t.page.imageSha256='b'.repeat(64);
  await expect(f.core.manual(t)).rejects.toThrow('变化');
  expect((await readOperation(previous.id))?.requestId).toBe(previous.requestId);expect(f.submit).toHaveBeenCalledOnce();expect(encode).toHaveBeenCalledOnce();
});
it('preserves a prior unscaled image when retry_of inherits its frozen server input',async()=>{
  const f=fixture(),t=large(),old=makeOperation(t,f.core.scope,'zh-Hans',{...originalInput(1),width:t.page.width,height:t.page.height});
  old.state='accepted';old.result=snapshot(old.requestId,old.request,{state:'failed'});await saveOperation(old);
  await f.core.manual(t);expect(f.submit.mock.calls[0][1]).toEqual({retry_of:old.requestId});
  const current=(await readOperation(old.id))!;expect(current.image.sha256).toBe(old.image.sha256);expect(current.inputProfile).toBeUndefined();expect(encode).not.toHaveBeenCalled();
});
it('reconstructs evicted bytes with the same UUID after a quota rejection and explicit retry',async()=>{
  const f=fixture(),t=large();f.submit.mockRejectedValueOnce(new ApiError('quota','DAILY_QUOTA_EXHAUSTED',403));await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;await inputs.clear();
  f.submit.mockImplementationOnce(async(id,body)=>snapshot(id,body,{state:'needs_input'}));
  const upload=vi.spyOn(f.api,'translationInput').mockImplementation(async(id,blob)=>{expect(await hashFile(blob)).toBe(record.image.sha256);return snapshot(id,record.request);});
  await f.core.manual(t);await f.core.finishUploads();expect(upload).toHaveBeenCalledOnce();expect(f.submit.mock.calls[1][0]).toBe(record.requestId);
});
