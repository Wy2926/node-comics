import {Api, ApiError, submissionRejected} from '../api';
import {assertCurrent} from '../concurrency';
import {pageSource} from '../reader/recovery';
import {hashFile} from '../importers/hash';
import type {Mode, Page, QuotaKind, SubmissionInput} from '../types';

/** Claim shared results through the normal private authorization path, never a new computation. */
export async function claimFreeReuse(api:Api, ownerId:string, pages:Page[], mode:Mode, language:string, kind:QuotaKind, getBlob:(key:string)=>Promise<Blob|undefined>=async()=>undefined) {
  // Unlimited classic ignores the numeric quota bound. A finite expected kind
  // also prevents a concurrent upgrade from turning this probe into new work.
  if(kind==='classic_unlimited')throw Error('不限量权益不能使用零额度复用请求。');
  for(const page of pages) {
    assertCurrent(api.isCurrent);
    const source=pageSource(page);
    if(!source)continue;
    const blob=page.blobKey&&(!page.imageSha256||!page.imageByteSize||!page.imageMime)?await getBlob(page.blobKey):undefined;
    const sha=page.imageSha256??(blob?await hashFile(blob):undefined),size=blob?.size??page.imageByteSize,mime=blob?.type||page.imageMime;
    if(!sha||!size||!mime)continue;
    assertCurrent(api.isCurrent);
    const body:SubmissionInput={mode,target_language:language,max_quota_pages:0,expected_kind:kind,regenerate:false,
      items:[{client_item_id:page.id,...source,image_sha256:sha,byte_size:size,content_type:mime,name:page.name,...(page.assetId?{asset_id:page.assetId}:{})}]};
    const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([api.base,ownerId,body]))))).map(n=>n.toString(16).padStart(2,'0')).join('');
    const storageKey='nc-free-reuse:'+fingerprint;
    const key=sessionStorage.getItem(storageKey)??crypto.randomUUID();
    sessionStorage.setItem(storageKey,key);
    try {
      const receipt=await api.submit(body,key);assertCurrent(api.isCurrent);
      if(receipt.items.length!==1||receipt.items[0].client_item_id!==page.id||!receipt.items[0].reused)throw Error('免费复用回执异常，请重新核实。');
      sessionStorage.removeItem(storageKey);
    } catch(error) {
      // Misses create no task and consume no quota. Each page is independent so
      // an uncached page cannot roll back another page's free authorization.
      if(error instanceof ApiError&&['PLUS_REQUIRED','QUOTA_BOUND_EXCEEDED','ENTITLEMENT_CHANGED'].includes(error.code)) {
        sessionStorage.removeItem(storageKey);continue;
      }
      if(submissionRejected(error))sessionStorage.removeItem(storageKey);
      throw error;
    }
  }
}
