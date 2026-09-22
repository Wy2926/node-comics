import {connectContentLocale} from '../src/i18n/content';
import {msg} from '../src/i18n/runtime';
import {defineContentScript} from 'wxt/utils/define-content-script';
import {discoverMangaCopyCatalog,mangaCopyLocation,MANGACOPY_MATCHES} from '../src/sources/mangacopy';
import {readSourceDocument,sourcePageImages} from '../src/sources/adapters';
import {PageImageRegistry} from '../src/sources/page-images';
import {mountSourceImportButton} from '../src/sources/import-button';
export default defineContentScript({matches:MANGACOPY_MATCHES,runAt:'document_idle',main(){
 const state=globalThis as typeof globalThis & {__nodeComics?:boolean};if(state.__nodeComics)return;state.__nodeComics=true;
 connectContentLocale();
 const navigationId=crypto.randomUUID();let revision=0;
 let discovering:ReturnType<typeof readSourceDocument>|undefined;
 const pageImages=new PageImageRegistry();
 const loc=mangaCopyLocation(location.href);
 if(loc&&!loc.chapterId){
  const host=document.querySelector('.comicParticulars-title-right');
  if(host)mountSourceImportButton(host);
 }
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.type==='NC_NAVIGATION'){respond({navigationId,url:location.href});return;}
  if(message?.type==='NC_CATALOG_SNAPSHOT'){respond(discoverMangaCopyCatalog(document,location.href));return;}
  if(message?.type==='NC_PAGE_IMAGE'&&message.navigationId===navigationId&&message.url===location.href){
   void pageImages.read(message.imageUrl,location.href,message.pageId,()=>message.url===location.href?sourcePageImages(document,location.href):[]).then(data=>respond({data})).catch(error=>respond({error:error.message}));return true;
  }
  if(message?.type!=='NC_DISCOVER')return;
  discovering??=readSourceDocument(document,location.href).then(snapshot=>pageImages.register(snapshot,sourcePageImages(document,snapshot.url))).finally(()=>{discovering=undefined;});
  void discovering.then(snapshot=>respond({...snapshot,navigationId,revision:++revision})).catch(error=>respond({error:error instanceof Error?error.message:msg("来源图片清单读取失败。")}));
  return true;
 });
}});
