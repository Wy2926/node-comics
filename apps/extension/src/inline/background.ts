import { Api } from '../api';
import type { AuthState, Session } from '../auth/model';
import { sessionAuthorization } from '../auth/session';
import { authKey, readAuth } from '../auth/storage';
import { assertCurrent, RequestPool, UPLOAD_CONCURRENCY } from '../concurrency';
import { msg } from '../i18n/runtime';
import {prepareComicPage} from '../comics/pages/normalize';
import {InlineOriginals} from './originals';
import { loadResultBlob } from '../storage/translations/results';
import { mergeJobs } from '../reader/jobs';
import { emptyPage } from '../reader/model';
import { pageTranslation } from '../reader/presentation';
import { API_BASE, API_ORIGIN } from '../service';
import { imageDataUrl, maxInlineBytes, safeImageUrl, sourceImage } from '../sources';
import { operationId, type ReadingTarget } from '../translation/automatic';
import { TranslationCoordinator } from '../translation/coordinator';
import { translationState } from '../translation/state';
import { matchesPage } from '../translation/sync';
import { defaults, supportsLanguage, type Capabilities, type Entitlements, type Job, type Page, type Settings } from '../types';
import { automaticTabsAllowed, registerAutomaticTabs } from './auto-tabs';
import { comicSize, type InlineRequest, type InlineResponse, type InlineResult, type InlineImageResponse } from './protocol';
import { settingsKey } from './settings';
import { registerInlineThemeBackground } from './theme';

interface Activation {url:string;navigationId:string;documentId?:string;automatic?:boolean;}
interface Context {key:string;api:Api;core:TranslationCoordinator;settings:Settings;session:Session;caps:Capabilities;rights:Entitlements;pages:Map<string,Page>;originals:InlineOriginals;sourceErrors:Map<string,string>;currentKey?:string;waiting?:AbortController;active:boolean;}
const activationKey=(tabId:number)=>'nc-inline:'+tabId;
const contexts=new Map<number,Context>(),windowGenerations=new Map<number,number>();let configGeneration=0;
export async function activateInline(tabId:number,automatic=false){
  await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    const tab=await chrome.tabs.get(tabId);
    if(!tab.url||!safeImageUrl(tab.url,tab.url))return;
    if(automatic){
      if(!tab.active||!await automaticTabsAllowed())return;
      const existing=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},{frameId:0}).catch(()=>null);
      // Do not reset a manual pause, original-view choice, or dismissal on tab activation.
      if(existing?.url===tab.url&&(existing.dismissedUrl===tab.url||existing.enabled&&existing.activeUrl===tab.url))return;
    }
    const injected=await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/inline.js']});
    const documentId=injected[0]?.documentId,target={frameId:0,...(documentId?{documentId}:{})};
    const identity=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},target);
    if(!identity||identity.url!==tab.url)throw Error(msg("网页已变化，请重新启动翻译。"));
    if(automatic&&!await automaticTabsAllowed())return;
    windowGenerations.delete(tabId);
    const old=contexts.get(tabId);if(old){old.active=false;old.waiting?.abort();old.originals.clear();contexts.delete(tabId);}
    await chrome.storage.session.set({[activationKey(tabId)]:{url:identity.url,navigationId:identity.navigationId,documentId,automatic} satisfies Activation});
    await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_START',automatic},target);
  });
}
async function stopAutomaticInline(tabId:number){
  await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    // Recheck after waiting for any activation; a newer enable wins over an old stop.
    if(await automaticTabsAllowed())return;
    const key=activationKey(tabId),saved=await chrome.storage.session.get(key),activation=saved[key] as Activation|undefined;
    if(!activation?.automatic)return;
    const old=contexts.get(tabId);if(old){old.active=false;old.waiting?.abort();old.originals.clear();contexts.delete(tabId);}
    await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_STOP_AUTO'},{frameId:0,...(activation.documentId?{documentId:activation.documentId}:{})}).catch(()=>{});
    await chrome.storage.session.remove(key);windowGenerations.delete(tabId);
  });
}
async function context(tabId:number,navigationId:string):Promise<Context|undefined>{
  return navigator.locks.request('nc-inline-context:'+tabId,()=>createContext(tabId,navigationId));
}
async function createContext(tabId:number,navigationId:string):Promise<Context|undefined>{
  const saved=await chrome.storage.local.get([settingsKey]),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>},session=(await readAuth()).session;
  const origin=API_ORIGIN;if(!session||session.apiOrigin!==origin)return;
  const key=JSON.stringify([origin,session.id,settings.translationMode,settings.language,navigationId,configGeneration]);
  const previous=contexts.get(tabId);if(previous?.key===key){previous.settings=settings;return previous;}
  if(previous){previous.active=false;previous.waiting?.abort();previous.originals.clear();}
  const generation=configGeneration,pages=new Map<string,Page>();let ctx:Context|undefined;
  const api=new Api(API_BASE,session.token,new RequestPool(UPLOAD_CONCURRENCY),()=>generation===configGeneration&&(!ctx||ctx.active),sessionAuthorization(session.id));
  const [caps,rights]=await Promise.all([api.capabilities(),api.entitlements()]);
  const attach=async(jobs:Job[])=>{assertCurrent(api.isCurrent);for(const [key,page] of pages){const incoming=jobs.filter(job=>matchesPage(page,job));if(incoming.length)pages.set(key,{...page,ownerId:session.user.id,apiOrigin:origin,assetId:incoming.find(j=>j.input_asset_id)?.input_asset_id??page.assetId,jobs:mergeJobs(page.jobs,incoming)});}};
  const originals=new InlineOriginals('inline:'+key,Math.min(128*1024*1024,caps.limits.max_bytes*4));
  const core=new TranslationCoordinator({api,userId:session.user.id,language:settings.language,sessionId:navigationId,getBlob:key=>originals.read(key),rights:()=>ctx?.rights??rights,onJobs:attach,onChange:()=>{},onPolicy:value=>{if(ctx)ctx.rights=value;}});
  ctx={key,api,core,settings,session,caps,rights,pages,originals,sourceErrors:new Map(),active:true};contexts.set(tabId,ctx);await core.init();await core.recover();return ctx;
}
const pageKey=(request:InlineRequest,image:InlineRequest['images'][number])=>JSON.stringify([request.navigationId,image.id,image.url]);
async function readInlineSource(ctx:Context,request:InlineRequest,image:InlineRequest['images'][number],sender:chrome.runtime.MessageSender){
  assertCurrent(ctx.api.isCurrent);let blob:Blob;
  if(image.url==='page-image:'+image.id){const source=await chrome.tabs.sendMessage(sender.tab!.id!,{type:'NC_INLINE_SOURCE',navigationId:request.navigationId,id:image.id},{documentId:sender.documentId,frameId:0});if(typeof source?.data!=='string'||source.data.length>maxInlineBytes*4/3+200||!/^data:[\w.+/-]+;base64,/.test(source.data))throw Error(source?.error??msg("网页原图读取失败。"));blob=await(await fetch(source.data)).blob();}
  else blob=await sourceImage(image.url);
  assertCurrent(ctx.api.isCurrent);if(blob.size>ctx.caps.limits.max_bytes)throw Error(msg("图片超过翻译服务的大小限制。"));
  const prepared=await prepareComicPage({name:msg('网页漫画'),blob});assertCurrent(ctx.api.isCurrent);
  if(prepared.blob.size>ctx.caps.limits.max_bytes)throw Error(msg("图片超过翻译服务的大小限制。"));
  if(prepared.width*prepared.height>ctx.caps.limits.max_pixels||Math.max(prepared.width,prepared.height)>ctx.caps.limits.max_dimension)throw Error(msg("图片尺寸超过翻译服务限制。"));
  return prepared;
}
async function prepare(ctx:Context,request:InlineRequest,sender:chrome.runtime.MessageSender){
  const targets:ReadingTarget[]=[];
  for(const [index,image] of request.images.entries()){
   try{
    const key=pageKey(request,image);let page=ctx.pages.get(key);
    if(!page){
      const {blob,width,height,imageSha256}=await readInlineSource(ctx,request,image,sender);
      page={...emptyPage(msg("网页漫画"),width,height),imageSha256,id:imageSha256,imageByteSize:blob.size,imageMime:blob.type,blobKey:'inline-original:'+ctx.core.scope+':'+imageSha256,ownerId:ctx.session.user.id,apiOrigin:new URL(ctx.api.base).origin};
      page.jobs=ctx.core.state.jobs.filter(job=>matchesPage(page!,job));
      await ctx.originals.remember(page.blobKey!,blob,async()=>(await readInlineSource(ctx,request,image,sender)).blob);assertCurrent(ctx.api.isCurrent);ctx.pages.set(key,page);
      if(ctx.pages.size>200){const oldest=ctx.pages.keys().next().value!,old=ctx.pages.get(oldest);ctx.pages.delete(oldest);if(old?.blobKey&&![...ctx.pages.values()].some(value=>value.blobKey===old.blobKey))ctx.originals.forget(old.blobKey);}
    }
    ctx.sourceErrors.delete(key);targets.push({copyId:'inline',page,mode:ctx.settings.translationMode});
   }catch(error){ctx.sourceErrors.set(pageKey(request,image),(error as Error).message);if(index===0)throw error;}
  }
  return targets;
}
const resultScope=(ctx:Context)=>JSON.stringify([new URL(ctx.api.base).origin,ctx.session.user.id,ctx.settings.translationMode,ctx.settings.language]);
function pageResult(ctx:Context,page:Page){
  const {translationMode:mode,language}=ctx.settings,origin=new URL(ctx.api.base).origin;
  const current=pageTranslation(page,mode,language,ctx.session.user.id,origin),fallback=mode==='redraw'?pageTranslation(page,'classic',language,ctx.session.user.id,origin):undefined;
  return current.result&&!current.expired?current.result:fallback?.result&&!fallback.expired?fallback.result:undefined;
}
function response(ctx:Context,request:InlineRequest):InlineResponse{
  const {translationMode:mode,language}=ctx.settings,origin=new URL(ctx.api.base).origin,scope=resultScope(ctx);
  const items:InlineResult[]=[];
  for(const image of request.images){const key=pageKey(request,image),page=ctx.pages.get(key);if(!page){const error=ctx.sourceErrors.get(key);if(error)items.push({id:image.id,state:{kind:'error',message:error}});continue;}
    const result=pageResult(ctx,page);
    const item:InlineResult={id:image.id};
    if(result?.output_asset_id)item.resultKey=JSON.stringify([scope,result.id,result.output_asset_id]);
    else {
      const operation=ctx.core.records.find(r=>r.id===operationId(ctx.core.scope,language,{copyId:'inline',page,mode}));
      item.state=translationState({page,mode,language,userId:ctx.session.user.id,origin,active:true,caps:ctx.caps,rights:ctx.rights,operation});
    }
    items.push(item);
  }
  return {mode,language,scope,items,retryAfterMs:ctx.core.retryDelay||undefined,policyRevision:ctx.core.state.policyRevision,
    needsPlan:ctx.core.session.sequence===0||request.images.some(image=>!ctx.pages.has(pageKey(request,image))&&!ctx.sourceErrors.has(pageKey(request,image)))};
}
/** A display reload can only read this page's selected result; it never enters the plan/retry path. */
async function imageResponse(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineImageResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId);
  if(!ctx)throw Error(msg('登录后自动翻译'));
  const current=()=>ctx.active&&ctx.api.isCurrent()&&request.generation===(windowGenerations.get(sender.tab!.id!)??0);
  assertCurrent(current);
  const page=ctx.pages.get(pageKey(request,request.images[0])),job=page&&pageResult(ctx,page);
  const key=job&&JSON.stringify([resultScope(ctx),job.id,job.output_asset_id]);
  if(!job?.output_asset_id||key!==request.resultKey)throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  const blob=await loadResultBlob({origin:new URL(ctx.api.base).origin,userId:ctx.session.user.id,job,
    download:()=>ctx.api.image(job.output_asset_id!),isCurrent:ctx.api.isCurrent});
  assertCurrent(current);
  // Feed updates can revoke/change the result while its bytes are being read.
  const latest=ctx.pages.get(pageKey(request,request.images[0])),selected=latest&&pageResult(ctx,latest);
  if(selected?.id!==job.id||selected.output_asset_id!==job.output_asset_id)throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  const data=await imageDataUrl(blob);assertCurrent(current);
  return {resultKey:key!,data};
}
async function step(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId);
  if(!ctx)return {mode:'classic',language:'zh-Hans',scope:'logged-out',items:request.images.map(i=>({id:i.id,state:{kind:'login',message:msg("登录后自动翻译")}}))};
  const current=()=>ctx.active&&request.generation===(windowGenerations.get(sender.tab!.id!)??0);
  if(!current())return response(ctx,request);
  if(request.type==='NC_INLINE_WAIT'){
    ctx.waiting?.abort();const waiting=new AbortController();ctx.waiting=waiting;
    try{await ctx.core.wait(waiting.signal);}catch(error){if(waiting.signal.aborted)return response(ctx,request);throw error;}
  }else if(request.type==='NC_INLINE_LEASE')await ctx.core.renew([ctx.settings.translationMode]);
  else {
    ctx.waiting?.abort();
    const {translationMode:mode,language}=ctx.settings;
    if(!ctx.caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(ctx.caps,mode,language))return {mode,language,scope:ctx.key,items:request.images.map(i=>({id:i.id,state:{kind:'error',message:msg("此翻译方式暂不可用"),retryable:false}}))};
    const currentKey=request.images[0]&&pageKey(request,request.images[0]);
    if(!request.retryId&&currentKey!==ctx.currentKey&&!ctx.pages.has(currentKey)&&request.images.length>1){const targets=await prepare(ctx,{...request,images:request.images.slice(0,1)},sender);await ctx.core.plan(targets,false,current);if(!current())return response(ctx,request);ctx.currentKey=currentKey;}
    const targets=await prepare(ctx,request,sender);
    if(!current())return response(ctx,request);
    if(request.retryId){const image=request.images.find(i=>i.id===request.retryId),page=image&&ctx.pages.get(pageKey(request,image));const target=targets.find(t=>t.page.id===page?.id);if(target)await ctx.core.manual(target,current);}
    else await ctx.core.plan(targets,false,current);
    ctx.currentKey=currentKey;
    // Upload completion is durable and arrives through the feed. Do not hold ready images behind uploads.
    void ctx.core.finishUploads().then(async()=>{
      for(const target of targets){const operation=ctx.core.records.find(r=>r.id===operationId(ctx.core.scope,language,target));if(target.page.blobKey&&operation?.state==='accepted'&&operation.result?.job?.status!=='awaiting_upload')await ctx.originals.uploaded(target.page.blobKey);}
    }).catch(()=>{});
  }
  return response(ctx,request);
}
export function registerInlineBackground(){
  registerInlineThemeBackground();
  registerAutomaticTabs(activateInline,stopAutomaticInline);
  chrome.storage.onChanged.addListener((changes,area)=>{const auth=changes[authKey],accountChanged=auth&&(auth.oldValue as AuthState|undefined)?.session?.id!==(auth.newValue as AuthState|undefined)?.session?.id;const settingChange=changes[settingsKey],before=settingChange?.oldValue as Partial<Settings>|undefined,after=settingChange?.newValue as Partial<Settings>|undefined;const translationChanged=settingChange&&(before?.language!==after?.language||before?.translationMode!==after?.translationMode);if(area==='local'&&(translationChanged||accountChanged)){configGeneration++;for(const ctx of contexts.values()){ctx.active=false;ctx.waiting?.abort();ctx.originals.clear();}contexts.clear();void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_INLINE_CONFIG_CHANGED'},{frameId:0}))));}});
  chrome.tabs.onRemoved.addListener(tabId=>{const ctx=contexts.get(tabId);if(ctx){ctx.active=false;ctx.waiting?.abort();ctx.originals.clear();}contexts.delete(tabId);windowGenerations.delete(tabId);void chrome.storage.session.remove(activationKey(tabId));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_INLINE_TICK','NC_INLINE_WAIT','NC_INLINE_LEASE','NC_INLINE_IMAGE','NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void(async()=>{
      const tabId=sender.tab!.id!,saved=await chrome.storage.session.get(activationKey(tabId)),activation=saved[activationKey(tabId)] as Activation|undefined;
      if(!activation||activation.navigationId!==message.navigationId||activation.documentId&&activation.documentId!==sender.documentId)throw Error(msg("网页已变化，请重新右键翻译当前页面。"));
      if(activation.automatic&&!await automaticTabsAllowed())throw Error(msg("标签页自动翻译已关闭。"));
      if(!Number.isSafeInteger(message.generation)||message.generation<0)throw Error(msg("阅读窗口无效。"));
      windowGenerations.set(tabId,Math.max(windowGenerations.get(tabId)??0,message.generation));
      if(message.type==='NC_INLINE_INVALIDATE'){contexts.get(tabId)?.waiting?.abort();return;}
      const tab=await chrome.tabs.get(tabId);if(tab.url!==activation.url)throw Error(msg("网页已变化，请重新右键翻译当前页面。"));
      if(!activation.documentId){activation.documentId=sender.documentId;await chrome.storage.session.set({[activationKey(tabId)]:activation});}
      if(message.type==='NC_INLINE_OPEN'){await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#'+(message.view==='settings'?'settings':'account'))});return;}
      if(!Array.isArray(message.images)||message.images.length>4||message.images.some((i:unknown)=>{const v=i as {id?:string;url?:string;width:number;height:number};return !v||typeof v.id!=='string'||v.id.length>80||typeof v.url!=='string'||v.url!=='page-image:'+v.id&&safeImageUrl(v.url,activation.url)!==v.url||!comicSize(v.width,v.height);}))throw Error(msg("图片范围无效。"));
      if(message.type==='NC_INLINE_IMAGE'){
        if(message.images.length!==1||typeof message.resultKey!=='string'||message.resultKey.length>2048)throw Error(msg('图片范围无效。'));
        return imageResponse(message,sender);
      }
      if(message.type==='NC_INLINE_WAIT')return step(message,sender);
      return navigator.locks.request('nc-inline-step:'+tabId,()=>step(message,sender));
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message,retryAfterMs:error.retryAfterSeconds?error.retryAfterSeconds*1000:undefined}));return true;
  });
}
