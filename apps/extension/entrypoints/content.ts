import { defineContentScript } from 'wxt/utils/define-content-script';
import { discoverDocument } from '../src/sources/adapters';
// Manual scripting injection uses the user's per-site permission. Listing broad
// matches here would make WXT promote them to required host_permissions.
export default defineContentScript({registration:'runtime',main(){
  const state=globalThis as typeof globalThis & {__nodeComics?:boolean};if(state.__nodeComics)return;state.__nodeComics=true;
  const navigationId=crypto.randomUUID();let revision=0;
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(sender.id!==chrome.runtime.id)return;if(message?.type==='NC_NAVIGATION'){respond({navigationId,url:location.href});return;}if(message?.type!=='NC_DISCOVER')return;respond({...discoverDocument(document,location.href),navigationId,revision:++revision});});
}});
