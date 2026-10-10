import { assertCurrent, RequestPool } from '../concurrency';
import { msg } from '../i18n/runtime';
import {prepareComicPage} from '../comics/pages/normalize';
import {InlineOriginals} from './originals';
import { mergeJobs } from '../reader/jobs';
import { emptyPage } from '../reader/model';
import { pageTranslation } from '../reader/presentation';
import { safeImageUrl, readInlineSourceImage, ImagePermissionsRequired, isImageReferrerPolicy, inlineImageSize } from '../sources';
import {MAX_READING_TARGETS,type ReadingTarget} from '../translation/automatic';
import { matchesPage } from '../translation/sync';
import { defaults, type Job, type Page, type Settings } from '../types';
import { automaticTabsAllowed, registerAutomaticTabs } from './auto-tabs';
import type { InlineRequest, InlineResponse, InlineResult } from './protocol';
import {INLINE_RESULT_PORT, INLINE_SOURCE_PORT, receiveImage, serveImage} from './blob-transfer';
import { settingsKey } from './settings';
import {openActiveChannel,subscribeChannels,type ChannelConnection,type ChannelRuntime} from '../translation/channels';
import { registerInlineThemeBackground } from './theme';
import {activationKey, currentInlineActivation, type InlineActivation as Activation} from './activation';
import {regionActivationKey} from '../region/protocol';
import {imageWork} from '../translation/input/work';

interface WindowRequest {request:InlineRequest;sender:chrome.runtime.MessageSender;activity:RequestActivity;refreshRights:boolean;}
interface Preparation {id:string;controller:AbortController;promise:Promise<void>;}
interface Context {key:string;channel:ChannelConnection;core?:ChannelRuntime;settings:Settings;pages:Map<string,Page>;jobs:Job[];originals:InlineOriginals;sourceErrors:Map<string,NonNullable<InlineResult['state']>>;missingResults:Set<string>;waiting?:AbortController;waitIds?:string;active:boolean;abort:AbortController;explicitImage:boolean;
  id:string;revision:number;readingIds:Set<string>;window?:WindowRequest;preparing:Map<string,Preparation>;sources:RequestPool;submitting?:Promise<void>;submitAgain:boolean;publishTimer?:ReturnType<typeof setTimeout>;}
interface RequestActivity {active:()=>boolean;current:()=>boolean;explicitImage?:boolean;}
const contexts=new Map<number,Context>(),windowGenerations=new Map<number,number>();let configGeneration=0;
const activationEpochs=new Map<number,{active:boolean}>();
function activationEpoch(tabId:number){
  let epoch=activationEpochs.get(tabId);
  if(!epoch){epoch={active:true};activationEpochs.set(tabId,epoch);} // A restarted worker may restore an authorized document.
  return epoch;
}
function invalidateTab(tabId:number){
  const epoch={active:false};activationEpochs.set(tabId,epoch);
  const old=contexts.get(tabId);if(old){disposeContext(old);contexts.delete(tabId);}
  windowGenerations.delete(tabId);return epoch;
}
export async function activateInline(tabId:number,automatic=false){
  return activate(tabId,automatic);
}
export async function activateInlineImage(tabId:number,info:chrome.contextMenus.OnClickData){
  return activate(tabId,false,info);
}
async function activate(tabId:number,automatic:boolean,info?:chrome.contextMenus.OnClickData){
  await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    const tab=await chrome.tabs.get(tabId);
    if(!tab.url||!safeImageUrl(tab.url,tab.url))return;
    if(info&&(info.frameId!==0||info.mediaType!=='image'||!info.srcUrl||info.pageUrl!==tab.url))throw Error(msg('图片范围无效。'));
    if(automatic){
      if(!tab.active||!await automaticTabsAllowed())return;
      const region=await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_IDENTITY'},{frameId:0}).catch(()=>null);
      if(region?.url===tab.url&&(region.enabled||region.dismissedUrl===tab.url))return;
      const existing=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},{frameId:0}).catch(()=>null);
      // Do not reset a manual pause, original-view choice, or dismissal on tab activation.
      if(existing?.url===tab.url&&(existing.dismissedUrl===tab.url||existing.enabled&&existing.activeUrl===tab.url))return;
    }
    const injected=await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/inline.js']});
    const documentId=injected[0]?.documentId,target={frameId:0,...(documentId?{documentId}:{})};
    // data: originals stay in the page; only their bytes use the chunked source port.
    const selection=info?await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_SELECT_IMAGE',
      ...(/^data:image\//i.test(info.srcUrl!)?{dataImage:true}:{srcUrl:info.srcUrl}),pageUrl:tab.url},target):undefined;
    if(info&&(!selection?.ok||!selection.image||typeof selection.image.id!=='string'||typeof selection.image.url!=='string'))throw Error(msg('图片范围无效。'));
    const epoch=invalidateTab(tabId),current=()=>activationEpochs.get(tabId)===epoch;
    await chrome.storage.session.remove(activationKey(tabId));
    await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_STOP'},{frameId:0}).catch(()=>{});
    await chrome.storage.session.remove(regionActivationKey(tabId));
    // Stop before asking for identity: unsubscribing may retire the source navigation.
    await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_STOP'},target);
    const identity=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},target);
    assertCurrent(current);
    if(!identity||identity.url!==tab.url)throw Error(msg("网页已变化，请重新启动翻译。"));
    if(automatic&&!await automaticTabsAllowed())return;
    assertCurrent(current);
    await chrome.storage.session.set({[activationKey(tabId)]:{url:identity.url,navigationId:identity.navigationId,documentId,automatic,...(selection?{image:selection.image}:{})} satisfies Activation});
    assertCurrent(current);epoch.active=true;
    const started=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_START',automatic,imageId:selection?.image.id},target);
    if(started?.ok===false){invalidateTab(tabId);await chrome.storage.session.remove(activationKey(tabId));throw Error(msg('图片范围无效。'));}
  });
}
/** A hand-selected crop owns this document until explicitly leaving region mode. */
export async function suspendInline(tabId:number){
  invalidateTab(tabId);
  await chrome.storage.session.remove(activationKey(tabId));
  await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_STOP'},{frameId:0}).catch(()=>{});
}
async function stopAutomaticInline(tabId:number){
  await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    // Recheck after waiting for any activation; a newer enable wins over an old stop.
    if(await automaticTabsAllowed())return;
    const key=activationKey(tabId),saved=await chrome.storage.session.get(key),activation=saved[key] as Activation|undefined;
    if(!activation?.automatic)return;
    invalidateTab(tabId);
    await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_STOP_AUTO'},{frameId:0,...(activation.documentId?{documentId:activation.documentId}:{})}).catch(()=>{});
    await chrome.storage.session.remove(key);
  });
}
async function context(tabId:number,navigationId:string,activity:RequestActivity):Promise<Context>{
  return navigator.locks.request('nc-inline-context:'+tabId,()=>createContext(tabId,navigationId,activity));
}
async function createContext(tabId:number,navigationId:string,activity:RequestActivity):Promise<Context>{
  assertCurrent(activity.current);
  const saved=await chrome.storage.local.get([settingsKey]),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>};
  assertCurrent(activity.current);
  const key=JSON.stringify([settings.language,navigationId,configGeneration]);
  const previous=contexts.get(tabId);if(previous?.key===key){previous.settings=settings;return previous;}
  if(previous){disposeContext(previous);contexts.delete(tabId);}
  const pages=new Map<string,Page>();let ctx:Context|undefined;
  // The channel survives reading-window changes, but never a new activation.
  const current=()=>activity.active()&&(!ctx||ctx.active);
  const channel=await openActiveChannel(current,{deferPolicy:true});
  try{
  assertCurrent(activity.current);assertCurrent(current);
  const originals=new InlineOriginals('inline:'+key);
  const attach=async(jobs:Job[])=>{
    assertCurrent(current);if(!ctx)return;ctx.jobs=mergeJobs(ctx.jobs,jobs);
    for(const [key,page] of pages){const incoming=jobs.filter(job=>matchesPage(page,job));if(incoming.length)pages.set(key,{...page,translationScope:channel.scope.key,jobs:mergeJobs(page.jobs,incoming)});}
    publish(ctx);
  };
  ctx={key,channel,settings,pages,jobs:[],originals,sourceErrors:new Map(),missingResults:new Set(),active:true,abort:new AbortController(),explicitImage:activity.explicitImage===true,id:crypto.randomUUID(),revision:0,readingIds:new Set(),preparing:new Map(),sources:new RequestPool(3),submitAgain:false};
  if(channel.available)ctx.core=channel.createRuntime({language:settings.language,getBlob:key=>originals.read(key),isCurrent:current,onJobs:attach,onChange:()=>{if(ctx)publish(ctx);},onInputConsumed:key=>originals.uploaded(key)});
  contexts.set(tabId,ctx);await ctx.core?.init();assertCurrent(activity.current);assertCurrent(current);return ctx;
  }catch(error){
    if(ctx){if(contexts.get(tabId)===ctx)contexts.delete(tabId);disposeContext(ctx);}else channel.dispose();
    throw error;
  }
}
function disposeContext(ctx:Context){if(!ctx.active)return;ctx.active=false;ctx.abort.abort();cancelSources(ctx,[]);clearTimeout(ctx.publishTimer);ctx.waiting?.abort();ctx.core?.dispose();ctx.channel.dispose();ctx.originals.clear();}

/** Coalesce local receipts, source readiness and feed updates without waiting for the batch. */
function publish(ctx:Context){
  if(ctx.publishTimer||!ctx.active)return;
  ctx.publishTimer=setTimeout(()=>{
    ctx.publishTimer=undefined;const view=ctx.window;
    if(!view||!ctx.active||!view.activity.current())return;
    // New UUIDs must join the feed immediately, including while another PUT is slow.
    if(ctx.waiting&&ctx.waitIds!==ctx.core?.waitingIds.join(','))ctx.waiting.abort();
    void chrome.tabs.sendMessage(view.sender.tab!.id!,{type:'NC_INLINE_UPDATE',navigationId:view.request.navigationId,generation:view.request.generation,data:response(ctx,view.request)},
      {frameId:0,...(view.sender.documentId?{documentId:view.sender.documentId}:{})}).catch(()=>{});
  },0);
}
function cancelSources(ctx:Context,keepIds:readonly string[]){
  const keep=ctx.readingIds=new Set(keepIds);
  for(const [key,work] of ctx.preparing)if(!keep.has(work.id)){work.controller.abort();ctx.preparing.delete(key);}
}

const pageKey=(request:InlineRequest,image:InlineRequest['images'][number])=>JSON.stringify([request.navigationId,image.id,image.url]);
async function readInlineSource(ctx:Context,request:InlineRequest,image:InlineRequest['images'][number],sender:chrome.runtime.MessageSender,signal=ctx.abort.signal){
  return ctx.sources.run(async()=>{
    const lifetime=AbortSignal.any([signal,ctx.abort.signal]);
    const current=()=>!lifetime.aborted&&ctx.active&&ctx.channel.isCurrent();
    assertCurrent(current);let blob:Blob;
    if(image.url==='page-image:'+image.id){
      const port=chrome.tabs.connect(sender.tab!.id!,{name:INLINE_SOURCE_PORT,frameId:0,...(sender.documentId?{documentId:sender.documentId}:{})});
      blob=await receiveImage(port,{navigationId:request.navigationId,id:image.id},lifetime,current);
    }
    else blob=await readInlineSourceImage(image.url,sender.tab!.url!,lifetime,image.referrerPolicy,ctx.explicitImage);
    assertCurrent(current);
    // Initial reads and cache-miss recovery share three slots, with one decoded bitmap at a time.
    const prepared=await imageWork(()=>prepareComicPage({name:msg('网页漫画'),blob},lifetime));assertCurrent(current);
    return prepared;
  });
}
function targetsFor(ctx:Context,request:InlineRequest):ReadingTarget[]{
  return request.images.flatMap(image=>{const page=ctx.pages.get(pageKey(request,image));return page?[{entryId:'inline',page,mode:'classic' as const}]:[];});
}
async function prepareOne(ctx:Context,request:InlineRequest,image:InlineRequest['images'][number],sender:chrome.runtime.MessageSender){
  const key=pageKey(request,image),existing=ctx.preparing.get(key);
  if(existing)return existing.promise;
  if(ctx.pages.has(key)){await ctx.core?.restore(targetsFor(ctx,{...request,images:[image]}));publish(ctx);return;}
  const controller=new AbortController(),signal=AbortSignal.any([ctx.abort.signal,controller.signal]);
  const current=()=>!signal.aborted&&ctx.active&&ctx.channel.isCurrent();
  const work:Preparation={id:image.id,controller,promise:Promise.resolve()};
  work.promise=(async()=>{
    try{
      const {blob,width,height,imageSha256}=await readInlineSource(ctx,request,image,sender,signal);
      assertCurrent(current);
      const page:Page={...emptyPage(msg('网页漫画'),width,height),imageSha256,id:imageSha256,imageByteSize:blob.size,imageMime:blob.type,blobKey:'inline-original:'+ctx.channel.scope.key+':'+imageSha256,translationScope:ctx.channel.scope.key};
      page.jobs=ctx.jobs.filter(job=>matchesPage(page,job));ctx.pages.set(key,page);ctx.sourceErrors.delete(key);
      // Keep the upload original while local history is read; neither waits for the service.
      await Promise.all([ctx.originals.remember(page.blobKey!,blob,async signal=>(await readInlineSource(ctx,request,image,sender,signal)).blob),ctx.core?.restore([{entryId:'inline',page,mode:'classic'}])]);
      assertCurrent(current);
      if(ctx.pages.size>200){const oldest=ctx.pages.keys().next().value!,old=ctx.pages.get(oldest);ctx.pages.delete(oldest);if(old?.blobKey&&![...ctx.pages.values()].some(value=>value.blobKey===old.blobKey))ctx.originals.forget(old.blobKey);}
    }catch(error){
      if(!current())return;
      ctx.sourceErrors.set(key,error instanceof ImagePermissionsRequired?{kind:'error',message:error.message,retryable:false}:{kind:'error',message:(error as Error).message});
    }finally{if(ctx.preparing.get(key)===work)ctx.preparing.delete(key);publish(ctx);}
  })();
  ctx.preparing.set(key,work);return work.promise;
}
/** Serialize admission only, never source reads, local history/display or status feeds. */
function submitPrepared(ctx:Context):Promise<void>{
  ctx.submitAgain=true;if(ctx.submitting)return ctx.submitting;
  ctx.submitting=(async()=>{
    while(ctx.submitAgain&&ctx.active){
      ctx.submitAgain=false;const view=ctx.window;if(!view||!view.activity.current())break;
      if(view.request.deferRemote==='backoff'||view.request.deferRemote==='offline'&&ctx.channel.requiresInternet)continue;
      const current=()=>ctx.active&&view.activity.current()&&ctx.channel.isCurrent();
      let targets=targetsFor(ctx,view.request);
      if(view.refreshRights&&!view.request.retryId&&targets.some(target=>!pageTranslation(target.page,'classic',ctx.settings.language,ctx.channel.scope.key).latest)){view.refreshRights=false;await ctx.core!.refresh();}
      if(!current())continue;
      targets=targetsFor(ctx,view.request);
      if(view.request.retryId){
        const image=view.request.images.find(image=>image.id===view.request.retryId),page=image&&ctx.pages.get(pageKey(view.request,image));
        const target=targets.find(target=>target.page.id===page?.id);
        if(target){view.request={...view.request,retryId:undefined};await ctx.core!.manual(target);}
      }else await ctx.core!.submit(targets,target=>ctx.active&&ctx.channel.isCurrent()&&view.request.images.some(image=>
        ctx.readingIds.has(image.id)&&ctx.pages.get(pageKey(view.request,image))?.id===target.page.id));
      publish(ctx);
    }
  })().finally(()=>{ctx.submitting=undefined;publish(ctx);});
  return ctx.submitting;
}
const resultScope=(ctx:Context)=>JSON.stringify([ctx.channel.scope.key,'classic',ctx.settings.language]);
function pageResult(ctx:Context,page:Page){
  const current=pageTranslation(page,'classic',ctx.settings.language,ctx.channel.scope.key);
  return current.result&&!current.expired?current.result:undefined;
}
function response(ctx:Context,request:InlineRequest):InlineResponse{
  const mode='classic',language=ctx.settings.language,scope=resultScope(ctx);
  const items:InlineResult[]=[];
  for(const image of request.images){
    if(!ctx.channel.available){items.push({id:image.id,state:ctx.channel.unavailable});continue;}
    const key=pageKey(request,image),page=ctx.pages.get(key);if(!page){const error=ctx.sourceErrors.get(key);items.push({id:image.id,state:error??{kind:'waiting',message:msg('正在准备页面…')},pending:!error});continue;}
    const result=pageResult(ctx,page),state=ctx.core?.stateFor({entryId:'inline',page,mode},true);
    // A delivered result may still report "loading the translation" until decoded.
    // Display work and unrelated admission backoff must not occupy a translation slot.
    const waiting=state?.kind==='waiting'||state?.kind==='translating';
    const item:InlineResult={id:image.id,pending:!!pageTranslation(page,mode,language,ctx.channel.scope.key).pending||
      waiting&&!result};
    if(result?.result&&!ctx.missingResults.has(result.id)){item.resultKey=JSON.stringify([scope,result.id,result.result.key]);item.resultMode=result.mode;}
    else item.state=state;
    items.push(item);
  }
  return {contextId:ctx.id,revision:++ctx.revision,mode,language,scope,items,analyticsChannel:ctx.channel.analyticsCategory,requiresInternet:ctx.channel.requiresInternet,retryAfterMs:ctx.core?.retryDelay||undefined,hasPending:ctx.core?.hasPending,
    needsSubmit:ctx.channel.available&&request.images.some(image=>!ctx.pages.has(pageKey(request,image))&&!ctx.preparing.has(pageKey(request,image))&&!ctx.sourceErrors.has(pageKey(request,image)))};
}
/** A display reload can only read this page's selected result; it never enters the plan/retry path. */
async function imageResponse(request:InlineRequest,sender:chrome.runtime.MessageSender,signal:AbortSignal,activity:RequestActivity){
  const ctx=await context(sender.tab!.id!,request.navigationId,activity);
  if(!ctx.channel.available)throw Error(ctx.channel.unavailable?.message??msg('正在连接翻译服务'));
  const current=()=>!signal.aborted&&activity.current()&&ctx.active&&ctx.channel.isCurrent();
  assertCurrent(current);
  // A page binding is published before its local receipts finish restoring.
  // Display recovery waits for that image only, never for unrelated admission.
  await ctx.preparing.get(pageKey(request,request.images[0]))?.promise;
  assertCurrent(current);
  const page=ctx.pages.get(pageKey(request,request.images[0])),job=page&&pageResult(ctx,page);
  const notReady=()=>Object.assign(Error(msg('正在准备页面…')),{code:'INLINE_RESULT_NOT_READY'});
  if(!page)throw notReady();
  const key=job&&JSON.stringify([resultScope(ctx),job.id,job.result?.key]);
  if(!job?.result||key!==request.resultKey){
    if(pageTranslation(page,'classic',ctx.settings.language,ctx.channel.scope.key).expired)throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
    throw notReady();
  }
  let blob:Blob;
  try{blob=await ctx.channel.readResult(job,AbortSignal.any([signal,ctx.abort.signal]),async()=>page?.blobKey?ctx.originals.read(page.blobKey,signal):undefined);}catch(error){
    if((error as {code?:string}).code==='RESULT_NOT_CACHED'&&current()&&page){ctx.missingResults.add(job.id);ctx.pages.set(pageKey(request,request.images[0]),{...page,translationError:(error as Error).message});}
    throw error;
  }
  assertCurrent(current);
  // Feed updates can revoke/change the result while its bytes are being read.
  const selectedCurrent=()=>{
    const latest=ctx.pages.get(pageKey(request,request.images[0])),selected=latest&&pageResult(ctx,latest);
    return current()&&selected?.id===job.id&&selected.result?.key===job.result?.key;
  };
  if(!selectedCurrent())throw notReady();
  return {blob,current:selectedCurrent};
}

async function checkedRequest(message:InlineRequest,sender:chrome.runtime.MessageSender){
  const tabId=sender.tab!.id!,epoch=activationEpoch(tabId),configuration=configGeneration;
  const active=()=>epoch.active&&activationEpochs.get(tabId)===epoch&&configuration===configGeneration;
  assertCurrent(active);
  const current=await currentInlineActivation(sender,message.navigationId);
  assertCurrent(active);
  if(!current)throw Error(msg('网页已变化，请重新右键翻译当前页面。'));
  const {activation,tab}=current;
  if(activation.automatic&&!await automaticTabsAllowed())throw Error(msg('标签页自动翻译已关闭。'));
  assertCurrent(active);
  if(!Number.isSafeInteger(message.generation)||message.generation<0)throw Error(msg('阅读窗口无效。'));
  if(message.type!=='NC_INLINE_IMAGE')windowGenerations.set(tabId,Math.max(windowGenerations.get(tabId)??0,message.generation));
  if(!activation.documentId&&sender.documentId)await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    assertCurrent(active);activation.documentId=sender.documentId;
    await chrome.storage.session.set({[activationKey(tabId)]:activation});assertCurrent(active);
  });
  const activity={active,current:()=>active()&&(message.type==='NC_INLINE_IMAGE'||message.generation===(windowGenerations.get(tabId)??0))};
  const explicitImage=!!activation.image;
  if(['NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message.type))return {tabId,tab,...activity,explicitImage};
  if(!Array.isArray(message.images)||message.images.length>MAX_READING_TARGETS||explicitImage&&(message.images.length!==1||message.images[0]?.id!==activation.image!.id||message.images[0]?.url!==activation.image!.url)||message.images.some((i:unknown)=>{const v=i as {id?:string;url?:string;width:number;height:number;referrerPolicy?:unknown};return !v||typeof v.id!=='string'||v.id.length>80||typeof v.url!=='string'||v.url!=='page-image:'+v.id&&safeImageUrl(v.url,activation.url)!==v.url||v.referrerPolicy!==undefined&&!isImageReferrerPolicy(v.referrerPolicy)||(explicitImage?!(Number.isFinite(v.width)&&Number.isFinite(v.height)&&v.width>0&&v.height>0):!inlineImageSize(v.width,v.height,activation.url));}))throw Error(msg('图片范围无效。'));
  if(message.type==='NC_INLINE_IMAGE'&&(message.images.length!==1||typeof message.resultKey!=='string'||message.resultKey.length>2048))throw Error(msg('图片范围无效。'));
  return {tabId,tab,...activity,explicitImage};
}
async function step(request:InlineRequest,sender:chrome.runtime.MessageSender,activity:RequestActivity):Promise<InlineResponse>{
  const ctx=await context(sender.tab!.id!,request.navigationId,activity);
  if(!ctx.channel.available||!ctx.core)return response(ctx,request);
  const current=()=>activity.current()&&ctx.active&&ctx.channel.isCurrent();
  if(!current())return response(ctx,request);
  if(request.type==='NC_INLINE_WAIT'){
    if(!ctx.waiting||ctx.waiting.signal.aborted)ctx.waiting=new AbortController();const waiting=ctx.waiting;
    ctx.waitIds=ctx.core.waitingIds.join(',');
    try{await ctx.core.wait(waiting.signal);}catch(error){if(waiting.signal.aborted)return response(ctx,request);throw error;}
  }else {
    ctx.waiting?.abort();
    ctx.window={request,sender,activity,refreshRights:!!request.refreshRights};
    cancelSources(ctx,request.images.map(image=>image.id));
    let failed=false;
    await Promise.all(request.images.map(async image=>{
      await prepareOne(ctx,request,image,sender);
      if(current()&&!failed)try{await submitPrepared(ctx);}catch(error){failed=true;throw error;}
    }));
    assertCurrent(current);
  }
  return response(ctx,request);
}
export function registerInlineBackground(){
  const transfers=new Map<number,Set<()=>void>>();
  const closeTransfers=(tabId:number)=>{for(const close of transfers.get(tabId)??[])close();};
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!==INLINE_RESULT_PORT)return;
    const sender=port.sender,tabId=sender?.tab?.id;
    if(!sender||sender.id!==chrome.runtime.id||tabId==null||sender.frameId!==0){port.disconnect();return;}
    const active=transfers.get(tabId)??new Set<()=>void>();
    if(active.size>=2){port.disconnect();return;}transfers.set(tabId,active);
    const close=serveImage(port,async(value,signal)=>{
      const request=value as InlineRequest;
      if(request?.type!=='NC_INLINE_IMAGE')throw Error(msg('图片范围无效。'));
      const activity=await checkedRequest(request,sender);
      signal.throwIfAborted();return imageResponse(request,sender,signal,activity);
    },()=>{active.delete(close);if(!active.size)transfers.delete(tabId);});
    active.add(close);
  });
  registerInlineThemeBackground();
  registerAutomaticTabs(activateInline,stopAutomaticInline);
  const invalidate=()=>{configGeneration++;for(const id of transfers.keys())closeTransfers(id);for(const ctx of contexts.values())disposeContext(ctx);contexts.clear();void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_INLINE_CONFIG_CHANGED'},{frameId:0}))));};
  subscribeChannels(invalidate);
  chrome.storage.onChanged.addListener((changes,area)=>{const change=changes[settingsKey],before=change?.oldValue as Partial<Settings>|undefined,after=change?.newValue as Partial<Settings>|undefined;if(area==='local'&&change&&before?.language!==after?.language)invalidate();});
  chrome.tabs.onRemoved.addListener(tabId=>{closeTransfers(tabId);invalidateTab(tabId);activationEpochs.delete(tabId);void navigator.locks.request('nc-inline-activation:'+tabId,()=>chrome.storage.session.remove(activationKey(tabId)));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_INLINE_TICK','NC_INLINE_WAIT','NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void(async()=>{
      const activity=await checkedRequest(message,sender),{tabId,tab}=activity;
      assertCurrent(activity.current);
      if(message.type==='NC_INLINE_INVALIDATE'){
        const ctx=contexts.get(tabId);if(ctx){ctx.waiting?.abort();cancelSources(ctx,Array.isArray(message.keepIds)?message.keepIds.filter((id:unknown)=>typeof id==='string').slice(0,1500):[]);}return;
      }
      if(message.type==='NC_INLINE_OPEN'){await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#'+(message.view==='settings'?'settings':'account'))});return;}
      // Use the current, activation-checked tab URL; sender.url can lag behind SPA navigation.
      const currentSender={...sender,tab};
      return step(message,currentSender,activity);
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message,errorCode:typeof error.code==='string'?error.code:undefined,retryAfterMs:error.retryAfterSeconds?error.retryAfterSeconds*1000:undefined}));return true;
  });
}
