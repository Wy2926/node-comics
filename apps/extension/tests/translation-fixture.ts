import {Sha256} from '../src/importers/hash';
import {vi} from 'vitest';
import {Api} from '../src/api';
import {TranslationCoordinator} from '../src/translation/channels/adapters/nodelane/coordinator';
import {emptyPage} from '../src/reader/model';
import type {Entitlements,Job,TranslationSnapshot,TranslationInput} from '../src/types';
import type {PreparedInput} from '../src/translation/input/prepare';
export const origin='https://api.example';
export const entitlement=(plus=false):Entitlements=>({plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:plus?100:10},generated_at:'2026-09-19',pending_previous_period_pages:0,modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_unlimited',consent_version:'test',quota:null}}});
export const originalBytes=(n:number)=>new Blob(['png'+n],{type:'image/png'});
const originalSha=(n:number)=>new Sha256().update(new TextEncoder().encode('png'+n)).digest();
export const target=(n:number)=>({entryId:'book',mode:'classic' as const,page:{...emptyPage(n+'.png',800,1200),id:'page-'+n,imageSha256:originalSha(n),imageByteSize:originalBytes(n).size,imageMime:'image/png',blobKey:'blob-'+n}});
/** Explicit unprocessed input metadata for operation/recovery fixtures, without production I/O fallbacks. */
export const originalInput=(n:number):PreparedInput=>({sourceSha256:originalSha(n),width:800,height:1200,image:{sha256:originalSha(n),byte_size:originalBytes(n).size,content_type:'image/png',normalization_version:1}});
export const job=(n:number,extra:Partial<Job>={}):Job=>({id:'job-'+n,status:'queued',phase:'queued',mode:'classic',target_language:'zh-Hans',created_at:'2026-09-19T00:00:00Z',version:1,quota_pages:1,cache_hit:false,image_sha256:originalSha(n),result:extra.status==='succeeded'?{key:'result-'+n,recoverable:true}:undefined,...extra});
export const snapshot=(id:string,body:TranslationInput,extra:Partial<TranslationSnapshot>={}):TranslationSnapshot=>({id,state:'queued',mode:'image' in body?body.mode:'classic',target_language:'image' in body?body.target_language:'zh-Hans',image_sha256:'image' in body?body.image.sha256:undefined,created_at:new Date().toISOString(),...extra});
export function fixture(){
 const api=new Api(origin),userId=crypto.randomUUID(),rights=entitlement(),onJobs=vi.fn(async(_jobs:Job[])=>{});
 const core=new TranslationCoordinator({api,userId,language:'zh-Hans',getBlob:async key=>originalBytes(Number(key.replace('blob-',''))),rights:()=>rights,onJobs,onChange:()=>{}});
 const submit=vi.spyOn(api,'translate').mockImplementation(async(id,body)=>snapshot(id,body));
 vi.spyOn(api,'translations').mockImplementation(async ids=>({items:[],missing_ids:ids,unchanged:false as const,etag:'"1"'}));
 vi.spyOn(api,'translationEvents').mockImplementation(async function*(ids){const value=await api.translations(ids);if(!value.unchanged)yield value;});
 return {api,userId,rights,onJobs,core,submit};
}
