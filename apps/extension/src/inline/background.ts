import {Api} from '../api';
import {RequestPool,assertCurrent,UPLOAD_CONCURRENCY} from '../concurrency';
import {imageIdentity} from '../importers/hash';
import {getBlob,putBlob,removeBlob,type Session} from '../library/store';
import {emptyPage} from '../reader/model';
import {safeImageUrl} from '../sources/adapters';
import {sourceImage} from '../sources/image-fetch';
import {defaults,supportsLanguage,type Page,type Settings,type Job,type Capabilities,type Entitlements} from '../types';
import {comicSize,type InlineRequest,type InlineResponse,type InlineResult} from './protocol';
import {settingsKey,sessionKey} from './settings';
import {imageDataUrl,maxInlineBytes} from './bytes';
import {TranslationCoordinator} from '../translation/coordinator';
import {operationId,type ReadingTarget} from '../translation/automatic';
import {pageTranslation} from '../reader/presentation';
import {translationState} from '../translation/state';
import {matchesPage} from '../translation/sync';
import {mergeJobs} from '../reader/jobs';

interface Activation {url:string;navigationId:string;documentId?:string;}
interface Context {key:string;api:Api;core:TranslationCoordinator;settings:Settings;session:Session;caps:Capabilities;rights:Entitlements;pages:Map<string,Page>;sourceErrors:Map<string,string>;currentKey?:string;waiting?:AbortController;active:boolean;}
const activationKey=(tabId:number)=>'nc-inline:'+tabId;
const contexts=new Map<number,Context>(),windowGenerations=new Map<number,number>();let configGeneration=0;
export async function activateInline(tabId:number){
  windowGenerations.delete(tabId);
  const old=contexts.get(tabId);if(old){old.active=false;old.waiting?.abort();contexts.delete(tabId);}
  const injected=await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/inline.js']});
  const identity=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},{frameId:0});
  if(!identity||!safeImageUrl(identity.url,identity.url))throw Error('请在普通网页中使用翻译。');
  await chrome.storage.session.set({[activationKey(tabId)]:{...identity,documentId:injected[0]?.documentId}});
  await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_START'},{frameId:0});
}
async function context(tabId:number,navigationId:string):Promise<Context|undefined>{
  const saved=await chrome.storage.local.get([settingsKey,sessionKey]),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>},session=saved[sessionKey] as Session|null;
  const origin=new URL(settings.apiBase).origin;if(!session||session.apiOrigin!==origin)return;
  const key=JSON.stringify([origin,session.user.id,settings.translationMode,settings.language,navigationId,configGeneration]);
  const previous=contexts.get(tabId);if(previous?.key===key)return previous;
  if(previous){previous.active=false;previous.waiting?.abort();}
  const generation=configGeneration,pages=new Map<string,Page>();let ctx:Context|undefined;
  const api=new Api(settings.apiBase,session.token,new RequestPool(UPLOAD_CONCURRENCY),()=>generation===configGeneration&&(!ctx||ctx.active));
  const [caps,rights]=await Promise.all([api.capabilities(),api.entitlements()]);
  const attach=async(jobs:Job[])=>{assertCurrent(api.isCurrent);for(const [key,page] of pages){const incoming=jobs.filter(job=>matchesPage(page,job));if(incoming.length)pages.set(key,{...page,ownerId:session.user.id,apiOrigin:origin,assetId:incoming.find(j=>j.input_asset_id)?.input_asset_id??page.assetId,jobs:mergeJobs(page.jobs,incoming)});}};
  const core=new TranslationCoordinator({api,userId:session.user.id,language:settings.language,sessionId:navigationId,getBlob,rights:()=>ctx?.rights??rights,onJobs:attach,onChange:()=>{},onPolicy:value=>{if(ctx)ctx.rights=value;}});
  ctx={key,api,core,settings,session,caps,rights,pages,sourceErrors:new Map(),active:true};contexts.set(tabId,ctx);await core.init();await core.recover();return ctx;
}
const pageKey=(request:InlineRequest,image:InlineRequest['images'][number])=>JSON.stringify([request.navigationId,image.id,image.url]);
async function prepare(ctx:Context,request:InlineRequest,sender:chrome.runtime.MessageSender){
  const targets:ReadingTarget[]=[];
  for(const [index,image] of request.images.entries()){
   try{
    const key=pageKey(request,image);let page=ctx.pages.get(key);
    if(!page){
      let blob:Blob;
      if(image.url==='page-image:'+image.id){const source=await chrome.tabs.sendMessage(sender.tab!.id!,{type:'NC_INLINE_SOURCE',navigationId:request.navigationId,id:image.id},{documentId:sender.documentId,frameId:0});if(typeof source?.data!=='string'||source.data.length>maxInlineBytes*4/3+200||!/^data:[\w.+/-]+;base64,/.test(source.data))throw Error(source?.error??'网页原图读取失败。');blob=await (await fetch(source.data)).blob();}
      else blob=await sourceImage(image.url);
      assertCurrent(ctx.api.isCurrent);if(blob.size>ctx.caps.limits.max_bytes)throw Error('图片超过翻译服务的大小限制。');
      const bitmap=await createImageBitmap(blob),width=bitmap.width,height=bitmap.height;bitmap.close();
      if(width*height>ctx.caps.limits.max_pixels||Math.max(width,height)>ctx.caps.limits.max_dimension)throw Error('图片尺寸超过翻译服务限制。');
      const identity=await imageIdentity(blob);assertCurrent(ctx.api.isCurrent);
      page={...emptyPage('网页漫画',width,height),...identity,id:identity.imageSha256,imageByteSize:blob.size,imageMime:blob.type,blobKey:'inline-original:'+ctx.core.scope+':'+identity.imageSha256,ownerId:ctx.session.user.id,apiOrigin:new URL(ctx.api.base).origin};
      page.jobs=ctx.core.state.jobs.filter(job=>matchesPage(page!,job));
      await putBlob(page.blobKey!,blob);ctx.pages.set(key,page);
      if(ctx.pages.size>200)ctx.pages.delete(ctx.pages.keys().next().value!);
    }
    ctx.sourceErrors.delete(key);targets.push({copyId:'inline',page,mode:ctx.settings.translationMode});
   }catch(error){ctx.sourceErrors.set(pageKey(request,image),(error as Error).message);if(index===0)throw error;}
  }
  return targets;
}
async function response(ctx:Context,request:InlineRequest):Promise<InlineResponse>{
  const {translationMode:mode,language}=ctx.settings,origin=new URL(ctx.api.base).origin,scope=JSON.stringify([origin,ctx.session.user.id,mode,language]);
  const items:InlineResult[]=[];let bytes=0;
  for(const image of request.images){const key=pageKey(request,image),page=ctx.pages.get(key);if(!page){const error=ctx.sourceErrors.get(key);if(error)items.push({id:image.id,state:{kind:'error',message:error}});continue;}
    const current=pageTranslation(page,mode,language,ctx.session.user.id,origin),fallback=mode==='redraw'?pageTranslation(page,'classic',language,ctx.session.user.id,origin):undefined;
    const result=current.result&&!current.expired?current.result:fallback?.result&&!fallback.expired?fallback.result:undefined;
    const operation=ctx.core.records.find(r=>r.id===operationId(ctx.core.scope,language,{copyId:'inline',page,mode}));
    const item:InlineResult={id:image.id,state:translationState({page,mode,language,userId:ctx.session.user.id,origin,active:true,caps:ctx.caps,rights:ctx.rights,operation})};
    if(result?.output_asset_id){item.resultKey=JSON.stringify([scope,result.id,result.output_asset_id]);if(request.known[image.id]!==item.resultKey){try{const blob=await ctx.api.image(result.output_asset_id);assertCurrent(ctx.api.isCurrent);if(blob.size>maxInlineBytes)throw Error('译图超过 40 MB 限制，原图已保留。');if(bytes+blob.size<=maxInlineBytes){item.data=await imageDataUrl(blob);bytes+=blob.size;item.state=undefined;}else item.state={kind:'translating',message:'正在读取译图'};}catch(error){item.state={kind:'error',message:(error as Error).message,retryLabel:'点击重新加载'};}}else item.state=undefined;}
    items.push(item);
  }
  return {mode,language,scope,items,retryAfterMs:ctx.core.retryDelay||undefined,policyRevision:ctx.core.state.policyRevision,needsPlan:ctx.core.session.sequence===0};
}
async function step(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId);
  if(!ctx)return {mode:'classic',language:'zh-Hans',scope:'logged-out',items:request.images.map(i=>({id:i.id,state:{kind:'login',message:'登录后自动翻译'}}))};
  const current=()=>ctx.active&&request.generation===(windowGenerations.get(sender.tab!.id!)??0);
  if(!current())return response(ctx,request);
  if(request.type==='NC_INLINE_WAIT'){
    ctx.waiting?.abort();const waiting=new AbortController();ctx.waiting=waiting;
    try{await ctx.core.wait(waiting.signal);}catch(error){if(waiting.signal.aborted)return response(ctx,request);throw error;}
  }else if(request.type==='NC_INLINE_LEASE')await ctx.core.renew([ctx.settings.translationMode]);
  else {
    ctx.waiting?.abort();
    const {translationMode:mode,language}=ctx.settings;
    if(!ctx.caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(ctx.caps,mode,language))return {mode,language,scope:ctx.key,items:request.images.map(i=>({id:i.id,state:{kind:'error',message:'此翻译方式暂不可用',retryable:false}}))};
    const currentKey=request.images[0]&&pageKey(request,request.images[0]);
    if(!request.retryId&&currentKey!==ctx.currentKey&&request.images.length>1){const targets=await prepare(ctx,{...request,images:request.images.slice(0,1)},sender);await ctx.core.plan(targets,false,current);if(!current())return response(ctx,request);ctx.currentKey=currentKey;}
    const targets=await prepare(ctx,request,sender);
    if(!current())return response(ctx,request);
    if(request.retryId){const image=request.images.find(i=>i.id===request.retryId),page=image&&ctx.pages.get(pageKey(request,image));const target=targets.find(t=>t.page.id===page?.id);if(target)await ctx.core.manual(target,current);}
    else await ctx.core.plan(targets,false,current);
    ctx.currentKey=currentKey;
    await ctx.core.finishUploads();
    for(const target of targets){const operation=ctx.core.records.find(r=>r.id===operationId(ctx.core.scope,language,target));if(target.page.blobKey&&operation?.state==='accepted'&&operation.result?.job?.status!=='awaiting_upload')await removeBlob(target.page.blobKey);}
  }
  return response(ctx,request);
}
export function registerInlineBackground(){
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes[settingsKey]||changes[sessionKey])){configGeneration++;for(const ctx of contexts.values()){ctx.active=false;ctx.waiting?.abort();}contexts.clear();void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_INLINE_CONFIG_CHANGED'},{frameId:0}))));}});
  chrome.tabs.onRemoved.addListener(tabId=>{const ctx=contexts.get(tabId);if(ctx){ctx.active=false;ctx.waiting?.abort();}contexts.delete(tabId);windowGenerations.delete(tabId);void chrome.storage.session.remove(activationKey(tabId));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_INLINE_TICK','NC_INLINE_WAIT','NC_INLINE_LEASE','NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void(async()=>{
      const tabId=sender.tab!.id!,saved=await chrome.storage.session.get(activationKey(tabId)),activation=saved[activationKey(tabId)] as Activation|undefined;
      if(!activation||activation.navigationId!==message.navigationId||activation.documentId&&activation.documentId!==sender.documentId)throw Error('网页已变化，请重新右键翻译当前页面。');
      if(!Number.isSafeInteger(message.generation)||message.generation<0)throw Error('阅读窗口无效。');
      windowGenerations.set(tabId,Math.max(windowGenerations.get(tabId)??0,message.generation));
      if(message.type==='NC_INLINE_INVALIDATE'){contexts.get(tabId)?.waiting?.abort();return;}
      const tab=await chrome.tabs.get(tabId);if(tab.url!==activation.url)throw Error('网页已变化，请重新右键翻译当前页面。');
      if(!activation.documentId){activation.documentId=sender.documentId;await chrome.storage.session.set({[activationKey(tabId)]:activation});}
      if(message.type==='NC_INLINE_OPEN'){await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#'+(message.view==='settings'?'settings':'account'))});return;}
      if(!Array.isArray(message.images)||message.images.length>3||message.images.some((i:unknown)=>{const v=i as {id?:string;url?:string;width:number;height:number};return !v||typeof v.id!=='string'||v.id.length>80||typeof v.url!=='string'||v.url!=='page-image:'+v.id&&safeImageUrl(v.url,activation.url)!==v.url||!comicSize(v.width,v.height);})||!message.known||typeof message.known!=='object')throw Error('图片范围无效。');
      if(message.type==='NC_INLINE_WAIT')return step(message,sender);
      return navigator.locks.request('nc-inline-step:'+tabId,()=>step(message,sender));
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message,retryAfterMs:error.retryAfterSeconds?error.retryAfterSeconds*1000:undefined}));return true;
  });
}
