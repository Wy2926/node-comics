import type {Settings} from '../types';
import {settingsKey} from './settings';
import {automaticTabUrl,matchAutomaticTab,normalizeAutoTranslateSites,type AutoTranslateSite} from './auto-tab-rules';
import type {AutoTabRegexResult} from './auto-tab-regex';
import {LOCAL_HOST_MESSAGE} from '../translation/channels/host-client';

export const inlineOrigins=['https://*/*','http://*/*'] as const;
interface Policy {enabled:boolean;sites:Map<string,AutoTranslateSite>;matches:Map<string,Promise<boolean>>;}
let policy:Promise<Policy>|undefined;
async function readPolicy(value?:Partial<Settings>):Promise<Policy>{
  const saved=value??(await chrome.storage.local.get(settingsKey))[settingsKey] as Partial<Settings>|undefined;
  return {enabled:saved?.autoTranslateTabs===true&&await chrome.permissions.contains({origins:[...inlineOrigins]}),
    sites:new Map(normalizeAutoTranslateSites(saved?.autoTranslateSites).map(site=>[site.hostname,site])),matches:new Map()};
}

export async function automaticTabsAllowed(tabUrl?:string):Promise<boolean>{
  const url=automaticTabUrl(tabUrl);if(!url)return false;
  const snapshot=policy??=readPolicy(),current=await snapshot;
  if(policy!==snapshot)return automaticTabsAllowed(tabUrl);
  if(!current.enabled)return false;
  const site=current.sites.get(url.hostname);if(!site)return false;
  const matched=matchAutomaticTab(site,url);if(matched!==undefined)return matched;
  let pending=current.matches.get(url.href);
  if(!pending){
    pending=(async()=>{
      try{
        // Firefox/Safari background documents can own workers directly; runtime
        // messages cannot dispatch back into the sending background context.
        if(typeof document!=='undefined'){
          const {runAutoTabRegex}=await import('./auto-tab-regex');
          const result=await runAutoTabRegex(site.value,url.href);
          if(result.error==='unavailable')current.matches.delete(url.href);
          return result.matches;
        }
        const {ensureLocalHost}=await import('../translation/channels/host-background');
        await ensureLocalHost();
        const reply=await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'match-tab-url',pattern:site.value,url:url.href});
        const result=reply?.value as AutoTabRegexResult|undefined;
        if(!reply?.ok||result?.error==='unavailable')current.matches.delete(url.href);
        return reply?.ok===true&&result?.matches===true;
      }catch{current.matches.delete(url.href);return false;}
    })();
    if(current.matches.size>=64)current.matches.delete(current.matches.keys().next().value!);
    current.matches.set(url.href,pending);
  }
  const allowed=await pending;
  return policy===snapshot?allowed:automaticTabsAllowed(tabUrl);
}

/** No polling or image scanning: reconcile tab URLs on browser/configuration events. */
export function registerAutomaticTabs(activate:(tabId:number,automatic:boolean)=>Promise<void>,stop:(tabId:number)=>Promise<void>){
  policy=undefined;
  const reconcileTab=async(tab:chrome.tabs.Tab)=>{
    if(tab.id==null)return;
    if(!await automaticTabsAllowed(tab.url)){await stop(tab.id);return;}
    if(tab.active&&tab.status!=='loading')await activate(tab.id,true);
  };
  const reconcile=async()=>{
    const tabs=await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(reconcileTab));
  };
  chrome.tabs.onUpdated.addListener((_id,change,tab)=>{if(change.status==='complete'||change.url)void reconcileTab(tab).catch(()=>{});});
  chrome.tabs.onActivated.addListener(({tabId})=>{void chrome.tabs.get(tabId).then(reconcileTab).catch(()=>{});});
  chrome.storage.onChanged.addListener((changes,area)=>{
    const value=changes[settingsKey];
    if(area!=='local'||!value)return;
    const before=value.oldValue as Settings|undefined,after=value.newValue as Settings|undefined;
    if(before?.autoTranslateTabs===after?.autoTranslateTabs&&JSON.stringify(before?.autoTranslateSites)===JSON.stringify(after?.autoTranslateSites))return;
    policy=readPolicy(after??{autoTranslateTabs:false});
    void reconcile().catch(()=>{});
  });
  chrome.permissions.onRemoved.addListener(()=>{void (async()=>{
    policy=undefined;
    if(await chrome.permissions.contains({origins:[...inlineOrigins]}))return;
    const saved=await chrome.storage.local.get(settingsKey),value=saved[settingsKey] as Settings|undefined;
    if(value?.autoTranslateTabs)await chrome.storage.local.set({[settingsKey]:{...value,autoTranslateTabs:false}});
    await reconcile();
  })().catch(()=>{});});
  chrome.permissions.onAdded?.addListener(()=>{policy=undefined;void reconcile().catch(()=>{});});
  chrome.runtime.onStartup.addListener(()=>{policy=undefined;void reconcile().catch(()=>{});});
  void reconcile().catch(()=>{});
}
