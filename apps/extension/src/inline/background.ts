import {Api} from '../api';
import {RequestPool,assertCurrent} from '../concurrency';
import {imageIdentity} from '../importers/hash';
import {getBlob,putBlob,removeBlob,type Session} from '../library/store';
import {emptyPage} from '../reader/model';
import {safeImageUrl} from '../sources/adapters';
import {sourceImage} from '../sources/image-fetch';
import {defaults,supportsLanguage,type Page,type Settings} from '../types';
import {comicSize,type InlineRequest,type InlineResponse,type InlineResult} from './protocol';
import {settingsKey,sessionKey} from './settings';
import {inlineError,translateInlinePage} from './translate';
import {readingPriority} from '../translation/sync';
import {imageDataUrl,maxInlineBytes} from './bytes';
import {readManifest,translationScope} from '../translation/store';
import {targetKey} from '../translation/automatic';

interface Activation {url:string;navigationId:string;documentId?:string;}
const activationKey=(tabId:number)=>'nc-inline:'+tabId;
const generations=new Map<number,number>();
const pages=new Map<string,Page>();
let configGeneration=0;
export async function activateInline(tabId:number){
  generations.set(tabId,(generations.get(tabId)??0)+1);
  const injected=await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/inline.js']});
  const identity=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_IDENTITY'},{frameId:0});
  if(!identity||!safeImageUrl(identity.url,identity.url))throw Error('请在普通网页中使用翻译。');
  await chrome.storage.session.set({[activationKey(tabId)]:{...identity,documentId:injected[0]?.documentId}});
  await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_START'},{frameId:0});
}
async function tick(request:InlineRequest,sender:chrome.runtime.MessageSender):Promise<InlineResponse>{
  const tabId=sender.tab!.id!,generation=generations.get(tabId)??0,configStamp=configGeneration;
  const saved=await chrome.storage.local.get([settingsKey,sessionKey]);
  const settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>},session=saved[sessionKey] as Session|null;
  const {translationMode:mode,language}=settings,origin=new URL(settings.apiBase).origin;
  const scope=JSON.stringify([origin,session?.user.id??'',mode,language]);
  const base={mode,language,scope};
  if(!session||session.apiOrigin!==origin)return {...base,items:request.images.map(i=>({id:i.id,state:{kind:'login',message:'登录后自动翻译'}}))};
  const live=()=>configStamp===configGeneration&&generation===(generations.get(tabId)??0);
  const api=new Api(settings.apiBase,session.token,new RequestPool(settings.requestConcurrency),live);
  const items:InlineResult[]=[];
  const translatedPages:Page[]=[];
  let responseBytes=0;
  const config=await Promise.all([api.capabilities(),api.entitlements()]).catch(error=>{assertCurrent(live);return inlineError(error);});
  if(!Array.isArray(config))return {...base,items:request.images.map(i=>({id:i.id,state:config}))};
  const [caps,rights]=config;
  assertCurrent(live);
  if(!caps.modes.find(m=>m.id===mode)?.enabled||!supportsLanguage(caps,mode,language))return {...base,items:request.images.map(i=>({id:i.id,state:{kind:'error',message:'此翻译方式暂不可用',retryable:false}}))};
  for(const image of request.images){
    assertCurrent(live);
    let sourcePage:Page|undefined;
    try{
      const readSource=async()=>{
        if(image.url!=='page-image:'+image.id)return sourceImage(image.url);
        const source=await chrome.tabs.sendMessage(tabId,{type:'NC_INLINE_SOURCE',navigationId:request.navigationId,id:image.id},{documentId:sender.documentId,frameId:0});
        assertCurrent(live);
        if(typeof source?.data!=='string'||source.data.length>maxInlineBytes*4/3+200||!/^data:[\w.+/-]+;base64,/.test(source.data))throw Error(source?.error??'网页原图读取失败。');
        return (await fetch(source.data)).blob();
      };
      const key=JSON.stringify([tabId,request.navigationId,image.id,image.url]);
      let page=pages.get(key);
      if(!page){
        const blob=await readSource();
        assertCurrent(live);
        if(blob.size>caps.limits.max_bytes)throw Error('图片超过翻译服务的大小限制。');
        const bitmap=await createImageBitmap(blob),width=bitmap.width,height=bitmap.height;bitmap.close();
        if(width*height>caps.limits.max_pixels||Math.max(width,height)>caps.limits.max_dimension)throw Error('图片尺寸超过翻译服务限制。');
        const identity=await imageIdentity(blob);assertCurrent(live);
        page={...emptyPage('网页漫画',width,height),...identity,id:identity.imageSha256,imageByteSize:blob.size,imageMime:blob.type,blobKey:`inline-original:${scope}:${identity.imageSha256}`};
        await putBlob(page.blobKey!,blob);pages.set(key,page);
        // Only small metadata is retained in memory; originals leave cache after upload.
        if(pages.size>200)pages.delete(pages.keys().next().value!);
      }
      sourcePage=page;
      const original=page;
      const loadOriginal=async(blobKey:string)=>{
        const cached=await getBlob(blobKey);if(cached)return cached;
        const blob=await readSource(),identity=await imageIdentity(blob);assertCurrent(live);
        if(identity.imageSha256!==original.imageSha256)throw Error('网站已更换原图，请重新右键翻译当前页面。');
        await putBlob(blobKey,blob);return blob;
      };
      const result=await navigator.locks.request(`nc-inline-page:${scope}:${page.id}`,()=>translateInlinePage({api,page:original,mode,language,userId:session.user.id,caps,rights,getBlob:loadOriginal,retry:request.retryId===image.id,sessionId:request.navigationId}));
      pages.set(key,result.page);
      translatedPages.push(result.page);
      const item:InlineResult={id:image.id,state:result.state};
      if(result.result?.output_asset_id){
        item.resultKey=JSON.stringify([scope,result.result.id,result.result.output_asset_id]);
        if(request.known[image.id]!==item.resultKey){const blob=await api.image(result.result.output_asset_id);assertCurrent(live);
          if(blob.size>maxInlineBytes)throw Error('译图超过 40 MB 限制，原图已保留。');
          if(responseBytes+blob.size<=maxInlineBytes){item.data=await imageDataUrl(blob);responseBytes+=blob.size;}
          else item.state={kind:'translating',message:'正在读取译图'};
        }
      }
      items.push(item);
    }catch(error){assertCurrent(live);items.push({id:image.id,state:inlineError(error)});}
    finally{
      if(sourcePage?.blobKey){
        const id=JSON.stringify([translationScope(origin,session.user.id),language,targetKey('inline',sourcePage,mode)]);
        const manifest=await readManifest(id);
        if(!manifest?.pending)await removeBlob(sourcePage.blobKey);
      }
    }
  }
  // Same visible-window priority as the reader; conflicts simply refresh on the next poll.
  try{
    const queue=(await api.queues()).items.find(q=>q.mode===mode);
    if(queue){const priority=readingPriority(translatedPages,translatedPages.flatMap(p=>p.jobs),mode,language,queue.realtime_limit);
      if(priority.ordered_job_ids.length)await api.priority(mode,{...priority,session_id:request.navigationId,sequence:request.prioritySequence,expected_version:queue.version,ttl_seconds:90,takeover:true});}
  }catch{/* A priority race must not discard delivered images. */}
  return {...base,items};
}
export function registerInlineBackground(){
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes[settingsKey]||changes[sessionKey])){configGeneration++;pages.clear();void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_INLINE_CONFIG_CHANGED'},{frameId:0}))));}});
  chrome.tabs.onRemoved.addListener(tabId=>{generations.set(tabId,(generations.get(tabId)??0)+1);void chrome.storage.session.remove(activationKey(tabId));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_INLINE_TICK','NC_INLINE_INVALIDATE','NC_INLINE_OPEN'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void(async()=>{
      const tabId=sender.tab!.id!,saved=await chrome.storage.session.get(activationKey(tabId)),activation=saved[activationKey(tabId)] as Activation|undefined;
      if(!activation||activation.navigationId!==message.navigationId||activation.documentId&&activation.documentId!==sender.documentId)throw Error('网页已变化，请重新右键翻译当前页面。');
      if(message.type==='NC_INLINE_INVALIDATE'){generations.set(tabId,(generations.get(tabId)??0)+1);return;}
      // Chrome can retain the initial sender.url after history.pushState; documentId
      // binds this sender, while tabs.get verifies the current same-document URL.
      const tab=await chrome.tabs.get(tabId);
      if(tab.url!==activation.url)throw Error('网页已变化，请重新右键翻译当前页面。');
      if(!activation.documentId){activation.documentId=sender.documentId;await chrome.storage.session.set({[activationKey(tabId)]:activation});}
      if(message.type==='NC_INLINE_OPEN'){await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#'+(message.view==='settings'?'settings':'account'))});return;}
      if(!Number.isSafeInteger(message.prioritySequence)||message.prioritySequence<1||message.prioritySequence>2147483647)throw Error('阅读会话顺序无效。');
      if(!Array.isArray(message.images)||message.images.length>3||message.images.some((i:unknown)=>{const v=i as {id?:string;url?:string;width:number;height:number};return !v||typeof v.id!=='string'||v.id.length>80||typeof v.url!=='string'||v.url!=='page-image:'+v.id&&safeImageUrl(v.url,activation.url)!==v.url||!comicSize(v.width,v.height);})||!message.known||typeof message.known!=='object')throw Error('图片范围无效。');
      return navigator.locks.request('nc-inline-tick:'+tabId,{ifAvailable:true},lock=>lock?tick(message,sender):undefined);
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message}));return true;
  });
}
