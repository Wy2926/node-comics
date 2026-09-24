import 'fake-indexeddb/auto';
import {describe,it,expect,vi} from 'vitest';
import {TranslationCoordinator} from '../src/translation/coordinator';
import {makeOperation,operationId} from '../src/translation/automatic';
import {readOperation,saveOperation} from '../src/translation/store';
import {pageReference} from '../src/comics/pages/identity';
import {fixture,target,originalBytes,job,origin,snapshot} from './translation-fixture';
import {loadResultBlob,resultInMemory,resultBlobKey} from '../src/storage/translations/results';
import {setTranslationCacheLimitMb,translationCache} from '../src/storage/translations';

describe('content identity and recoverable source references',()=>{
 it('freezes document revision/page/profile without file hash or durable blob key',async()=>{
  const ref={entryId:'document',contentId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const page={...target(0).page,...ref,blobKey:pageReference(ref)};
  const operation=await makeOperation({...target(0),page},'owner','en',async()=>originalBytes(0));
  expect(operation.pageRef).toEqual(ref);expect(operation.blobKey).toBeUndefined();
  expect(operation.image).not.toHaveProperty('file_hash');expect(operation.image).not.toHaveProperty('page_index');
  expect(operation.image.sha256).toBe(page.imageSha256);
 });
 it('reopens frozen source after cache loss, preserving the original operation key',async()=>{
  const f=fixture(),ref={entryId:'document',contentId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const wanted={...target(0),page:{...target(0).page,...ref,blobKey:pageReference(ref)}};
  const record=await makeOperation(wanted,f.core.scope,'zh-Hans',async()=>originalBytes(0));
  record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.translations).mockImplementation(async()=>({unchanged:false,etag:'"1"',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]}));
  const upload=vi.spyOn(f.api,'translationInput').mockResolvedValue(snapshot(record.requestId,record.request));
  const release=vi.fn(),readOriginal=vi.fn(async()=>({blob:originalBytes(0),release}));
  const core=new TranslationCoordinator({...f.core.options,readOriginal,getBlob:async()=>{throw Error('not a Blob key');}});
  await core.submit([wanted]);await core.finishUploads();expect(upload).toHaveBeenCalledOnce();expect(readOriginal).toHaveBeenCalledWith(ref);expect(release).toHaveBeenCalledOnce();expect((await readOperation(operationId(core.scope,'zh-Hans',wanted)))?.requestId).toBe(record.requestId);expect(f.submit).not.toHaveBeenCalled();
 });
 it('stops a changed source before uploading and keeps the receipt',async()=>{
  const f=fixture(),record=await makeOperation(target(0),f.core.scope,'zh-Hans',async()=>originalBytes(0));record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.translations).mockImplementation(async()=>({unchanged:false,etag:'"1"',missing_ids:[],items:[snapshot(record.requestId,record.request,{state:'needs_input'})]}));
  const upload=vi.spyOn(f.api,'translationInput'),core=new TranslationCoordinator({...f.core.options,getBlob:async()=>new Blob(['changed'])});
  await core.submit([target(0)]);await core.finishUploads();expect(upload).not.toHaveBeenCalled();const saved=await readOperation(record.id);expect(saved?.state).toBe('blocked');expect(saved?.requestId).toBe(record.requestId);expect(saved?.result?.id).toBe(record.requestId);
 });
 it('disabling result cache still delivers memory bytes without regenerating',async()=>{
  await setTranslationCacheLimitMb(0);const result=job(9,{id:crypto.randomUUID(),status:'succeeded',output_asset_id:'output'}),blob=new Blob(['result']),download=vi.fn(async()=>blob);
  try{await loadResultBlob({origin,userId:'no-cache',job:result,download,isCurrent:()=>true});const key=resultBlobKey(origin,'no-cache',result);expect(await translationCache.get(key)).toBeUndefined();expect(resultInMemory(key)).toBe(blob);expect(download).toHaveBeenCalledOnce();}finally{await setTranslationCacheLimitMb(1024);}
 });
});
