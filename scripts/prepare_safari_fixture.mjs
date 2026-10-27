// Add diagnostics only to an already built, loopback-configured Safari test
// package. A normal build replaces the output and removes these test resources.
import {readFile, writeFile, readdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root = new URL('../apps/extension/.output/safari-mv3/', import.meta.url);
let configured = false;
for (const name of await readdir(new URL('chunks/', root))) {
  if (name.endsWith('.js') && (await readFile(new URL('chunks/' + name, root), 'utf8')).includes('http://127.0.0.1:4737')) configured = true;
}
if (!configured) throw Error('Build Safari with VITE_API_BASE=http://127.0.0.1:4737 before adding diagnostics.');
const entry=new URL('chunks/safari-transport-entry.ts',root);
await writeFile(entry,`export {fetchSourceImage} from '${fileURLToPath(new URL('../apps/extension/src/sources/runtime/image-fetch.ts',import.meta.url))}';`);
const {build}=createRequire(new URL('../apps/extension/package.json',import.meta.url))('vite');
try{await build({configFile:false,root:fileURLToPath(new URL('../apps/extension',import.meta.url)),logLevel:'error',build:{outDir:fileURLToPath(new URL('chunks/',root)),emptyOutDir:false,
  lib:{entry:fileURLToPath(entry),formats:['es'],fileName:()=> 'safari-transport.js'}}});}finally{await rm(entry);}
await writeFile(new URL('chunks/safari-probe.html', root), `<!doctype html><html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Safari API probe</title><style>body{font:16px system-ui;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{display:block;padding:12px}</style><h1>Safari API probe</h1><p>Loopback fixture only. No real account or model.</p><a href="../reader.html#account">Open reader / 打开阅读器</a><a href="http://localhost:4737/comic">Open source / 打开取图页</a><pre id="log"></pre><script src="./safari-probe.js"></script></html>`);
await writeFile(new URL('chunks/safari-probe.js', root), `
const api='http://127.0.0.1:4737',site='http://localhost:4737', output=document.querySelector('#log');
async function report(check,value){const result=typeof value==='string'?value:JSON.stringify(value);output.textContent+=check+': '+result+'\\n';try{await fetch(api+'/__probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({check,result})});}catch{output.textContent+='report unavailable\\n';}}
async function probe(check,run){try{await report(check,await run());}catch(e){await report(check,e.name+': '+e.message);}}
async function withRule(url,header,operation,value,read,scope=true){const id=700001;await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[id],addRules:[{id,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header,operation,...value?{value}:{}}]},condition:{urlFilter:'|'+url+'|',...scope?{initiatorDomains:[new URL(chrome.runtime.getURL('')).hostname.toLowerCase()]}:{},resourceTypes:['xmlhttprequest']}}]});try{return await read();}finally{await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[id]});}}
(async()=>{
 await report('runtime',{origin:chrome.runtime.getURL(''),identity:!!chrome.identity,webRequest:!!chrome.webRequest,webNavigation:!!chrome.webNavigation,locks:!!navigator.locks,dnr:!!chrome.declarativeNetRequest,tabs:!!chrome.tabs,scripting:!!chrome.scripting,storageAccess:typeof chrome.storage?.local?.setAccessLevel});
 await probe('permissions',()=>chrome.permissions.contains({origins:['http://*/*','https://*/*']}));
 await probe('file-share',()=>({available:typeof navigator.share==='function',formats:Object.fromEntries(['pdf','zip','cbz','epub','mobi','cbr','rar'].map(extension=>[extension,navigator.canShare?.({files:[new File(['synthetic'],'sample.'+extension,{type:'application/octet-stream'})]})??false]))}));
 const save=document.createElement('button');save.textContent='Save test file / 保存测试文件';save.style.cssText='padding:12px;margin:12px';output.before(save);
 save.onclick=()=>{void probe('file-share-save',()=>navigator.share({files:[new File(['Safari original export probe'],'safari-export-probe.txt',{type:'text/plain'})]}));};
 await probe('indexeddb-blob',async()=>{
  const name='nodelane-safari-isolated-blob-probe';
  const database=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('data');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{
   await new Promise((resolve,reject)=>{const tx=database.transaction('data','readwrite');tx.objectStore('data').put(new Blob(['synthetic'],{type:'text/plain'}),'sample');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
   const blob=await new Promise((resolve,reject)=>{const request=database.transaction('data').objectStore('data').get('sample');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   return {stored:await blob.text()==='synthetic'};
  }finally{database.close();indexedDB.deleteDatabase(name);}
 });
 await probe('token-origin',()=>withRule(api+'/probe-origin','Origin','remove',null,async()=>{const r=await fetch(api+'/probe-origin',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',body:'synthetic'});return r.json();}));
 await probe('source-referer',()=>withRule(api+'/source.png','Referer','set','http://localhost:4737/',async()=>{const r=await fetch(api+'/source.png',{referrerPolicy:'no-referrer'});const bytes=await r.arrayBuffer();return {status:r.status,bytes:bytes.byteLength};}));
 await probe('origin-without-initiator',()=>withRule(api+'/probe-origin','Origin','remove',null,async()=>{const r=await fetch(api+'/probe-origin',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',body:'synthetic'});return r.json();},false));
 await probe('source-direct-header',async()=>{const r=await fetch(api+'/source.png',{headers:{Referer:'http://localhost:4737/'}});return {status:r.status};});
 await probe('manual-redirect',async()=>{const r=await fetch(api+'/redirect.png',{redirect:'manual'});return {status:r.status,type:r.type,location:r.headers.has('location')};});
 await probe('native-token-transport',()=>chrome.runtime.sendNativeMessage('net.nodelane.comics.safari.NodeLaneSafari',{type:'oidc-token',endpoint:api+'/probe-origin',body:'grant_type=authorization_code'}));
 await probe('native-reject-http',()=>chrome.runtime.sendNativeMessage('net.nodelane.comics.safari.NodeLaneSafari',{type:'oidc-token',endpoint:'http://identity.example/token',body:'grant_type=authorization_code'}));
 await probe('native-reject-redirect',()=>chrome.runtime.sendNativeMessage('net.nodelane.comics.safari.NodeLaneSafari',{type:'oidc-token',endpoint:api+'/probe-token-redirect',body:'grant_type=authorization_code'}));
 await probe('native-bound-response',()=>chrome.runtime.sendNativeMessage('net.nodelane.comics.safari.NodeLaneSafari',{type:'oidc-token',endpoint:api+'/probe-large-response',body:'grant_type=authorization_code'}));
 const {fetchSourceImage}=await import('./safari-transport.js');
 const nativeImage=async(path,signal)=>{const {blob}=await fetchSourceImage(api+path,signal,undefined,{pageUrl:site+'/comic',safariTransport:'public-native'});return {bytes:blob.size,type:blob.type};};
 await probe('native-image-referer',()=>nativeImage('/source.png'));
 await probe('native-image-redirect',()=>nativeImage('/redirect.png'));
 await probe('native-image-cookie-first',()=>nativeImage('/native-cookie.png'));
 await probe('native-image-cookie-second',()=>nativeImage('/native-cookie.png'));
 await probe('native-image-challenge',()=>nativeImage('/native-challenge.png'));
 await probe('native-image-size-cap',()=>nativeImage('/native-large.png'));
 await probe('native-image-stream-cap',()=>nativeImage('/native-stream-large.png'));
 await probe('native-image-cancel',()=>nativeImage('/native-slow.png',AbortSignal.timeout(250)));
 await report('probe-complete',true);
})();
`);
const popup = new URL('popup.html', root);
let html = await readFile(popup, 'utf8');
if (!html.includes('safari-probe.html')) html = html.replace('<body>', '<body><a href="./chunks/safari-probe.html" target="_blank" style="display:block;padding:12px;text-align:center">Safari API probe (local test)</a>');
await writeFile(popup, html);
console.log('Added local diagnostics to ' + fileURLToPath(root));
