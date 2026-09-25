import {msg} from '../i18n/runtime';
import type {Job,Mode,Page} from '../types';
import {newestFirst,pendingStatuses} from './jobs';

export type PageView={mode:Mode;preference:'original'|'translation'};
export function resolvePageView(view:PageView|undefined,defaultMode:Mode):PageView{
  return view??{mode:defaultMode,preference:'original'};
}
/** Redraw may take a while: keep the valid classic result until redraw is available. */
export function readingImage(page:Page,mode:Mode,translated:boolean,language:string,scopeKey?:string,fallbackClassic=true){
  if(translated){
    const target=pageTranslation(page,mode,language,scopeKey);
    if(target.blobKey)return {key:target.blobKey,job:target.result};
    if(mode==='redraw'&&fallbackClassic){
      const classic=pageTranslation(page,'classic',language,scopeKey);
      if(classic.blobKey)return {key:classic.blobKey,job:classic.result};
    }
  }
  return {key:page.blobKey,job:undefined};
}

export function latestResults(jobs:Job[]){const seen=new Set<string>();return newestFirst(jobs).filter(job=>{const key=`${job.mode}:${job.target_language}`;if(job.status!=='succeeded'||seen.has(key))return false;seen.add(key);return true;});}
export function pageTranslation(page:Page,mode:Mode,language:string,scopeKey?:string){
  const jobs=scopeKey&&page.translationScope===scopeKey?newestFirst(page.jobs.filter(j=>j.mode===mode&&j.target_language===language)):[];
  const latest=jobs[0];
  // Keep the latest delivered identity even when its URL has expired. Never fall back to older versions.
  const result=jobs.find(j=>j.status==='succeeded');
  const pending=jobs.find(j=>pendingStatuses.has(j.status));
  const blobKey=result?page.outputBlobs[result.id]:undefined;
  const expired=!!result&&!blobKey&&(!result.result||result.result_expired===true||result.result_available===false);
  const ready=!!blobKey;
  return {jobs,latest,result,pending,blobKey,expired,ready};
}
export function taskText(job?:Job){
  if(!job)return msg("尚未翻译");
  if(job.status==='succeeded')return job.quality_flags?.includes('unrecognized_regions')?msg("部分文字保留原文"):(!job.result?msg("译图已过期或删除"):msg("翻译完成"));
  return {awaiting_upload:msg("等待原图上传"),validating_upload:msg("正在校验原图"),queued:msg("等待翻译"),running:msg("翻译中"),outcome_unknown:msg("结果待核实"),unknown_released:msg("核实期限已结束 · 原请求可能已产生费用"),failed:msg("翻译失败"),cancelled:msg("已取消"),no_text:msg("未检测到文字")}[job.status];
}
