import {requireHostAccess} from '../host-permissions';
import {msg} from '../i18n/runtime';
import {activateInline} from '../inline/background';
import {activateRegion} from '../region/background';
import {decodeShortcutOverrides,loadShortcutOverrides,shortcutStorageKey} from './store';
import type {ShortcutOverrides} from './catalog';

const isWebsite=(url:unknown):url is string=>typeof url==='string'&&/^https?:\/\//.test(url);
const fromWebsite=(sender:chrome.runtime.MessageSender)=>sender.id===chrome.runtime.id
  && sender.frameId===0&&sender.tab?.id!=null&&isWebsite(sender.url);
const actions=new Set(['web.translate','web.shortcuts']);
const publicOverrides=(value:ShortcutOverrides):ShortcutOverrides=>Object.fromEntries(Object.entries(value).filter(([id])=>id.startsWith('web.')));

/** Own protocol: no relaxation of the existing extension-only translation messages. */
export function registerWebShortcutsBackground() {
  const startingRegions=new Set<number>();
  // A native command grants activeTab. A website keydown does not authorize captureVisibleTab.
  chrome.commands.onCommand.addListener((command,source)=>{
    if(command!=='nc-translate-region')return;
    void (async()=>{
      const tab=source?.id!=null?await chrome.tabs.get(source.id):(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0];
      if(tab?.id==null||!tab.active||!isWebsite(tab.url)||source?.url&&source.url!==tab.url||startingRegions.has(tab.id))return;
      const tabId=tab.id;startingRegions.add(tabId);
      try{await requireHostAccess();await activateRegion(tabId);}
      catch(error){
        const current=await chrome.tabs.get(tabId).catch(()=>undefined);
        if(!current?.active||current.url!==tab.url)return;
        const shown=await chrome.tabs.sendMessage(tabId,{type:'NC_SHORTCUTS_ERROR',error:error instanceof Error?error.message:msg('连接失败')},{frameId:0}).catch(()=>undefined);
        if(!shown?.ok)await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#settings')});
      }finally{startingRegions.delete(tabId);}
    })().catch(()=>{});
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['NC_SHORTCUTS_GET','NC_SHORTCUTS_EXECUTE'].includes(message?.type)||!fromWebsite(sender))return;
    void (async()=>{
      if(message.type==='NC_SHORTCUTS_GET')return {ok:true,overrides:publicOverrides(await loadShortcutOverrides())};
      if(!actions.has(message.action)||!isWebsite(message.url)||typeof message.instanceId!=='string'||message.instanceId.length>80)
        throw Error(msg('当前标签页不可用，请重新打开插件。'));
      const tab=await chrome.tabs.get(sender.tab!.id!);
      if(!tab.active||!isWebsite(tab.url)||tab.url!==message.url||new URL(sender.url!).origin!==new URL(tab.url).origin)
        throw Error(msg('当前网页已变化，请重新打开插件后翻译。'));
      const identity=await chrome.tabs.sendMessage(tab.id!,{type:'NC_SHORTCUTS_IDENTITY'},
        {frameId:0,...(sender.documentId?{documentId:sender.documentId}:{})});
      if(identity?.url!==tab.url||identity.instanceId!==message.instanceId)
        throw Error(msg('当前网页已变化，请重新打开插件后翻译。'));
      if(message.action==='web.shortcuts')await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html#settings/shortcuts')});
      else {
        await requireHostAccess();
        await activateInline(tab.id!);
      }
      return {ok:true};
    })().then(respond).catch(error=>respond({ok:false,error:error instanceof Error?error.message:msg('连接失败')}));
    return true;
  });
  let revision=0;
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes[shortcutStorageKey])return;
    const saved:unknown=changes[shortcutStorageKey].newValue;
    const overrides=publicOverrides(decodeShortcutOverrides(saved)),stamp=++revision;
    void chrome.tabs.query({url:['http://*/*','https://*/*']}).then(tabs=>{
      if(stamp!==revision)return;
      return Promise.all(tabs.map(tab=>tab.id==null?undefined:chrome.tabs.sendMessage(tab.id,{type:'NC_SHORTCUTS_CHANGED',overrides},{frameId:0}).catch(()=>{})));
    }).catch(()=>{});
  });
}
