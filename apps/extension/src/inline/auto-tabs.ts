import {settingsKey} from './settings';
import {safeImageUrl} from '../sources/adapters';
import type {Settings} from '../types';

export const inlineOrigins=['https://*/*','http://*/*'] as const;
export async function automaticTabsAllowed(){
  const saved=await chrome.storage.local.get(settingsKey);
  return (saved[settingsKey] as Settings|undefined)?.autoTranslateTabs===true
    && await chrome.permissions.contains({origins:[...inlineOrigins]});
}

/** Event listeners wake the MV3 worker; no popup, reader, or polling loop is required. */
export function registerAutomaticTabs(activate:(tabId:number,automatic:boolean)=>Promise<void>,stop:(tabId:number)=>Promise<void>){
  const tryStart=async(tab:chrome.tabs.Tab)=>{
    if(tab.id==null||!tab.active||tab.status==='loading'||!tab.url||!safeImageUrl(tab.url,tab.url)||!await automaticTabsAllowed())return;
    await activate(tab.id,true);
  };
  const reconcile=async()=>{
    const allowed=await automaticTabsAllowed(),tabs=await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter(tab=>tab.id!=null).map(tab=>allowed?tryStart(tab):stop(tab.id!)));
  };
  chrome.tabs.onUpdated.addListener((_id,change,tab)=>{if(change.status==='complete'||change.url)void tryStart(tab).catch(()=>{});});
  chrome.tabs.onActivated.addListener(({tabId})=>{void chrome.tabs.get(tabId).then(tryStart).catch(()=>{});});
  chrome.storage.onChanged.addListener((changes,area)=>{
    const value=changes[settingsKey];
    if(area==='local'&&value&&(value.oldValue as Settings|undefined)?.autoTranslateTabs!==(value.newValue as Settings|undefined)?.autoTranslateTabs)void reconcile().catch(()=>{});
  });
  chrome.permissions.onRemoved.addListener(()=>{void (async()=>{
    if(await chrome.permissions.contains({origins:[...inlineOrigins]}))return;
    const saved=await chrome.storage.local.get(settingsKey),value=saved[settingsKey] as Settings|undefined;
    if(value?.autoTranslateTabs)await chrome.storage.local.set({[settingsKey]:{...value,autoTranslateTabs:false}});
    await reconcile();
  })().catch(()=>{});});
  chrome.runtime.onStartup.addListener(()=>{void reconcile().catch(()=>{});});
  void reconcile().catch(()=>{});
}
