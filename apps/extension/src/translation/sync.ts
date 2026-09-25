import type {Job,Page,ReadingEntry} from '../types';
import {mergeJobs} from '../reader/jobs';
import type {TranslationScope} from './channels/contracts';

export function matchesPage(page:Page,job:Job){return page.jobs.some(j=>j.id===job.id)||!!job.file_hash&&job.file_hash===page.fileHash&&job.page_index===page.pageIndex||!!job.image_sha256&&job.image_sha256===page.imageSha256||!!page.assetId&&page.assetId===(job.requested_asset_id??job.input_asset_id);}
function indexJobs(jobs:Job[]){const index=new Map<string,Job[]>();for(const job of jobs){for(const key of [`job:${job.id}`,...(job.file_hash?[`file:${job.file_hash}:${job.page_index}`]:[]),...(job.image_sha256?[`sha:${job.image_sha256}`]:[]),...(job.input_asset_id?[`asset:${job.requested_asset_id??job.input_asset_id}`]:[])])index.set(key,[...(index.get(key)??[]),job]);}return index;}
function pageJobs(page:Page,index:Map<string,Job[]>,includeLocal=true){const keys=[...(page.fileHash?[`file:${page.fileHash}:${page.pageIndex}`]:[]),...(page.imageSha256?[`sha:${page.imageSha256}`]:[]),...(includeLocal?page.jobs.map(j=>`job:${j.id}`):[]),...(includeLocal&&page.assetId?[`asset:${page.assetId}`]:[])];return [...new Map(keys.flatMap(key=>index.get(key)??[]).map(job=>[job.id,job])).values()];}
/** Channel status never downloads images or changes the original's layout geometry. */
export function applyChannelJobs(copy:ReadingEntry,jobs:Job[],scope:TranslationScope){
 let changed=false;const index=indexJobs(jobs);
 const pages=copy.pages.map(page=>{
  const sameOwner=page.translationScope===scope.key;
  const relevant=pageJobs(page,index,sameOwner);
  if(!relevant.length)return page;
  const merged=mergeJobs(sameOwner?page.jobs:[],relevant);
  if(sameOwner&&JSON.stringify(merged)===JSON.stringify(page.jobs))return page;
  changed=true;
  return {...page,translationScope:scope.key,jobs:merged,outputBlobs:sameOwner?page.outputBlobs:{}};
 });
 return changed?{...copy,pages}:copy;
}
