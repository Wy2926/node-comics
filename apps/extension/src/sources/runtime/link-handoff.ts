import {msg} from '../../i18n/runtime';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';

// Worker memory only. An abandoned launch cannot be replayed after a restart, a close or a timeout.
const pending=new Map<number,{url:string;timer:ReturnType<typeof setTimeout>}>();
export function forgetLinkedReader(tabId:number) {
  const entry=pending.get(tabId);
  if (entry) {clearTimeout(entry.timer);pending.delete(tabId);}
}
export function takeLinkedReader(tabId:number) {
  const entry=pending.get(tabId);
  forgetLinkedReader(tabId);
  if (!entry) throw Error(msg('来源清单已失效，请重新发现。'));
  return entry.url;
}
export async function openLinkedReader(url:string, sourceTabId:number) {
  if (!Number.isInteger(sourceTabId)||sourceTabId<0) throw Error(msg('当前标签页不可用，请重新打开插件。'));
  const source=await chrome.tabs.get(sourceTabId);
  if (!source.url||source.url!==url || source.pendingUrl && source.pendingUrl!==url) throw Error(msg('来源页面已变化，请重新发现。'));
  const {definition,location}=resolveSource(source.url,definitions);
  if (!definition.linkMatch) throw Error(msg('来源目录无效。'));
  const {id}=await chrome.tabs.create({url:'about:blank',active:false});
  if (id==null) throw Error(msg('无法打开来源。'));
  pending.set(id,{url:location.url,timer:setTimeout(()=>forgetLinkedReader(id),60_000)});
  try {await chrome.tabs.update(id,{url:chrome.runtime.getURL('/reader.html?sourceLink=1'),active:true});}
  catch (error) {forgetLinkedReader(id);await chrome.tabs.remove(id).catch(()=>{});throw error;}
}
