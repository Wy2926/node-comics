import {assertCurrent} from '../concurrency';
import {msg} from '../i18n/runtime';
import {hashFile} from '../importers/hash';
import {serveImage} from '../inline/blob-transfer';
import {suspendInline} from '../inline/background';
import {settingsKey} from '../inline/settings';
import {emptyPage} from '../reader/model';
import {mergeJobs} from '../reader/jobs';
import {pageTranslation} from '../reader/presentation';
import {safeImageUrl} from '../sources';
import {openActiveChannel,subscribeChannels,type ChannelConnection,type ChannelRuntime} from '../translation/channels';
import {prepareTranslationInput,type PreparedInput} from '../translation/input/prepare';
import {matchesPage} from '../translation/sync';
import {defaults,supportsLanguage,type Capabilities,type Settings} from '../types';
import {captureRegion} from './capture';
import {sameViewport,validViewport} from './geometry';
import {REGION_IMAGE_PORT,regionActivationKey,type RegionIdentity,type RegionRequest,type RegionResponse,type RegionImageRequest} from './protocol';
import {readRegion,readRegionBlob,removeRegion,regionForTab,saveRegion,listRegions,type RegionRecord} from './store';

interface Activation {url:string;navigationId:string;documentId?:string;windowId:number;}
interface Context {record:RegionRecord;channel:ChannelConnection;core?:ChannelRuntime;missingResults:Set<string>;active:boolean;abort:AbortController;waiting?:AbortController;}
const contexts=new Map<number,Context>();
const epochs=new Map<number,object>(),windowEpochs=new Map<number,object>();
const generations=new Map<number,number>();
const activatedTabs=new Set<number>();
const transfers=new Map<number,Set<()=>void>>();
let configuration=0,lastCapture=0;
const changed=()=>Error(msg('选区已失效，请重新框选。'));
const identityTarget=(activation:Activation)=>({frameId:0,...(activation.documentId?{documentId:activation.documentId}:{})});
const epochFor=(tabId:number)=>{let token=epochs.get(tabId);if(!token){token={};epochs.set(tabId,token);}return token;};
function stopContext(tabId:number) {
  epochs.set(tabId,{});
  const ctx=contexts.get(tabId);
  if(ctx){ctx.active=false;ctx.waiting?.abort();ctx.abort.abort();ctx.core?.dispose();ctx.channel.dispose();contexts.delete(tabId);}
  for(const close of transfers.get(tabId)??[])close();
}
async function abandon(tabId:number,id?:string,generation?:number) {
  if(generation!==undefined&&generation<(generations.get(tabId)??0))return;
  const current=await regionForTab(tabId);
  if(id&&current&&current.id!==id&&(generation===undefined||current.generation>generation))return;
  // Closing during capture must invalidate the capture even before a row exists.
  stopContext(tabId);await removeRegion(tabId,current?.id);
}
export async function activateRegion(tabId:number) {
  await navigator.locks.request('nc-inline-activation:'+tabId,async()=>{
    const tab=await chrome.tabs.get(tabId);
    if(!tab.active||!tab.url||!safeImageUrl(tab.url,tab.url))throw Error(msg('请在普通网页中使用翻译。'));
    await suspendInline(tabId);
    activatedTabs.add(tabId);stopContext(tabId);generations.delete(tabId);await removeRegion(tabId);
    const injected=await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/region.js']});
    const documentId=injected[0]?.documentId,target={frameId:0,...(documentId?{documentId}:{})};
    const identity=await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_IDENTITY'},target) as RegionIdentity;
    if(identity?.url!==tab.url)throw changed();
    const activation:Activation={url:tab.url,navigationId:identity.navigationId,documentId,windowId:tab.windowId};
    await chrome.storage.session.set({[regionActivationKey(tabId)]:activation});
    await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_START'},target);
  });
}
async function checked(sender:chrome.runtime.MessageSender,request:{navigationId:string;generation:number;selectionId?:string},live=true) {
  const tabId=sender.tab?.id;
  if(sender.id!==chrome.runtime.id||tabId==null||sender.frameId!==0||typeof request.navigationId!=='string'
    ||!Number.isSafeInteger(request.generation)||request.generation<0)throw changed();
  const saved=await chrome.storage.session.get(regionActivationKey(tabId));
  const activation=saved[regionActivationKey(tabId)] as Activation|undefined;
  if(!activation||activation.navigationId!==request.navigationId||activation.documentId&&activation.documentId!==sender.documentId)throw changed();
  const tab=await chrome.tabs.get(tabId);
  if(tab.url!==activation.url||tab.windowId!==activation.windowId)throw changed();
  try{if(new URL(sender.url??'').origin!==new URL(activation.url).origin)throw changed();}catch{throw changed();}
  let identity:RegionIdentity|undefined;
  if(live){
    identity=await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_IDENTITY'},identityTarget(activation));
    if(!identity?.enabled||identity.url!==activation.url||identity.navigationId!==request.navigationId||identity.generation!==request.generation
      ||request.selectionId&&identity.selectionId!==request.selectionId)throw changed();
    generations.set(tabId,Math.max(generations.get(tabId)??0,request.generation));
  }
  return {tabId,tab,activation,identity};
}
async function selected(request:RegionImageRequest|RegionRequest,sender:chrome.runtime.MessageSender) {
  const authorized=await checked(sender,request);
  if(typeof request.selectionId!=='string'||request.selectionId.length>80)throw changed();
  const record=await readRegion(request.selectionId);
  if(!record||record.tabId!==authorized.tabId||record.navigationId!==request.navigationId||record.generation!==request.generation)throw changed();
  return {...authorized,record};
}
function response(record:RegionRecord,ctx?:Context):RegionResponse {
  const result:RegionResponse={selectionId:record.id,width:record.width,height:record.height,rect:record.rect,submitted:record.submitted,
    language:record.language,scope:record.scope,requiresInternet:ctx?.channel.requiresInternet};
  if(!ctx)return result;
  if(!ctx.channel.available){result.state=ctx.channel.unavailable;return result;}
  if(record.page&&record.language){
    const selected=pageTranslation(record.page,'classic',record.language,ctx.channel.scope.key);
    const missing=selected.result&&ctx.missingResults.has(selected.result.id);
    if(selected.result?.result&&!selected.expired&&!missing)result.resultKey=JSON.stringify([record.scope,selected.result.id,selected.result.result.key]);
    else{
      result.state=ctx.core?.stateFor({entryId:'region:'+record.id,page:record.page,mode:'classic'},record.submitted);
      if(missing&&!selected.pending&&selected.latest?.id===selected.result?.id)
        result.state={kind:'error',message:record.page.translationError??msg('本地译图缓存已清理，请手动重新翻译。'),retryable:true,retryAction:'translate'};
    }
  }
  result.retryAfterMs=ctx.core?.retryDelay||undefined;
  result.hasPending=!!ctx.core?.hasPending||!result.resultKey&&!!result.retryAfterMs;
  return result;
}
async function capture(request:RegionRequest,sender:chrome.runtime.MessageSender):Promise<RegionResponse> {
  const before=await checked(sender,request);
  if(!before.tab.active||before.tab.status==='loading'||!request.selectionId||request.selectionId.length>80||!request.rect||!validViewport(request.viewport)
    ||!before.identity||!sameViewport(before.identity.viewport,request.viewport))throw changed();
  const previous=await regionForTab(before.tabId);
  if(previous?.id===request.selectionId&&previous.generation===request.generation)return response(previous,contexts.get(before.tabId));
  const epoch=epochFor(before.tabId),windowEpoch={},config=configuration;
  windowEpochs.set(before.tab.windowId,windowEpoch);
  const current=()=>epoch===epochs.get(before.tabId)&&windowEpoch===windowEpochs.get(before.tab.windowId)&&config===configuration;
  try{
  // Chrome permits two captures/second. Serialize globally, with no repeated capture loop.
  const remaining=Math.max(0,600-(Date.now()-lastCapture));
  if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));
  const preCapture=await checked(sender,request);
  if(!preCapture.tab.active||!preCapture.identity||!sameViewport(preCapture.identity.viewport,request.viewport))throw changed();
  assertCurrent(current);lastCapture=Date.now();
  let captured:Awaited<ReturnType<typeof captureRegion>>;
  try{captured=await captureRegion(before.tab.windowId,request.rect,request.viewport,current);}
  catch{throw Error(msg('截图失败，请保持当前标签页可见后重试。'));}
  const after=await checked(sender,request);
  if(!current()||!after.tab.active||!after.identity||!sameViewport(after.identity.viewport,request.viewport))throw changed();
  const record:RegionRecord={id:request.selectionId,tabId:before.tabId,
    navigationId:request.navigationId,generation:request.generation,rect:captured.rect,
    width:captured.width,height:captured.height,sourceSha256:captured.sha256,bytes:captured.blob.size,submitted:false};
  try{await saveRegion(record,captured.blob);}catch{throw Error(msg('无法保存截图，请释放本地存储空间后重试。'));}
  if(!current()){await removeRegion(record.tabId,record.id);throw changed();}
  stopContext(before.tabId);
  return response(record);
  }finally{windowEpochs.delete(before.tab.windowId);}
}
async function frozenInput(record:RegionRecord,current:()=>boolean,limits?:Capabilities['limits']):Promise<PreparedInput> {
  const page=record.page,blob=await readRegionBlob(record,'input');assertCurrent(current);
  if(!page||!blob||blob.size!==page.imageByteSize||await hashFile(blob)!==page.imageSha256)throw changed();
  if(blob.size>(limits?.max_bytes??Infinity)||page.width*page.height>(limits?.max_pixels??Infinity)
    ||Math.max(page.width,page.height)>(limits?.max_dimension??Infinity))throw Error(msg('图片尺寸超过翻译服务限制。'));
  return {width:page.width,height:page.height,sourceSha256:page.imageSha256!,image:{sha256:page.imageSha256!,byte_size:blob.size,content_type:blob.type,normalization_version:1}};
}
async function context(record:RegionRecord):Promise<Context> {
  const old=contexts.get(record.tabId);if(old?.record.id===record.id&&old.active)return old;
  stopContext(record.tabId);
  const epoch=epochFor(record.tabId),config=configuration;
  let ctx:Context|undefined;
  const current=()=>config===configuration&&epoch===epochs.get(record.tabId)&&(!ctx||ctx.active);
  const channel=await openActiveChannel(current);
  try{
    assertCurrent(current);
    const saved=await chrome.storage.local.get(settingsKey),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>};
    assertCurrent(current);
    if(record.submitted&&(record.scope!==channel.scope.key||record.channelKey!==channel.key||record.language!==settings.language))
      throw Error(msg('翻译设置已变化，请重新框选。'));
    ctx={record,channel,missingResults:new Set(),active:true,abort:new AbortController()};contexts.set(record.tabId,ctx);
    return ctx;
  }catch(error){channel.dispose();throw error;}
}
async function prepare(ctx:Context) {
  if(ctx.record.submitted)return;
  const {channel}=ctx,current=()=>ctx.active&&channel.isCurrent();
  const saved=await chrome.storage.local.get(settingsKey),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>};
  if(!channel.capabilities.modes.some(mode=>mode.id==='classic'&&mode.enabled)||!supportsLanguage(channel.capabilities,'classic',settings.language))
    throw Error(msg('此翻译方式暂不可用'));
  const source=await readRegionBlob(ctx.record,'source');assertCurrent(current);if(!source)throw changed();
  const sourcePage={...emptyPage(msg('划图翻译'),ctx.record.width,ctx.record.height),imageSha256:ctx.record.sourceSha256,imageByteSize:source.size,imageMime:source.type};
  const prepared=await prepareTranslationInput(sourcePage,async()=>source,current,channel.capabilities.limits);assertCurrent(current);
  const input=prepared.blob??source;
  // The durable cropped input is this independent page's source. Keeping its identity
  // here avoids a second lossy encode and makes result composition independent of the DOM.
  const page={...emptyPage(msg('划图翻译'),prepared.width,prepared.height),id:prepared.image.sha256,imageSha256:prepared.image.sha256,
    imageMime:input.type,imageByteSize:input.size,blobKey:'region:'+ctx.record.id,translationScope:channel.scope.key};
  const record={...ctx.record,page,scope:channel.scope.key,channelKey:channel.key,language:settings.language,
    submitted:true,inputIsSource:input===source,bytes:source.size+(input===source?0:input.size)};
  try{await saveRegion(record,undefined,input);}catch{throw Error(msg('无法保存截图，请释放本地存储空间后重试。'));}
  assertCurrent(current);ctx.record=record;
}
async function runtime(ctx:Context) {
  if(ctx.core)return ctx.core;
  const current=()=>ctx.active&&ctx.channel.isCurrent();
  ctx.core=ctx.channel.createRuntime({language:ctx.record.language!,isCurrent:current,
    getBlob:key=>key===ctx.record.page?.blobKey?readRegionBlob(ctx.record,'input'):Promise.resolve(undefined),
    prepareInput:(_target,live,limits)=>frozenInput(ctx.record,()=>current()&&live(),limits),
    onJobs:async jobs=>{
      assertCurrent(current);if(!ctx.record.page)return;
      const incoming=jobs.filter(job=>matchesPage(ctx.record.page!,job));if(!incoming.length)return;
      // Channels persist their own receipts/history. This store owns only frozen selection input.
      ctx.record={...ctx.record,page:{...ctx.record.page,jobs:mergeJobs(ctx.record.page.jobs,incoming)}};
    },onChange:()=>{},
  });
  await ctx.core.init();return ctx.core;
}
async function step(request:RegionRequest,sender:chrome.runtime.MessageSender) {
  const {record}=await selected(request,sender);
  if(!record.submitted&&!['NC_REGION_SUBMIT','NC_REGION_RETRY'].includes(request.type))return response(record);
  const ctx=await context(record);
  if(!ctx.channel.available)return response(ctx.record,ctx);
  await prepare(ctx);const recovering=!ctx.core,core=await runtime(ctx);
  const target={entryId:'region:'+ctx.record.id,page:ctx.record.page!,mode:'classic' as const};
  if(request.type==='NC_REGION_WAIT'){
    // A WAIT can be the first message after MV3 suspension. Restore only this
    // already-submitted selection, with its original operation identity.
    if(recovering)await core.submit([target],()=>ctx.active);
    if(!ctx.waiting||ctx.waiting.signal.aborted)ctx.waiting=new AbortController();
    const waiting=ctx.waiting;
    try{await core.wait(waiting.signal);}catch(error){if(!waiting.signal.aborted)throw error;}
  }else{
    ctx.waiting?.abort();
    if(request.type==='NC_REGION_RETRY')await core.manual(target);
    else await core.submit([target],()=>ctx.active);
  }
  return response(ctx.record,ctx);
}
async function imageResponse(request:RegionImageRequest,sender:chrome.runtime.MessageSender,signal:AbortSignal) {
  const {record}=await selected(request,sender),epoch=epochFor(record.tabId),config=configuration;
  const current=()=>!signal.aborted&&epoch===epochs.get(record.tabId)&&config===configuration;
  if(request.kind==='source'){
    const blob=await readRegionBlob(record,'source');assertCurrent(current);if(!blob)throw changed();return {blob,current};
  }
  const ctx=contexts.get(record.tabId);
  if(!ctx||!ctx.active||ctx.record.id!==record.id||!ctx.record.page||!record.language||response(ctx.record,ctx).resultKey!==request.resultKey)throw changed();
  const job=pageTranslation(ctx.record.page,'classic',record.language,ctx.channel.scope.key).result;
  if(!job?.result)throw changed();
  const live=()=>current()&&ctx.active&&ctx.channel.isCurrent()&&response(ctx.record,ctx).resultKey===request.resultKey;
  let blob:Blob;
  try{blob=await ctx.channel.readResult(job,AbortSignal.any([signal,ctx.abort.signal]),()=>readRegionBlob(ctx.record,'input'));}
  catch(error){
    if(error instanceof Error&&'code' in error&&error.code==='RESULT_NOT_CACHED'&&live()&&ctx.record.page){
      ctx.missingResults.add(job.id);ctx.record={...ctx.record,page:{...ctx.record.page,translationError:error.message}};
    }
    throw error;
  }
  assertCurrent(live);return {blob,current:live};
}
export function registerRegionBackground() {
  chrome.tabs.onActivated.addListener(({windowId})=>{if(windowEpochs.has(windowId))windowEpochs.set(windowId,{});});
  chrome.tabs.onUpdated.addListener((tabId,change)=>{
    if(!activatedTabs.has(tabId)||change.status!=='loading'&&!change.url)return;
    stopContext(tabId);generations.delete(tabId);activatedTabs.delete(tabId);epochs.delete(tabId);
    void chrome.storage.session.remove(regionActivationKey(tabId));void removeRegion(tabId).catch(()=>{});
  });
  chrome.tabs.onRemoved.addListener(tabId=>{if(!activatedTabs.has(tabId))return;stopContext(tabId);generations.delete(tabId);activatedTabs.delete(tabId);epochs.delete(tabId);void removeRegion(tabId).catch(()=>{});void chrome.storage.session.remove(regionActivationKey(tabId));});
  const invalidate=()=>{
    configuration++;
    const invalidated=new Map<number,object>();
    for(const tabId of activatedTabs){stopContext(tabId);invalidated.set(tabId,epochFor(tabId));}
    void chrome.storage.session.get(null).then(async saved=>{
      for(const [tabId,epoch] of invalidated){
        const activation=saved[regionActivationKey(tabId)] as Activation|undefined;
        if(!activation||epoch!==epochs.get(tabId))continue;
        const record=await regionForTab(tabId);
        if(epoch!==epochs.get(tabId))continue;
        await chrome.tabs.sendMessage(tabId,{type:'NC_REGION_CONFIG_CHANGED'},identityTarget(activation)).catch(()=>{});
        if(record)await removeRegion(tabId,record.id).catch(()=>{});
      }
    }).catch(()=>{});
  };
  subscribeChannels(invalidate);
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&changes[settingsKey]&&(changes[settingsKey].oldValue as Settings|undefined)?.language!==(changes[settingsKey].newValue as Settings|undefined)?.language)invalidate();
    if(area==='session')for(const [key,value] of Object.entries(changes))if(key.startsWith('nc-region:')&&!value.newValue){
      const id=Number(key.slice('nc-region:'.length));if(!activatedTabs.has(id))continue;
      void navigator.locks.request('nc-inline-activation:'+id,async()=>{
        const saved=await chrome.storage.session.get(key);if(saved[key]||!activatedTabs.has(id))return;
        await abandon(id);activatedTabs.delete(id);generations.delete(id);epochs.delete(id);
      }).catch(()=>{});
    }
  });
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!==REGION_IMAGE_PORT)return;
    const sender=port.sender,tabId=sender?.tab?.id;
    if(!sender||sender.id!==chrome.runtime.id||tabId==null||sender.frameId!==0){port.disconnect();return;}
    const active=transfers.get(tabId)??new Set<()=>void>();if(active.size>=2){port.disconnect();return;}transfers.set(tabId,active);
    const close=serveImage(port,async(value,signal)=>{
      const request=value as RegionImageRequest;
      if(!request||!['source','result'].includes(request.kind)||request.kind==='result'&&(typeof request.resultKey!=='string'||request.resultKey.length>2048))throw changed();
      return imageResponse(request,sender,signal);
    },()=>{active.delete(close);if(!active.size)transfers.delete(tabId);});active.add(close);
  });
  chrome.runtime.onMessage.addListener((message:RegionRequest,sender,respond)=>{
    if(!['NC_REGION_CAPTURE','NC_REGION_SUBMIT','NC_REGION_TICK','NC_REGION_WAIT','NC_REGION_RETRY','NC_REGION_CLOSE','NC_REGION_PAUSE','NC_REGION_OPEN'].includes(message?.type)
      ||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void(async()=>{
      if(['NC_REGION_OPEN','NC_REGION_PAUSE','NC_REGION_CLOSE'].includes(message.type)){
        const {tabId}=await checked(sender,message,message.type==='NC_REGION_OPEN');
        if(message.type==='NC_REGION_OPEN'){await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#'+(message.view==='settings'?'settings':'account'))});return;}
        if(message.type==='NC_REGION_PAUSE'){const ctx=contexts.get(tabId);if(ctx&&ctx.record.id===message.selectionId)ctx.waiting?.abort();return;}
        await abandon(tabId,message.selectionId,message.generation);return;
      }
      if(message.type==='NC_REGION_CAPTURE')return navigator.locks.request('nc-region-capture',()=>capture(message,sender));
      if(message.type==='NC_REGION_WAIT')return step(message,sender);
      return navigator.locks.request('nc-region-step:'+sender.tab!.id,()=>step(message,sender));
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message}));return true;
  });
  // Worker restarts retain live documents; closed/navigated documents cannot reattach a crop.
  void listRegions().then(async records=>{
    for(const record of records){
      const saved=await chrome.storage.session.get(regionActivationKey(record.tabId)),activation=saved[regionActivationKey(record.tabId)] as Activation|undefined;
      if(!activation||activation.navigationId!==record.navigationId){await removeRegion(record.tabId,record.id);continue;}
      const identity=await chrome.tabs.sendMessage(record.tabId,{type:'NC_REGION_IDENTITY'},identityTarget(activation)).catch(()=>null) as RegionIdentity|null;
      if(identity?.navigationId!==record.navigationId||!identity.enabled||identity.selectionId!==record.id)await removeRegion(record.tabId,record.id);
      else activatedTabs.add(record.tabId);
    }
  }).catch(()=>{});
  void chrome.storage.session.get(null).then(saved=>{
    for(const key of Object.keys(saved))if(key.startsWith('nc-region:'))activatedTabs.add(Number(key.slice('nc-region:'.length)));
  }).catch(()=>{});
}
