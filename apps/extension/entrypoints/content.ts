import {connectContentLocale} from '../src/i18n/content';
import {subscribeLocale} from '../src/i18n/runtime';
import {msg} from '../src/i18n/runtime';
import {defineContentScript} from 'wxt/utils/define-content-script';
import {discoverMangaCopyCatalog,mangaCopyLocation,MANGACOPY_MATCHES} from '../src/sources/mangacopy';
import {readMangaCopyData} from '../src/sources/mangacopy-data';
export default defineContentScript({matches:MANGACOPY_MATCHES,runAt:'document_idle',main(){
 const state=globalThis as typeof globalThis & {__nodeComics?:boolean};if(state.__nodeComics)return;state.__nodeComics=true;
 connectContentLocale();
 const navigationId=crypto.randomUUID();let revision=0;
 let discovering:ReturnType<typeof readMangaCopyData>|undefined;
 const loc=mangaCopyLocation(location.href);
 if(loc&&!loc.chapterId){
  const host=document.querySelector('.comicParticulars-title-right');
  if(host){const button=document.createElement('button');button.textContent=msg("NodeLane Comics · 导入／管理漫画");subscribeLocale(()=>{button.textContent=msg('NodeLane Comics · 导入／管理漫画');});button.type='button';button.style.cssText='background:#fb7299;color:#fff;border:0;border-radius:8px;padding:10px 16px;margin:12px 0;cursor:pointer;font-weight:600';button.onclick=()=>{button.disabled=true;void chrome.runtime.sendMessage({type:'NC_IMPORT_CURRENT'}).then(r=>{if(!r?.ok)button.textContent=r?.error??msg("请通过插件弹窗重试");}).finally(()=>button.disabled=false);};host.append(button);}
 }
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.type==='NC_NAVIGATION'){respond({navigationId,url:location.href});return;}
  if(message?.type==='NC_CATALOG_SNAPSHOT'){respond(discoverMangaCopyCatalog(document,location.href));return;}
  if(message?.type!=='NC_DISCOVER')return;
  discovering??=readMangaCopyData(document,location.href).finally(()=>{discovering=undefined;});
  void discovering.then(snapshot=>respond({...snapshot,navigationId,revision:++revision})).catch(error=>respond({error:error instanceof Error?error.message:msg("来源图片清单读取失败。")}));
  return true;
 });
}});
