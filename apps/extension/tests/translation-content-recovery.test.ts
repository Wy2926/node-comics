import 'fake-indexeddb/auto';
import {describe,it,expect,vi} from 'vitest';
import {TranslationCoordinator} from '../src/translation/coordinator';
import {makeOperation,operationId} from '../src/translation/automatic';
import {readOperation,saveOperation} from '../src/translation/store';
import {pageReference} from '../src/comics/pages/identity';
import {fixture,target,originalBytes,job,origin} from './translation-fixture';
import {loadResultBlob,resultInMemory,resultBlobKey} from '../src/storage/translations/results';
import {setTranslationCacheLimitMb,translationCache} from '../src/storage/translations';

describe('content identity and recoverable source references',()=>{
 it('freezes document revision/page/profile without file hash or durable blob key',async()=>{
  const ref={documentId:'document',revisionId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const page={...target(0).page,...ref,blobKey:pageReference(ref)};
  const operation=await makeOperation({...target(0),page},'owner','en',undefined,async()=>originalBytes(0));
  expect(operation.pageRef).toEqual(ref);expect(operation.blobKey).toBeUndefined();
  expect(operation.item.image).not.toHaveProperty('file_hash');expect(operation.item.image).not.toHaveProperty('page_index');
  expect(operation.item.image.image_sha256).toBe(page.imageSha256);
 });
 it('reopens frozen source after cache loss, preserving the original operation key',async()=>{
  const f=fixture(),ref={documentId:'document',revisionId:'revision',pageId:'page-0',renderProfileId:'original-v1-gif-first-frame'};
  const wanted={...target(0),page:{...target(0).page,...ref,blobKey:pageReference(ref)}};
  const record=await makeOperation(wanted,f.core.scope,'zh-Hans',f.rights.modes.classic,async()=>originalBytes(0));
  record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.resolveOperations).mockImplementation(async()=>({items:[{operation_key:record.item.operation_key,disposition:'accepted',job:job(0,{status:'awaiting_upload'}),upload:{id:'upload',method:'PUT',url:origin+'/upload',headers:{},expires_at:'2099-01-01'}}]}));
  const upload=vi.spyOn(f.api,'uploadOriginal').mockResolvedValue(undefined);vi.spyOn(f.api,'completeUpload').mockResolvedValue(job(0));
  const release=vi.fn(),readOriginal=vi.fn(async()=>({blob:originalBytes(0),release}));
  const core=new TranslationCoordinator({...f.core.options,readOriginal,getBlob:async()=>{throw Error('not a Blob key');}});
  await core.recover();await core.finishUploads();expect(upload).toHaveBeenCalledOnce();expect(readOriginal).toHaveBeenCalledWith(ref);expect(release).toHaveBeenCalledOnce();expect((await readOperation(operationId(core.scope,'zh-Hans',wanted)))?.item.operation_key).toBe(record.item.operation_key);expect(f.plan).not.toHaveBeenCalled();
 });
 it('stops a changed source before uploading and keeps the receipt',async()=>{
  const f=fixture(),record=await makeOperation(target(0),f.core.scope,'zh-Hans',f.rights.modes.classic,async()=>originalBytes(0));record.state='uncertain';await saveOperation(record);
  vi.mocked(f.api.resolveOperations).mockImplementation(async()=>({items:[{operation_key:record.item.operation_key,disposition:'accepted',job:job(0,{status:'awaiting_upload'}),upload:{id:'upload',method:'PUT',url:origin+'/upload',headers:{},expires_at:'2099-01-01'}}]}));
  const upload=vi.spyOn(f.api,'uploadOriginal'),core=new TranslationCoordinator({...f.core.options,getBlob:async()=>new Blob(['changed'])});
  await core.recover();await core.finishUploads();expect(upload).not.toHaveBeenCalled();const saved=await readOperation(record.id);expect(saved?.state).toBe('blocked');expect(saved?.item.operation_key).toBe(record.item.operation_key);expect(saved?.result?.job?.id).toBe('job-0');
 });
 it('disabling result cache still delivers memory bytes without regenerating',async()=>{
  await setTranslationCacheLimitMb(0);const result=job(9,{id:crypto.randomUUID(),status:'succeeded',output_asset_id:'output'}),blob=new Blob(['result']),download=vi.fn(async()=>blob);
  try{await loadResultBlob({origin,userId:'no-cache',job:result,download,isCurrent:()=>true});const key=resultBlobKey(origin,'no-cache',result);expect(await translationCache.get(key)).toBeUndefined();expect(resultInMemory(key)).toBe(blob);expect(download).toHaveBeenCalledOnce();}finally{await setTranslationCacheLimitMb(1024);}
 });
});
