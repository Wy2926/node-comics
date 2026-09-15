import type {Mode,ReadingCopy} from '../types';
import {pageTranslation} from '../reader/presentation';
import {copyPageTotal} from './model';

export interface TranslationEdition {mode:Mode;language:string;}
export interface TranslationSummary extends TranslationEdition {
 id:string;copyId:string;local:number;remote:number;expired:number;pending:number;failed:number;noText:number;total?:number;updatedAt:string;
}
/** Derived reading views reference the original page manifest and its existing jobs.
 * They never create copies, assets, formal content versions or translation jobs.
 */
export function translationSummaries(copy:ReadingCopy,ownerId?:string,origin?:string):TranslationSummary[] {
 if(!ownerId)return [];
 const groups=new Map<string,TranslationSummary>();
 for(const page of copy.pages){
  if(page.ownerId!==ownerId||page.apiOrigin!==origin)continue;
  for(const job of page.jobs){
   const key=JSON.stringify([job.mode,job.target_language]);
   if(!groups.has(key))groups.set(key,{id:JSON.stringify([copy.id,job.mode,job.target_language]),copyId:copy.id,mode:job.mode,language:job.target_language,local:0,remote:0,expired:0,pending:0,failed:0,noText:0,total:copyPageTotal(copy),updatedAt:''});
  }
 }
 for(const summary of groups.values())for(const page of copy.pages){
  const t=pageTranslation(page,summary.mode,summary.language,ownerId,origin);
  if(t.ready)summary.local++;
  else if(t.result&&(t.expired||t.result.result_available===false))summary.expired++;
  else if(t.result?.output_asset_id)summary.remote++;
  if(t.pending)summary.pending++;
  if(t.latest?.status==='failed')summary.failed++;
  if(t.latest?.status==='no_text'&&!t.result)summary.noText++;
  if(t.latest&&t.latest.created_at>summary.updatedAt)summary.updatedAt=t.latest.created_at;
 }
 return [...groups.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}
