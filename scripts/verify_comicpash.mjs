/** Built MV3 + isolated profile. Synthetic by default; RUN_LIVE_COMICPASH=1 reads the public page.
 * No account, provider or paid translation requests. Browser permissions are pregranted in a temporary copy.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve('artifacts/comicpash-validation');await mkdir(output,{recursive:true});
const live=process.env.RUN_LIVE_COMICPASH==='1',run=await mkdtemp(path.join(output,live?'live-':'fixture-'));
const extension=path.join(run,'extension');await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('https://comicpash.jp/*');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const context=await chromium.launchPersistentContext(path.join(run,'profile'),{channel:'chromium',headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const source=await context.newPage(),url='https://comicpash.jp/episodes/60cfe4785e2af',checks=[];
const html=`<!doctype html><meta charset="utf-8"><title>Canvas comic fixture</title><style>body{margin:0;background:#eee}#xCVPages{display:flex;flex-direction:row-reverse;width:1800px}.-cv-page{width:600px;height:800px;flex:none}canvas{width:600px;height:800px}</style><div id="comici-viewer" data-comici-viewer-id="fixture"><div id="xCVPages"><div class="-cv-page mode-empty"><canvas width="600" height="800"></canvas></div><div class="-cv-page mode-rendered"><div class="-cv-page-canvas"><canvas width="600" height="800"></canvas></div></div><div class="-cv-page"><div class="-cv-page-canvas"><i></i></div></div></div></div><canvas id="ad" width="600" height="800"></canvas><script>for(const canvas of document.querySelectorAll('canvas')){const ctx=canvas.getContext('2d');ctx.fillStyle='#eef5ff';ctx.fillRect(0,0,600,800);ctx.fillStyle='#203050';ctx.font='40px sans-serif';ctx.fillText('Original canvas',50,150);}</script>`;
if(!live)await context.route('https://comicpash.jp/**',route=>route.fulfill({contentType:'text/html',body:html}));
// Keep extension UI checks local; no production account or API.
await context.route('https://*.nodelane.net/**',route=>route.fulfill({status:503,body:'Isolated acceptance'}));
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 await source.goto(url);await source.locator('#comici-viewer .mode-rendered canvas').first().waitFor({timeout:45000});
 const sourceId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,url);
 const ui=await context.newPage();await ui.goto(new URL('popup.html',worker.url()).href);
 const send=message=>ui.evaluate(message=>chrome.runtime.sendMessage(message),message);
 const first=await send({type:'NC_DISCOVER_TAB',tabId:sourceId});assert(first.ok,first.error);
 const snapshot=first.data.manifest;assert.equal(snapshot.adapter,'comicpash');assert(snapshot.items.length>0);assert(snapshot.items.every(item=>item.kind==='page'&&item.preview?.startsWith('data:image/png;')));
 assert(snapshot.knownTotal>=snapshot.items.length);assert.equal(snapshot.discoveryComplete,false);
 if(!live){assert.equal(snapshot.items.length,1);assert.equal(snapshot.knownTotal,2);assert.equal(snapshot.items[0].order,0);}
 checks.push('Canvas discovery excludes ads, preserves page slots and reports completeness');
 const selected=await send({type:'NC_SELECT_MANIFEST',manifestId:snapshot.id,itemIds:[snapshot.items[0].id]});assert(selected.ok);
 const original=await send({type:'NC_SOURCE_IMAGE',manifestId:selected.data.id,pageId:snapshot.items[0].id});assert(original.ok,original.error);
 const dimensions=await ui.evaluate(async data=>{const b=await createImageBitmap(await(await fetch(data)).blob());const dimensions=[b.width,b.height];b.close();return dimensions;},original.data.data);
 assert.deepEqual(dimensions,[snapshot.items[0].width,snapshot.items[0].height]);checks.push('Registered page handle yields a decodable PNG at the rendered dimensions');
 const forged=await send({type:'NC_SOURCE_IMAGE',manifestId:snapshot.id,pageId:'unregistered'});assert(!forged.ok);checks.push('Unregistered image request is rejected');
 const reader=await context.newPage();await reader.goto(new URL('reader.html?manifest='+selected.data.id,worker.url()).href);
 await reader.getByRole('button',{name:'获取原图并加入漫画',exact:true}).click();await reader.getByLabel('跳转页码').waitFor();
 const copies=await reader.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-library');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('copies'),all=tx.objectStore('copies').getAll();tx.oncomplete=()=>{resolve(all.result);db.close();};};}));
 assert.equal(copies.length,1);assert.equal(copies[0].pages.length,1);assert(copies[0].pages[0].blobKey);assert(!copies[0].pages[0].fetchError);assert(!copies[0].pages[0].sourceUrl);checks.push('Canvas imports into the real reader with local original bytes and no unusable remote URL');
 await reader.screenshot({path:path.join(run,'reader.png')});
 await source.screenshot({path:path.join(run,'source.png')});
 if(!live){
  await source.evaluate(()=>{const page=document.querySelector('#xCVPages > .-cv-page:last-child');page.classList.add('mode-rendered');const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;canvas.getContext('2d').fillRect(0,0,600,800);page.querySelector('.-cv-page-canvas').replaceChildren(canvas);});
  const refresh=await send({type:'NC_DISCOVER_TAB',tabId:sourceId});assert(refresh.ok);assert.equal(refresh.data.manifest.items.length,2);assert.equal(refresh.data.manifest.discoveryComplete,false);checks.push('Later canvas rendering is found on refresh');
  await source.evaluate(()=>{const page=document.querySelector('#comici-viewer .mode-rendered');page.classList.remove('mode-rendered');page.querySelector('canvas').getContext('2d').fillRect(0,0,100,100);page.classList.add('mode-rendered');});
  assert(!(await send({type:'NC_SOURCE_IMAGE',manifestId:snapshot.id,pageId:snapshot.items[0].id})).ok);checks.push('Re-rendering the same canvas revokes its previous version');
  const fresh=await send({type:'NC_DISCOVER_TAB',tabId:sourceId});assert(fresh.ok,fresh.error);
  await source.evaluate(()=>history.pushState({},'',location.pathname+'?chapter=next'));
  const navigated=await send({type:'NC_DISCOVER_TAB',tabId:sourceId});assert(navigated.ok,navigated.error);assert.notEqual(navigated.data.manifest.navigationId,fresh.data.manifest.navigationId);
  assert(!(await send({type:'NC_SOURCE_IMAGE',manifestId:fresh.data.id,pageId:fresh.data.manifest.items[0].id})).ok);
  await source.evaluate(url=>history.replaceState({},'',url),url);
  assert(!(await send({type:'NC_SOURCE_IMAGE',manifestId:fresh.data.id,pageId:fresh.data.manifest.items[0].id})).ok);checks.push('SPA navigation and return to the same URL reject old navigation handles');
  await source.evaluate(()=>document.querySelector('#comici-viewer .mode-rendered canvas').remove());
  const expired=await send({type:'NC_SOURCE_IMAGE',manifestId:snapshot.id,pageId:snapshot.items[0].id});assert(!expired.ok);checks.push('Detached canvas fails with an actionable error');
 }
 await writeFile(path.join(run,'results.json'),JSON.stringify({live,checks,loadedPages:snapshot.items.length,knownTotal:snapshot.knownTotal,dimensions,liveProvider:false,nativePermissionDialog:false},null,2));
 console.log(JSON.stringify({run,live,checks,loadedPages:snapshot.items.length,knownTotal:snapshot.knownTotal,dimensions}));
}finally{await context.close();}
