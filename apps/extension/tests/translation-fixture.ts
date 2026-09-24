import {Sha256} from '../src/importers/hash';
import {vi} from 'vitest';
import {Api} from '../src/api';
import {TranslationCoordinator} from '../src/translation/coordinator';
import {emptyPage} from '../src/reader/model';
import type {Entitlements,Job,TranslationSnapshot,TranslationInput} from '../src/types';
export const origin='https://api.example';
export const entitlement=(plus=false):Entitlements=>({plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:plus?100:10},scheduler_weight:plus?2:1,generated_at:'2026-09-19',pending_previous_period_pages:0,modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_unlimited',consent_version:'test',quota:null},redraw:{allowed:true,unlimited:true,quota_kind:'redraw_monthly',consent_version:'test',quota:null}}});
export const originalBytes=(n:number)=>new Blob(['png'+n],{type:'image/png'});
const originalSha=(n:number)=>new Sha256().update(new TextEncoder().encode('png'+n)).digest();
export const target=(n:number)=>({entryId:'book',mode:'classic' as const,page:{...emptyPage(n+'.png',800,1200),id:'page-'+n,fileHash:'a'.repeat(64),pageIndex:n,imageSha256:originalSha(n),imageByteSize:originalBytes(n).size,imageMime:'image/png',blobKey:'blob-'+n}});
export const job=(n:number,extra:Partial<Job>={}):Job=>({id:'job-'+n,input_asset_id:'original-'+n,output_asset_id:null,status:'queued',phase:'queued',mode:'classic',target_language:'zh-Hans',created_at:'2026-09-19T00:00:00Z',version:1,quota_pages:1,cache_hit:false,file_hash:'a'.repeat(64),page_index:n,image_sha256:originalSha(n),...extra});
export const snapshot=(id:string,body:TranslationInput,extra:Partial<TranslationSnapshot>={}):TranslationSnapshot=>({id,state:'queued',mode:'image' in body?body.mode:'classic',target_language:'image' in body?body.target_language:'zh-Hans',image_sha256:'image' in body?body.image.sha256:undefined,created_at:new Date().toISOString(),...extra});
export function fixture(){
 const api=new Api(origin),userId=crypto.randomUUID(),rights=entitlement(),onJobs=vi.fn(async(_jobs:Job[])=>{});
 const core=new TranslationCoordinator({api,userId,language:'zh-Hans',getBlob:async key=>originalBytes(Number(key.replace('blob-',''))),rights:()=>rights,onJobs,onChange:()=>{}});
 const submit=vi.spyOn(api,'translate').mockImplementation(async(id,body)=>snapshot(id,body));
 vi.spyOn(api,'translations').mockImplementation(async ids=>({items:[],missing_ids:ids,unchanged:false as const,etag:'"1"'}));
 return {api,userId,rights,onJobs,core,submit};
}
