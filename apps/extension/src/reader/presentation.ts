import type {Job,Mode,Page} from '../types';
import {newestFirst,pendingStatuses} from './jobs';

export type PageView={mode:Mode;preference:'auto'|'original'|'translation'};
export function resolvePageView(view:PageView|undefined,defaultMode:Mode):PageView{
  return view??{mode:defaultMode,preference:'auto'};
}
/** Redraw may take a while: keep the valid classic result until redraw is available. */
export function readingImage(page:Page,mode:Mode,translated:boolean,language:string,ownerId?:string,origin?:string){
  if(translated){
    const target=pageTranslation(page,mode,language,ownerId,origin);
    if(target.blobKey)return {key:target.blobKey,job:target.result};
    if(mode==='redraw'){
      const classic=pageTranslation(page,'classic',language,ownerId,origin);
      if(classic.blobKey)return {key:classic.blobKey,job:classic.result};
    }
  }
  return {key:page.blobKey,job:undefined};
}

export function latestResults(jobs:Job[]){const seen=new Set<string>();return newestFirst(jobs).filter(job=>{const key=`${job.mode}:${job.target_language}`;if(job.status!=='succeeded'||seen.has(key))return false;seen.add(key);return true;});}
export function pageTranslation(page:Page,mode:Mode,language:string,ownerId?:string,origin?:string){
  const jobs=page.ownerId===ownerId&&page.apiOrigin===origin&&ownerId?newestFirst(page.jobs.filter(j=>j.mode===mode&&j.target_language===language)):[];
  const latest=jobs[0];
  // Keep the latest delivered identity even when its URL has expired. Never fall back to older versions.
  const result=jobs.find(j=>j.status==='succeeded');
  const pending=jobs.find(j=>pendingStatuses.has(j.status));
  const blobKey=result?page.outputBlobs[result.id]:undefined;
  const expired=!!result&&!blobKey&&(!result.output_asset_id||result.result_expired===true);
  const ready=!!blobKey;
  return {jobs,latest,result,pending,blobKey,expired,ready};
}
export function taskText(job?:Job){
  if(!job)return '尚未翻译';
  if(job.status==='succeeded')return job.quality_flags?.includes('unrecognized_regions')?'部分文字保留原文':(!job.output_asset_id?'译图已过期或删除':'翻译完成');
  return {queued:'排队中',running:'翻译中',outcome_unknown:'结果待核实',failed:'翻译失败',cancelled:'已取消',no_text:'未检测到文字'}[job.status];
}
