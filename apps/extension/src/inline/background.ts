import { assertCurrent } from '../concurrency';
import { msg } from '../i18n/runtime';
import {prepareComicPage} from '../comics/pages/normalize';
import {InlineOriginals} from './originals';
import { mergeJobs } from '../reader/jobs';
import { emptyPage } from '../reader/model';
import { pageTranslation } from '../reader/presentation';
import { imageDataUrl, maxInlineBytes, safeImageUrl, readInlineSourceImage, ImagePermissionsRequired, isImageReferrerPolicy, inlineImageSize } from '../sources';
import { type ReadingTarget } from '../translation/automatic';
import { matchesPage } from '../translation/sync';
import { defaults, supportsLanguage, type Capabilities, type Job, type Page, type Settings } from '../types';
import { automaticTabsAllowed, registerAutomaticTabs } from './auto-tabs';
import type { InlineRequest, InlineResponse, InlineResult, InlineImageResponse } from './protocol';
import { settingsKey } from './settings';
import {openActiveChannel,subscribeChannels,type ChannelConnection,type ChannelRuntime} from '../translation/channels';
import {channelMode} from '../translation/channels/capabilities';
import { registerInlineThemeBackground } from './theme';

interface Activation {url:string;navigationId:string;documentId?:string;automatic?:boolean;}
interface Context {key:string;channel:ChannelConnection;core?:ChannelRuntime;settings:Settings;caps:Capabilities;pages:Map<string,Page>;jobs:Job[];originals:InlineOriginals;sourceErrors:Map<string,NonNullable<InlineResult['state']>>;missingResults:Set<string>;currentKey?:string;waiting?:AbortController;active:boolean;}
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
    const old=contexts.get(tabId);if(old){disposeContext(old);contexts.delete(tabId);}
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
    const old=contexts.get(tabId);if(old){disposeContext(old);contexts.delete(tabId);}
    await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_STOP_AUTO'},{frameId:0,...(activation.documentId?{documentId:activation.documentId}:{})}).catch(()=>{});
    await chrome.storage.session.remove(key);windowGenerations.delete(tabId);
  });
}
async function context(tabId:number,navigationId:string):Promise<Context|undefined>{
  return navigator.locks.request('nc-inline-context:'+tabId,()=>createContext(tabId,navigationId));
}
async function createContext(tabId:number,navigationId:string):Promise<Context>{
  const saved=await chrome.storage.local.get([settingsKey]),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>};
  const key=JSON.stringify([settings.translationMode,settings.language,navigationId,configGeneration]);
  const previous=contexts.get(tabId);if(previous?.key===key){previous.settings={...settings,translationMode:channelMode(previous.channel.capabilities,settings.translationMode)};return previous;}
  if(previous)disposeContext(previous);
  const generation=configGeneration,pages=new Map<string,Page>();let ctx:Context|undefined;
  const current=()=>generation===configGeneration&&(!ctx||ctx.active);
  const channel=await openActiveChannel(current),caps=channel.capabilities;
  settings.translationMode=channelMode(caps,settings.translationMode);
  assertCurrent(current);
  const originals=new InlineOriginals('inline:'+key,Math.min(128*1024*1024,caps.limits.max_bytes*4));
  const attach=async(jobs:Job[])=>{
    assertCurrent(current);if(!ctx)return;ctx.jobs=mergeJobs(ctx.jobs,jobs);
    for(const [key,page] of pages){const incoming=jobs.filter(job=>matchesPage(page,job));if(incoming.length)pages.set(key,{...page,translationScope:channel.scope.key,jobs:mergeJobs(page.jobs,incoming)});}
  };
  ctx={key,channel,settings,caps,pages,jobs:[],originals,sourceErrors:new Map(),missingResults:new Set(),active:true};
  if(channel.available)ctx.core=channel.createRuntime({language:settings.language,getBlob:key=>originals.read(key),isCurrent:current,onJobs:attach,onChange:()=>{},onInputConsumed:key=>originals.uploaded(key)});
  contexts.set(tabId,ctx);await ctx.core?.init();return ctx;
}
function disposeContext(ctx:Context){ctx.active=false;ctx.waiting?.abort();ctx.core?.dispose();ctx.channel.dispose();ctx.originals.clear();}

const pageKey=(request:InlineRequest,image:InlineRequest['images'][number])=>JSON.stringify([request.navigationId,image.id,image.url]);
async function readInlineSource(ctx:Context,request:InlineRequest,image:InlineRequest['images'][number],sender:chrome.runtime.MessageSender){
  assertCurrent(ctx.channel.isCurrent);let blob:Blob;
  if(image.url==='page-image:'+image.id){const source=await chrome.tabs.sendMessage(sender.tab!.id!,{type:'NC_INLINE_SOURCE',navigationId:request.navigationId,id:image.id},{documentId:sender.documentId,frameId:0});if(typeof source?.data!=='string'||source.data.length>maxInlineBytes*4/3+200||!/^data:[\w.+/-]+;base64,/.test(source.data))throw Error(source?.error??msg("网页原图读取失败。"));blob=await(await fetch(source.data)).blob();}
  else blob=await readInlineSourceImage(image.url,sender.tab!.url!,undefined,image.referrerPolicy);
  assertCurrent(ctx.channel.isCurrent);if(blob.size>ctx.caps.limits.max_bytes)throw Error(msg("图片超过翻译服务的大小限制。"));
  const prepared=await prepareComicPage({name:msg('网页漫画'),blob});assertCurrent(ctx.channel.isCurrent);
  if(prepared.blob.size>ctx.caps.limits.max_bytes)throw Error(msg("图片超过翻译服务的大小限制。"));
  if(prepared.width*prepared.height>ctx.caps.limits.max_pixels||Math.max(prepared.width,prepared.height)>ctx.caps.limits.max_dimension)throw Error(msg("图片尺寸超过翻译服务限制。"));
  return prepared;
}
async function prepare(ctx:Context,request:InlineRequest,sender:chrome.runtime.MessageSender){
  const targets:ReadingTarget[]=[];
  for(const image of request.images){
   try{
    const key=pageKey(request,image);let page=ctx.pages.get(key);
    if(!page){
      const {blob,width,height,imageSha256}=await readInlineSource(ctx,request,image,sender);
      page={...emptyPage(msg("网页漫画"),width,height),imageSha256,id:imageSha256,imageByteSize:blob.size,imageMime:blob.type,blobKey:'inline-original:'+ctx.channel.scope.key+':'+imageSha256,translationScope:ctx.channel.scope.key};
      page.jobs=ctx.jobs.filter(job=>matchesPage(page!,job));
      await ctx.originals.remember(page.blobKey!,blob,async()=>(await readInlineSource(ctx,request,image,sender)).blob);assertCurrent(ctx.channel.isCurrent);ctx.pages.set(key,page);
      if(ctx.pages.size>200){const oldest=ctx.pages.keys().next().value!,old=ctx.pages.get(oldest);ctx.pages.delete(oldest);if(old?.blobKey&&![...ctx.pages.values()].some(value=>value.blobKey===old.blobKey))ctx.originals.forget(old.blobKey);}
    }
    ctx.sourceErrors.delete(key);targets.push({entryId:'inline',page,mode:ctx.settings.translationMode});
   }catch(error){ctx.sourceErrors.set(pageKey(request,image),error instanceof ImagePermissionsRequired
     ?{kind:'error',message:error.message,retryable:false}
     :{kind:'error',message:(error as Error).message});}
  }
  return targets;
}
const resultScope=(ctx:Context)=>JSON.stringify([ctx.channel.scope.key,ctx.settings.translationMode,ctx.settings.language]);
function pageResult(ctx:Context,page:Page){
  const {translationMode:mode,language}=ctx.settings;
  const current=pageTranslation(page,mode,language,ctx.channel.scope.key),fallback=mode==='redraw'?pageTranslation(page,'classic',language,ctx.channel.scope.key):undefined;
  return current.result&&!current.expired?current.result:fallback?.result&&!fallback.expired?fallback.result:undefined;
}
function response(ctx:Context,request:InlineRequest):InlineResponse{
  const {translationMode:mode,language}=ctx.settings,scope=resultScope(ctx);
  const items:InlineResult[]=[];
  for(const image of request.images){
    if(!ctx.channel.available){items.push({id:image.id,state:ctx.channel.unavailable});continue;}
    const key=pageKey(request,image),page=ctx.pages.get(key);if(!page){const error=ctx.sourceErrors.get(key);if(error)items.push({id:image.id,state:error});continue;}
    const result=pageResult(ctx,page),item:InlineResult={id:image.id};
    if(result?.result&&!ctx.missingResults.has(result.id))item.resultKey=JSON.stringify([scope,result.id,result.result.key]);
    else item.state=ctx.core?.stateFor({entryId:'inline',page,mode},true);
    items.push(item);
  }
  return {mode,language,scope,items,requiresInternet:ctx.channel.requiresInternet,retryAfterMs:ctx.core?.retryDelay||undefined,hasPending:ctx.core?.hasPending,
    needsSubmit:ctx.channel.available&&request.images.some(image=>!ctx.pages.has(pageKey(request,image))&&!ctx.sourceErrors.has(pageKey(request,image)))};
}
/** A display reload can only read this page's selected result; it never enters the plan/retry path. */
async function imageResponse(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineImageResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId);
  if(!ctx||!ctx.channel.available)throw Error(ctx?.channel.unavailable?.message??msg('正在连接翻译服务'));
  const current=()=>ctx.active&&ctx.channel.isCurrent()&&request.generation===(windowGenerations.get(sender.tab!.id!)??0);
  assertCurrent(current);
  const page=ctx.pages.get(pageKey(request,request.images[0])),job=page&&pageResult(ctx,page);
  const key=job&&JSON.stringify([resultScope(ctx),job.id,job.result?.key]);
  if(!job?.result||key!==request.resultKey)throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  let blob:Blob;
  try{blob=await ctx.channel.readResult(job);}catch(error){
    if((error as {code?:string}).code==='RESULT_NOT_CACHED'&&current()&&page){ctx.missingResults.add(job.id);ctx.pages.set(pageKey(request,request.images[0]),{...page,translationError:(error as Error).message});}
    throw error;
  }
  assertCurrent(current);
  // Feed updates can revoke/change the result while its bytes are being read.
  const latest=ctx.pages.get(pageKey(request,request.images[0])),selected=latest&&pageResult(ctx,latest);
  if(selected?.id!==job.id||selected.result?.key!==job.result?.key)throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  const data=await imageDataUrl(blob);assertCurrent(current);
  return {resultKey:key!,data};
}
async function step(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId);
  if(!ctx)throw Error(msg('正在连接翻译服务'));
  if(!ctx.channel.available||!ctx.core)return response(ctx,request);
  const current=()=>ctx.active&&request.generation===(windowGenerations.get(sender.tab!.id!)??0);
  if(!current())return response(ctx,request);
  if(request.type==='NC_INLINE_WAIT'){
    ctx.waiting?.abort();const waiting=new AbortController();ctx.waiting=waiting;
    try{await ctx.core.wait(waiting.signal);}catch(error){if(waiting.signal.aborted)return response(ctx,request);throw error;}
  }else {
    ctx.waiting?.abort();
    const {translationMode:mode,language}=ctx.settings;
    if(!ctx.caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(ctx.caps,mode,language))return {mode,language,scope:ctx.key,items:request.images.map(i=>({id:i.id,state:{kind:'error',message:msg("此翻译方式暂不可用"),retryable:false}}))};
    if(request.refreshRights&&!request.retryId)await ctx.core.refresh();
    const currentKey=request.images[0]&&pageKey(request,request.images[0]);
    if(!request.retryId&&currentKey!==ctx.currentKey&&request.images.length>1){const targets=await prepare(ctx,{...request,images:request.images.slice(0,1)},sender);await ctx.core.submit(targets,current);if(!current())return response(ctx,request);ctx.currentKey=currentKey;}
    const targets=await prepare(ctx,request,sender);
    if(!current())return response(ctx,request);
    if(request.retryId){const image=request.images.find(i=>i.id===request.retryId),page=image&&ctx.pages.get(pageKey(request,image));const target=targets.find(t=>t.page.id===page?.id);if(target)await ctx.core.manual(target);}
    else await ctx.core.submit(targets,current);
    ctx.currentKey=currentKey;

  }
  return response(ctx,request);
}
export function registerInlineBackground(){
  registerInlineThemeBackground();
  registerAutomaticTabs(activateInline,stopAutomaticInline);
  const invalidate=()=>{configGeneration++;for(const ctx of contexts.values())disposeContext(ctx);contexts.clear();void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_INLINE_CONFIG_CHANGED'},{frameId:0}))));};
  subscribeChannels(invalidate);
  chrome.storage.onChanged.addListener((changes,area)=>{const change=changes[settingsKey],before=change?.oldValue as Partial<Settings>|undefined,after=change?.newValue as Partial<Settings>|undefined;if(area==='local'&&change&&(before?.language!==after?.language||before?.translationMode!==after?.translationMode))invalidate();});
  chrome.tabs.onRemoved.addListener(tabId=>{const ctx=contexts.get(tabId);if(ctx){disposeContext(ctx);}contexts.delete(tabId);windowGenerations.delete(tabId);void chrome.storage.session.remove(activationKey(tabId));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_INLINE_TICK','NC_INLINE_WAIT','NC_INLINE_IMAGE','NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
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
      if(!Array.isArray(message.images)||message.images.length>4||message.images.some((i:unknown)=>{const v=i as {id?:string;url?:string;width:number;height:number;referrerPolicy?:unknown};return !v||typeof v.id!=='string'||v.id.length>80||typeof v.url!=='string'||v.url!=='page-image:'+v.id&&safeImageUrl(v.url,activation.url)!==v.url||v.referrerPolicy!==undefined&&!isImageReferrerPolicy(v.referrerPolicy)||!inlineImageSize(v.width,v.height,activation.url);}))throw Error(msg("图片范围无效。"));
      if(message.type==='NC_INLINE_IMAGE'){
        if(message.images.length!==1||typeof message.resultKey!=='string'||message.resultKey.length>2048)throw Error(msg('图片范围无效。'));
        return imageResponse(message,sender);
      }
      // Use the current, activation-checked tab URL; sender.url can lag behind SPA navigation.
      const currentSender={...sender,tab};
      if(message.type==='NC_INLINE_WAIT')return step(message,currentSender);
      return navigator.locks.request('nc-inline-step:'+tabId,()=>step(message,currentSender));
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message,errorCode:typeof error.code==='string'?error.code:undefined,retryAfterMs:error.retryAfterSeconds?error.retryAfterSeconds*1000:undefined}));return true;
  });
}
