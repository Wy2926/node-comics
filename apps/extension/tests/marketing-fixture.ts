/** Screenshot-only local harness. Real product components; recorded sample output; no cloud calls. */
import {BlobReader, BlobWriter, ZipWriter} from '@zip.js/zip.js/index-native.js';
import originalUrl from '../../../backend/website/src/assets/journey-original.webp?url';
import translatedUrl from '../../../backend/website/src/assets/journey-en.webp?url';
import {saveSession} from '../src/auth/storage';
import {saveSettings} from '../src/comics/application/preferences';
import {importLocalFile} from '../src/comics/application/import-service';
import {catalog} from '../src/comics/repositories';
import {acquirePage} from '../src/comics/pages/service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {installFileSources} from '../src/comics/sources/install';
import {API_ORIGIN} from '../src/service';
import {defaults, type Entitlements, type Job, type TranslationSnapshot} from '../src/types';

const isolatedOrigin='http://127.0.0.1:5194';
if(location.origin!==isolatedOrigin || API_ORIGIN!==isolatedOrigin) throw Error('Marketing fixture requires loopback port 5194 and VITE_API_BASE=http://127.0.0.1:5194.');
const nativeFetch=window.fetch.bind(window);
const original=await (await nativeFetch(originalUrl)).blob();
const translated=await (await nativeFetch(translatedUrl)).blob();
const userId='marketing-demo',marker='marketing-demo-v1';
if(await catalog.count('comics') && !await catalog.get('metadata',marker)) throw Error('Refusing to use an origin containing non-demo data.');
await catalog.put('metadata',{id:marker,synthetic:true});
await saveSettings({...defaults,uiLanguage:'en',language:'en',appearance:'light',layout:'single',fit:'window'});
await saveSession({id:crypto.randomUUID(),expiresAt:Date.now()+86400000,refreshAt:Date.now()+82800000,credential:{kind:'development'},token:'local-demo-only',user:{id:userId,name:'Demo reader',role:'reader'},apiOrigin:isolatedOrigin});
const uninstallSources=installFileSources();
let entryId=(await catalog.get('metadata',marker+':entry'))?.entryId;
if(typeof entryId!=='string') {
  const zip=new ZipWriter(new BlobWriter(),{useWebWorkers:false,level:0});
  await zip.add('001.webp',new BlobReader(original));
  const imported=await importLocalFile(new File([await zip.close()],'Seaside Journey.cbz',{type:'application/zip'}));
  entryId=imported.id;
  await catalog.put('metadata',{id:marker+':entry',entryId});
}
const entry=await catalog.get('entries',String(entryId));
if(!entry) throw Error('Demo entry missing.');
const [page]=await catalog.listPages(entry.contentId,{limit:1});
const lease=await acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:RENDER_PROFILE});
const imageSha256=lease.identity.imageSha256;
lease.release();
const recordedJob:Job={id:'recorded-classic-en',input_asset_id:'demo-original',output_asset_id:'demo-english',mode:'classic',target_language:'en',status:'succeeded',phase:'completed',quota_pages:0,created_at:'2026-09-21T00:00:00Z',version:1,cache_hit:true,image_sha256:imageSha256};
await catalog.put('translationBindings',{id:JSON.stringify([isolatedOrigin,userId,imageSha256]),apiOrigin:isolatedOrigin,userId,imageSha256,updatedAt:Date.now(),payload:{ownerId:userId,apiOrigin:isolatedOrigin,assetId:'demo-original',jobs:[recordedJob]}});
const rights:Entitlements={plan:'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:10},scheduler_weight:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:false,quota_kind:'classic_daily',consent_version:'local-demo',quota:null},redraw:{allowed:false,unlimited:false,quota_kind:'unavailable',consent_version:'local-demo',quota:null}}};
const snapshot=(id:string):TranslationSnapshot=>({id,state:'succeeded',mode:'classic',target_language:'en',image_sha256:imageSha256,input_asset_id:'demo-original',created_at:recordedJob.created_at,result:{kind:'translated',asset_id:'demo-english',width:760,height:1140,download_url:isolatedOrigin+'/v1/demo-output',download_expires_at:'2099-01-01T00:00:00Z',authorization_required:true}});
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.href);
  if(url.origin!==isolatedOrigin) throw Error('Cloud requests are disabled in the marketing demonstration.');
  if(!url.pathname.startsWith('/v1/'))return nativeFetch(input,init);
  if(url.pathname==='/v1/capabilities')return json({modes:[{id:'classic',enabled:true,label:'Classic translation',languages:['en']},{id:'redraw',enabled:false,label:'AI redraw'}],languages:[{id:'en',label:'English'}],limits:{max_translation_ids:32,max_bytes:20971520,max_pixels:40000000,max_dimension:12000},entitlements:rights,retention_days:0});
  if(url.pathname==='/v1/me/entitlements')return json(rights);
  if(url.pathname==='/v1/me')return json({user:{id:userId,name:'Demo reader',role:'reader'}});
  if(url.pathname==='/v1/auth/config')return json({mode:'dev',dev_auth:true});
  if(url.pathname==='/v1/demo-output')return new Response(translated,{headers:{'Content-Type':'image/webp'}});
  if(url.pathname.endsWith('/access'))return json({url:isolatedOrigin+'/v1/demo-output',expires_at:'2099-01-01T00:00:00Z'});
  if(url.pathname==='/v1/translations') {
    const ids=(url.searchParams.get('ids')??'recorded-classic-en').split(',').filter(Boolean);
    return json({items:ids.map(snapshot),missing_ids:[],total:1,next_offset:null});
  }
  const translation=url.pathname.match(/^\/v1\/translations\/([^/]+)$/);
  if(translation && (!init.method||init.method==='GET'))return json(snapshot(translation[1]));
  if(translation && init.method==='PUT'){
    const request=JSON.parse(String(init.body));
    if(request.mode==='classic'&&request.target_language==='en'&&request.image?.sha256===imageSha256)return json(snapshot(translation[1]));
  }
  return json({error:{code:'DEMO_ONLY',message:'This isolated demo replays one recorded English result. No new translation or account action is available.'}},403);
};
uninstallSources();
await import('../src/main');
const disclosure=document.createElement('aside');
disclosure.textContent='Product UI demo · original sample artwork · recorded English translation';
disclosure.style.cssText='position:fixed;bottom:5px;left:8px;z-index:10000;padding:4px 8px;border-radius:4px;background:#fffef2;color:#344454;font:11px/1.4 system-ui;pointer-events:none;box-shadow:0 0 0 1px #d9dfdf';
document.body.append(disclosure);
