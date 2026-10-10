import 'fake-indexeddb/auto';
import {describe,it,expect,vi} from 'vitest';
import {TranslationCoordinator} from '../src/translation/channels/adapters/nodelane/coordinator';
import {makeOperation,operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation,saveOperation,saveSync} from '../src/translation/channels/adapters/nodelane/store';
import {PDF_RENDER_PROFILE,RENDER_PROFILE,pageReference} from '../src/comics/pages/identity';
import {fixture,target,originalBytes,originalInput,job,origin,snapshot} from './translation-fixture';
import {loadResultBlob,resultInMemory,resultBlobKey} from '../src/storage/translations/results';
import {setTranslationCacheLimitMb,translationCache} from '../src/storage/translations';

describe('content identity and recoverable source references',()=>{
 it('silently drops preparation that left the reading window without an account error',async()=>{
  const f=fixture(),page=target(0);let current=true,finish!:()=>void;
  const held=new Promise<void>(resolve=>{finish=resolve;});
  const prepareInput=vi.fn(async()=>{await held;return originalInput(0);});
  const core=new TranslationCoordinator({...f.core.options,prepareInput});
  const pending=core.submit([page],()=>current);
  await vi.waitFor(()=>expect(prepareInput).toHaveBeenCalledOnce());
  current=false;finish();await pending;
  expect(f.api.isCurrent()).toBe(true);expect(f.submit).not.toHaveBeenCalled();
  expect(page.page.translationError).toBeUndefined();
 });
 it('skips a departed target but admits an overlapping target from the same batch',async()=>{
  const f=fixture(),departed=target(0),retained=target(1);
  await f.core.submit([departed,retained],page=>page===retained);
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.submit.mock.calls[0][1]).toMatchObject({image:{sha256:retained.page.imageSha256}});
 });
 it('restores completed local receipts without remote verification or admission backoff on reentry',async()=>{
  const f=fixture(),page=target(0);
  f.submit.mockImplementation(async(id,body)=>snapshot(id,body,{state:'succeeded',result:{kind:'no_text',representation:'original',normalization_version:1,input_sha256:page.page.imageSha256!,width:800,height:1200}}));
  await f.core.submit([page]);await f.core.submit([]);
  await saveSync({id:f.core.scope,imageRetryAt:Date.now()+60000,controlRetryAt:Date.now()+60000});
  const restored=new TranslationCoordinator(f.core.options);
  f.onJobs.mockClear();await restored.restore([page]);
  expect(f.onJobs).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({status:'no_text',result:expect.anything()})]));
  await restored.submit([page]);expect(restored.retryDelay).toBe(0);
  expect(f.api.translations).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  await restored.submit([target(1)]);expect(restored.retryDelay).toBeGreaterThan(59000);
  expect(f.submit).toHaveBeenCalledOnce();
 });
 it('uses a separate render identity without recovering the old PDF operation',async()=>{
  const f=fixture(),ref={entryId:'book',contentId:'pdf-revision',pageId:'page-0',renderProfileId:RENDER_PROFILE};
  const oldTarget={...target(0),page:{...target(0).page,...ref,blobKey:pageReference(ref)}};
  const currentRef={...ref,renderProfileId:PDF_RENDER_PROFILE};
  const current={...target(1),page:{...target(1).page,...currentRef,blobKey:pageReference(currentRef)}};
  const previous=makeOperation(oldTarget,f.core.scope,'zh-Hans',originalInput(0));
  previous.state='accepted';previous.result=snapshot(previous.requestId,previous.request);await saveOperation(previous);
  expect(operationId(f.core.scope,'zh-Hans',{...oldTarget,page:{...oldTarget.page,renderProfileId:undefined}})).toBe(previous.id);
  const core=new TranslationCoordinator({...f.core.options,getBlob:async()=>originalBytes(1)});
  await core.submit([current]);await core.submit([current]);
  expect(f.api.translations).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  expect(f.submit.mock.calls[0][0]).not.toBe(previous.requestId);
  expect(f.submit.mock.calls[0][1]).toMatchObject({image:{sha256:current.page.imageSha256}});
  expect(await readOperation(operationId(core.scope,'zh-Hans',current))).toMatchObject({pageRef:currentRef});
  expect(await readOperation(previous.id)).toEqual(previous);
 });
 it('freezes document revision/page/profile without file hash or durable blob key',async()=>{
  const ref={entryId:'document',contentId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const page={...target(0).page,...ref,blobKey:pageReference(ref)};
  const operation=makeOperation({...target(0),page},'owner','en',originalInput(0));
  expect(operation.pageRef).toEqual(ref);expect(operation.blobKey).toBeUndefined();
  expect(operation.image).not.toHaveProperty('file_hash');expect(operation.image).not.toHaveProperty('page_index');
  expect(operation.image.sha256).toBe(page.imageSha256);
 });
 it('reopens frozen source after cache loss, preserving the original operation key',async()=>{
  const f=fixture(),ref={entryId:'document',contentId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const wanted={...target(0),page:{...target(0).page,...ref,blobKey:pageReference(ref)}};
  const record=makeOperation(wanted,f.core.scope,'zh-Hans',originalInput(0));
  record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.translations).mockImplementation(async()=>({unchanged:false,etag:'"1"',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]}));
  const upload=vi.spyOn(f.api,'translationInput').mockResolvedValue(snapshot(record.requestId,record.request));
  const release=vi.fn(),readOriginal=vi.fn(async()=>({blob:originalBytes(0),release}));
  const core=new TranslationCoordinator({...f.core.options,readOriginal,getBlob:async()=>{throw Error('not a Blob key');}});
  await core.submit([wanted]);await core.finishUploads();expect(upload).toHaveBeenCalledOnce();expect(readOriginal).toHaveBeenCalledWith(ref);expect(release).toHaveBeenCalledOnce();expect((await readOperation(operationId(core.scope,'zh-Hans',wanted)))?.requestId).toBe(record.requestId);expect(f.submit).not.toHaveBeenCalled();
 });
 it('stops a changed source before uploading and keeps the receipt',async()=>{
  const f=fixture(),record=makeOperation(target(0),f.core.scope,'zh-Hans',originalInput(0));record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.translations).mockImplementation(async()=>({unchanged:false,etag:'"1"',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]}));
  const upload=vi.spyOn(f.api,'translationInput'),core=new TranslationCoordinator({...f.core.options,getBlob:async()=>new Blob(['changed'])});
  await core.submit([target(0)]);await core.finishUploads();expect(upload).not.toHaveBeenCalled();const saved=await readOperation(record.id);expect(saved?.state).toBe('blocked');expect(saved?.requestId).toBe(record.requestId);expect(saved?.result?.id).toBe(record.requestId);
 });
 it('disabling result cache still delivers memory bytes without regenerating',async()=>{
  await setTranslationCacheLimitMb(0);const scope={key:JSON.stringify([origin,'no-cache'])},result=job(9,{id:crypto.randomUUID(),status:'succeeded'}),blob=new Blob(['result']),download=vi.fn(async()=>blob);
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:800,height:1200,close(){}})));
  try{await loadResultBlob({scope,job:result,download,isCurrent:()=>true});const key=resultBlobKey(scope,result);expect(await translationCache.get(key)).toBeUndefined();expect(resultInMemory(key)).toBe(blob);expect(download).toHaveBeenCalledOnce();}finally{await setTranslationCacheLimitMb(1024);vi.unstubAllGlobals();}
 });
});
