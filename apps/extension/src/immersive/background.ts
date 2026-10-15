import {defaults,type Settings} from '../types';
import {settingsKey} from '../inline/settings';
import {activationKey,currentInlineActivation,type InlineActivation} from '../inline/activation';
import {serveImage} from '../inline/blob-transfer';
import {sourceFor,safeImageUrl,isImageReferrerPolicy} from '../sources';
import {networkOperation,readNetworkPageSnapshot} from '../sources/runtime/network';
import {validatePages} from '../sources/core/pages';
import {MAX_COMIC_IMAGES} from '../sources/shared/geometry';
import type {PageSnapshot} from '../sources/contracts/source';
import {IMMERSIVE_ORIGINAL_PORT,immersiveSessionKey,type ImmersiveBind,type ImmersiveSession} from './protocol';
import {clearImmersiveSources,currentImmersiveSession,readImmersiveOriginal,isImmersiveSessionCurrent} from './resources';

async function authorize(sender:chrome.runtime.MessageSender,navigationId:unknown){
  const current=await currentInlineActivation(sender,navigationId);
  if(!current?.activation.immersive)throw Error('SOURCE_SESSION_EXPIRED');
  return current;
}
function chapterSession(manifest:PageSnapshot,navigationId:string,url:string):ImmersiveSession{
  return {id:crypto.randomUUID(),navigationId,url,title:manifest.title,direction:manifest.direction,
    complete:manifest.discoveryComplete,knownTotal:manifest.knownTotal,manifest,
    images:manifest.items.map(page=>({id:crypto.randomUUID(),url:page.url,width:page.width,height:page.height}))};
}
export function registerImmersiveBackground(){
  const requests=new Map<number,AbortController>(),transfers=new Map<number,Set<()=>void>>();
  const cancel=(tabId:number)=>{
    requests.get(tabId)?.abort();requests.delete(tabId);
    for(const close of transfers.get(tabId)??[])close();
    clearImmersiveSources(tabId);
  };
  const remove=(tabId:number)=>navigator.locks.request('nc-immersive-session:'+tabId,()=>chrome.storage.session.remove(immersiveSessionKey(tabId)));
  const clear=(tabId:number)=>{cancel(tabId);void remove(tabId);};
  const save=(sender:chrome.runtime.MessageSender,session:ImmersiveSession,controller:AbortController)=>
    navigator.locks.request('nc-immersive-session:'+sender.tab!.id!,async()=>{
      await authorize(sender,session.navigationId);controller.signal.throwIfAborted();
      const tabId=sender.tab!.id!,key=immersiveSessionKey(tabId),saved=await chrome.storage.session.get(key);
      controller.signal.throwIfAborted();
      const previous=saved[key] as ImmersiveSession|undefined;
      // Lazy append retains immutable slots and their in-flight reads; replacement retires the session.
      const append=previous&&!previous.manifest&&!session.manifest&&previous.navigationId===session.navigationId&&previous.url===session.url&&
        previous.images.length<=session.images.length&&previous.images.every((image,index)=>{
          const next=session.images[index];return image.id===next.id&&image.url===next.url&&image.width===next.width&&image.height===next.height&&image.referrerPolicy===next.referrerPolicy;
        });
      if(append)session.id=previous.id;
      else{for(const close of transfers.get(tabId)??[])close();clearImmersiveSources(tabId);}
      await chrome.storage.session.set({[immersiveSessionKey(sender.tab!.id!)]:session});
      if(!append)clearImmersiveSources(tabId);
      controller.signal.throwIfAborted();return session;
    });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_IMMERSIVE_RESOLVE','NC_IMMERSIVE_BIND','NC_IMMERSIVE_RELEASE','NC_IMMERSIVE_SETTINGS'].includes(message?.type)||sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0)return;
    void (async()=>{
      const {tab}=await authorize(sender,message.navigationId),tabId=tab.id!;
      if(message.type==='NC_IMMERSIVE_RELEASE'){
        cancel(tabId);await remove(tabId);return;
      }
      const controller=new AbortController();
      if(message.type!=='NC_IMMERSIVE_SETTINGS'){
        requests.get(tabId)?.abort();requests.set(tabId,controller);
      }
      const saved=await chrome.storage.local.get(settingsKey),settings:Settings={...defaults,...saved[settingsKey] as Partial<Settings>};
      controller.signal.throwIfAborted();
      if(message.type==='NC_IMMERSIVE_SETTINGS'){
        // A page may adjust only reading presentation. Account/channel/translation preferences stay trusted-only.
        const value=message.settings as Partial<Settings>;
        const next={...settings};
        if(value?.layout==='single'||value?.layout==='continuous')next.layout=value.layout;
        if(value?.direction==='ltr'||value?.direction==='rtl')next.direction=value.direction;
        if(value?.fit==='width'||value?.fit==='window')next.fit=value.fit;
        if(['gray','paper','night'].includes(value?.readerBackground??''))next.readerBackground=value.readerBackground!;
        await chrome.storage.local.set({[settingsKey]:next});return next;
      }
      const {definition,location}=sourceFor(tab.url!);
      if(message.type==='NC_IMMERSIVE_RESOLVE'){
        if(definition.capabilities.importable&&location.kind==='reader'&&definition.capabilities.pages&&networkOperation(tab.url!,'pages')){
          const manifest=await readNetworkPageSnapshot(tab.url!,controller.signal);
          return {settings,session:await save(sender,chapterSession(manifest,message.navigationId,tab.url!),controller)};
        }
        return {settings};
      }
      const bind=message as ImmersiveBind;
      if(!Array.isArray(bind.images)||bind.images.length>MAX_COMIC_IMAGES||new Set(bind.images.map(image=>image?.id)).size!==bind.images.length||bind.images.some(image=>
        !image||typeof image.id!=='string'||!image.id||image.id.length>80||typeof image.url!=='string'||
        image.url!=='page-image:'+image.id&&safeImageUrl(image.url,tab.url!)!==image.url||
        !Number.isFinite(image.width)||!Number.isFinite(image.height)||image.width<0||image.height<0||
        image.referrerPolicy!==undefined&&!isImageReferrerPolicy(image.referrerPolicy)))throw Error('SOURCE_PAGES_INVALID');
      const session:ImmersiveSession={id:crypto.randomUUID(),navigationId:message.navigationId,url:tab.url!,title:(typeof message.title==='string'?message.title:tab.title??'').slice(0,160),
        direction:message.direction==='rtl'?'rtl':'ltr',complete:false,images:bind.images};
      if(bind.snapshot&&definition.capabilities.importable&&definition.capabilities.pages&&definition.inlineRecognition!=='generic'&&location.kind==='reader'){
        const snapshot=validatePages(bind.snapshot,location);
        if(snapshot.items.length!==bind.images.length)throw Error('SOURCE_PAGES_INVALID');
        session.manifest={...snapshot,items:snapshot.items.map(({resource,...item},index)=>{
          const image=bind.images[index];
          if(resource.kind==='http'&&image.url!==resource.url||resource.kind==='page'&&image.url!=='page-image:'+image.id)throw Error('SOURCE_PAGES_INVALID');
          return {...item,url:resource.kind==='http'?resource.url:image.url,...(resource.kind==='http'?{processing:resource.processing}:{kind:'page' as const})};
        })};
        session.complete=snapshot.discoveryComplete;session.knownTotal=snapshot.knownTotal;session.title=snapshot.title;session.direction=snapshot.direction;
      }
      return save(sender,session,controller);
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:(error as Error).message}));return true;
  });
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!==IMMERSIVE_ORIGINAL_PORT)return;
    const sender=port.sender,tabId=sender?.tab?.id;
    if(sender?.id!==chrome.runtime.id||tabId==null||sender.frameId!==0){port.disconnect();return;}
    const active=transfers.get(tabId)??new Set<()=>void>();
    if(active.size>=3){port.disconnect();return;}transfers.set(tabId,active);
    const close=serveImage(port,async(value,signal)=>{
      const request=value as {navigationId:string;id:string};
      const session=await currentImmersiveSession(sender,request.navigationId);
      const blob=await readImmersiveOriginal(sender,request.navigationId,request.id,signal);
      const latest=await currentImmersiveSession(sender,request.navigationId);
      if(latest.id!==session.id)throw Error('SOURCE_SESSION_EXPIRED');
      return {blob,current:()=>!signal.aborted&&isImmersiveSessionCurrent(tabId,session.id)};
    },()=>{active.delete(close);if(!active.size)transfers.delete(tabId);});active.add(close);
  });
  chrome.tabs.onRemoved.addListener(clear);
  chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.url||change.status==='loading')clear(tabId);});
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='session')return;
    for(const [key,change] of Object.entries(changes)){
      const tabId=Number(key.slice('nc-inline:'.length));
      const before=change.oldValue as InlineActivation|undefined,after=change.newValue as InlineActivation|undefined;
      if(key===activationKey(tabId)&&(!after?.immersive||before&&
        (before.url!==after.url||before.navigationId!==after.navigationId||before.documentId!==after.documentId)))clear(tabId);
    }
  });
}
