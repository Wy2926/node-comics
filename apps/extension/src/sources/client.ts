import type {PageManifest} from './adapters';
import type {SourceCatalog} from '../library/types';
import {pollSourceDiscovery} from './discovery';
export const inExtension=()=>typeof chrome!=='undefined'&&!!chrome.runtime?.id;
export async function sourceMessage<T>(message:unknown):Promise<T>{if(!inExtension())throw Error('网站采集需在已安装的浏览器插件中执行。');const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error??'插件通信失败，请重新打开阅读器。');return result.data as T;}
export async function discoverEntry(catalog:SourceCatalog,entryId:string,signal:AbortSignal,onProgress:(manifest:PageManifest)=>Promise<void>,assertActive?:()=>Promise<void>){
 signal.throwIfAborted();
 await sourceMessage({type:'NC_REGISTER_CATALOG',catalog});const {tabId}=await sourceMessage<{tabId:number}>({type:'NC_OPEN_SOURCE',catalogId:catalog.id,entryId});
 try{
  return await pollSourceDiscovery(()=>sourceMessage<PageManifest|null>({type:'NC_POLL_SOURCE',tabId}),{signal,onProgress,assertActive});
 }finally{await sourceMessage({type:'NC_CLOSE_SOURCE',tabId}).catch(()=>{});}
}
export async function discoverCatalog(url:string):Promise<SourceCatalog>{
 if(!inExtension())throw Error('请在插件中打开 MangaCopy 详情页。');
 const tab=await chrome.tabs.create({url,active:false});if(tab.id==null)throw Error('无法打开来源页面。');
 try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,500));const t=await chrome.tabs.get(tab.id);if(t.url!==url&&t.status==='complete')throw Error('来源页面跳转，请回源核实。');if(t.status!=='complete')continue;const result=await sourceMessage<{kind:string;catalog?:SourceCatalog}>({type:'NC_DISCOVER_TAB',tabId:tab.id});if(result.catalog?.complete)return result.catalog;}throw Error('目录未完整加载，请打开来源页处理后重试。');}
 finally{const current=await chrome.tabs.get(tab.id).catch(()=>null);if(current?.url===url)await chrome.tabs.remove(tab.id);}
}
