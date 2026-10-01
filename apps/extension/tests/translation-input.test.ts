import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {prepareTranslationInput,restoreTranslationInput} from '../src/translation/input/prepare';
import {readInput,cacheInput,INPUT_BUDGET_BYTES} from '../src/translation/input/cache';
import {loadTranslationInput} from '../src/translation/input/load';
import {ByteCache} from '../src/storage/cache';
import {setTranslationCacheLimitMb} from '../src/storage/translations';
import {translationSize} from '../src/translation/input/limits';
import {hashFile} from '../src/importers/hash';
import {matchesPage} from '../src/translation/sync';
import {TranslationCoordinator,translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
import {readOperation,saveOperation} from '../src/translation/channels/adapters/nodelane/store';
import {operationId,makeOperation} from '../src/translation/channels/adapters/nodelane/operations';
import {ApiError} from '../src/api';
import {canvasWebp} from '../src/translation/input/resize';
import {fixture,target,snapshot,originalInput,originalBytes} from './translation-fixture';

const encoded=new Blob(['RIFF',new Uint8Array([14,0,0,0]),'WEBPVP8 ',new Uint8Array([2,0,0,0]),'ok'],{type:'image/webp'}),close=vi.fn(),draw=vi.fn(),encode=vi.fn(async()=>encoded);
const inputs=new ByteCache({name:'translation-inputs-v1',budgetBytes:INPUT_BUDGET_BYTES});
beforeEach(async()=>{
  await inputs.clear();
  vi.stubGlobal('Worker',undefined);
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1800,height:3600,close})));
  vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){} getContext(){return {drawImage:draw};}convertToBlob=encode;});
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
it('keeps source identity separate and encodes only once',async()=>{
  const f=fixture(),t=large(),before={...t.page};await f.core.submit([t]);
  const record=(await readOperation(operationId(f.core.scope,'zh-Hans',t)))!;
  expect(t.page).toEqual(before);expect(record.sourceSha256).toBe(t.page.imageSha256);
  expect(record.image.sha256).toBe(await hashFile(encoded));expect(record.inputSize).toEqual({width:1800,height:3600});
  expect(await hashFile((await readInput(f.core.scope,record.image.sha256))!)).toBe(await hashFile(encoded));
  expect(matchesPage(t.page,translationJob(record.result!,record))).toBe(true);
  await f.core.submit([t]);expect(encode).toHaveBeenCalledExactlyOnceWith({type:'image/webp',quality:.9});expect(close).toHaveBeenCalledOnce();
});
it('rejects excessive strips before acquiring source pixels',async()=>{
  const read=vi.fn(),page={...target(1).page,width:800,height:20000};
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
