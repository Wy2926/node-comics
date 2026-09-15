import {Api,ApiError,submissionRejected} from '../api';
import {assertCurrent,mapConcurrent} from '../concurrency';
import type {Job,SubmissionReceipt} from '../types';
import {prepareChunk,readManifest,saveManifest,withManifestLock,type UploadManifest} from './store';

export function receiptJobs(receipt:SubmissionReceipt){return receipt.items.map(i=>i.job);}
export async function processManifest(options:{api:Api;manifest:UploadManifest;available:number;readingPageIds:string[];readingSessionId?:string;concurrency:number;getBlob:(key:string)=>Promise<Blob|undefined>;onJobs:(jobs:Job[])=>Promise<void>;onChange:()=>void}){
 const {api,getBlob,onJobs,onChange}=options;
 return withManifestLock(options.manifest.id,async()=>{
  let manifest=await readManifest(options.manifest.id);
  if(!manifest||manifest.paused||manifest.retryAt&&manifest.retryAt>Date.now())return;
  const persist=async()=>{await saveManifest(manifest!);onChange();};
  try{
   assertCurrent(api.isCurrent);
   if(!manifest.pending&&options.readingSessionId)manifest.readingSessionId=options.readingSessionId;
   manifest=prepareChunk(manifest,options.available,options.readingPageIds);
   if(!manifest.pending){if(manifest.paused)await persist();return;}
   await persist(); // Commit exact request and key before the first network operation.
   const pending=manifest.pending;
   const receipt=pending.submissionId?await api.submission(pending.submissionId):await api.submit(pending.body,pending.key);
   assertCurrent(api.isCurrent);
   if(receipt.items.length!==pending.body.items.length||receipt.items.some(item=>!pending.body.items.some(i=>i.client_item_id===item.client_item_id)))throw new ApiError('服务器回执与上传清单不一致，请核实该提交。','INVALID_RECEIPT');
   pending.submissionId=receipt.id;
   for(const received of receipt.items){const item=manifest.items.find(i=>i.id===received.client_item_id)!;item.job=received.job;item.state=received.job.status==='awaiting_upload'?'uploading':received.job.status==='validating_upload'?'verifying':'accepted';item.error=undefined;}
   await persist();await onJobs(receiptJobs(receipt));
   const outcomes=await mapConcurrent(receipt.items,options.concurrency,async received=>{
    assertCurrent(api.isCurrent);
    const item=manifest!.items.find(i=>i.id===received.client_item_id)!;
    if(received.job.status!=='awaiting_upload')return;
    try{
     if((await readManifest(manifest!.id))?.paused)throw new ApiError('本机补充已暂停，原图尚未上传。','UPLOAD_PAUSED');
     if(!received.upload)throw new ApiError('服务器尚未返回上传授权，请重试恢复。','UPLOAD_PLAN_MISSING');
     const blob=item.blobKey?await getBlob(item.blobKey):undefined;
     if(!blob)throw new ApiError('本地原图已清理，请重新导入后继续。','LOCAL_IMAGE_MISSING');
     assertCurrent(api.isCurrent);
     await api.uploadOriginal(received.upload,blob);
     item.state='verifying';await persist();
     const job=await api.completeUpload(received.upload.id);assertCurrent(api.isCurrent);
     item.job=job;item.state=job.status==='validating_upload'?'verifying':'accepted';item.error=undefined;
     await persist();await onJobs([job]);
    }catch(error){item.error=(error as Error).message;item.state='failed';await persist();throw error;}
   });
   assertCurrent(api.isCurrent);
   const failures=outcomes.filter(r=>r.status==='rejected');
   if(failures.length){manifest.error=`${failures.length} 页尚未上传完成；其他页面已独立受理。`;manifest.retryAt=Date.now()+15000;}
   else {manifest.pending=undefined;manifest.error=undefined;manifest.retryAt=undefined;}
   await persist();
  }catch(error){
   if(!api.isCurrent())return;
   if(submissionRejected(error)&&!manifest.pending?.submissionId){
    // A definitive rejection created no work. Capacity races may safely retry a new chunk.
    manifest.pending=undefined;
    manifest.paused=!(manifest.continuous&&error instanceof ApiError&&['QUEUE_CAPACITY_EXCEEDED','QUEUE_FULL','READING_UPLOAD_RESERVED','TOO_MANY_JOBS'].includes(error.code));
   }
   manifest.error=(error as Error).message+(manifest.pending&&!manifest.pending.submissionId?' 提交结果待核实，将使用原请求恢复。':'');
   manifest.retryAt=Date.now()+15000;await persist();
  }
 });
}
