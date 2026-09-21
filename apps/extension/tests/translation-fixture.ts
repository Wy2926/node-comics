import {vi} from 'vitest';
import {Api} from '../src/api';
import {TranslationCoordinator} from '../src/translation/coordinator';
import {emptyPage} from '../src/reader/model';
import type {Entitlements,Job,PlanReceipt,TranslationPlan} from '../src/types';
export const origin='https://api.example';
export const entitlement=(plus=false):Entitlements=>({plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:plus?100:10},scheduler_weight:plus?2:1,generated_at:'2026-09-19',pending_previous_period_pages:0,modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_unlimited',consent_version:'test',quota:null},redraw:{allowed:true,unlimited:true,quota_kind:'redraw_monthly',consent_version:'test',quota:null}}});
export const target=(n:number)=>({copyId:'book',mode:'classic' as const,page:{...emptyPage(n+'.png',800,1200),id:'page-'+n,fileHash:'a'.repeat(64),pageIndex:n,imageSha256:n.toString(16).padStart(64,'0'),imageByteSize:3,imageMime:'image/png',blobKey:'blob-'+n}});
export const job=(n:number,extra:Partial<Job>={}):Job=>({id:'job-'+n,input_asset_id:'original-'+n,output_asset_id:null,status:'queued',phase:'queued',mode:'classic',target_language:'zh-Hans',created_at:'2026-09-19T00:00:00Z',version:1,quota_pages:1,cache_hit:false,file_hash:'a'.repeat(64),page_index:n,image_sha256:n.toString(16).padStart(64,'0'),...extra});
export const receipt=(body:TranslationPlan):PlanReceipt=>({policy_revision:'1',image_rate_limit:{window_seconds:60,limit:10,remaining:9},items:body.items.map(item=>({operation_key:item.operation_key,page_key:item.page_key,disposition:'accepted',job:job(item.image.page_index??0)}))});
export function fixture(){
 const api=new Api(origin),userId=crypto.randomUUID(),rights=entitlement(),onJobs=vi.fn(async(_jobs:Job[])=>{});
 const core=new TranslationCoordinator({api,userId,language:'zh-Hans',sessionId:crypto.randomUUID(),getBlob:async()=>new Blob(['png']),rights:()=>rights,onJobs,onChange:()=>{}});
 const plan=vi.spyOn(api,'plan').mockImplementation(async body=>receipt(body));
 vi.spyOn(api,'resolveOperations').mockImplementation(async keys=>({items:keys.map(operation_key=>({operation_key,disposition:'not_found' as const}))}));
 return {api,userId,rights,onJobs,core,plan};
}
