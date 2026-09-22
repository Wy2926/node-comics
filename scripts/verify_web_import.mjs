/** Isolated MV3 browser acceptance. Uses fixture source pages and original/synthetic images,
 * a copied extension with fixture-origin permission, and a fresh profile. No account/provider requests.
 * Run npm run build in apps/extension first. Set PLAYWRIGHT_MODULE and TEST_CHROMIUM as needed.
 */
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.join(root,'artifacts/web-import');await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'profile-')),extension=await mkdtemp(path.join(output,'extension-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const config=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
for(const domain of ['copy4000.com','mangacopy.com']){
 assert(config.host_permissions.includes(`https://*.${domain}/*`));
 assert(config.content_scripts.some(script=>script.matches.includes(`https://*.${domain}/comic/*`)));
}
// Opening popup.html in a tab does not confer the toolbar action's activeTab grant.
config.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(config));
const context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chromium'}),args:['--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:1000}});
const errors=[],checks=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
const origin='http://127.0.0.1:18088',original=await readFile(path.join(root,'samples/starlight-bookshop.png'));
// Minimal PNG fixture encoder keeps image dimensions real, without adding a package dependency.
function png(width,height){
 const crc=buffer=>{let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const name=Buffer.from(type),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const rows=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(width*3+1)+1+x*3;rows[at]=190;rows[at+1]=215;rows[at+2]=240;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const icon=png(64,64),banner=png(2000,400),small=png(320,400);let failImage=false;
const genericHtml=`<!doctype html><meta charset="utf-8"><title>原创漫画 · 来源样本</title><h1>网页采集验收</h1><img src="${origin}/fixtures/1.png"><img src="${origin}/fixtures/icon.png"><img data-src="${origin}/fixtures/unused.png" src="${origin}/fixtures/2.png" width="400" height="500"><img src="${origin}/fixtures/3.png"><img src="${origin}/fixtures/banner.png">`;
await context.route(origin+'/**',route=>{
 const url=new URL(route.request().url());
 if(url.pathname==='/fixtures/page')return route.fulfill({contentType:'text/html; charset=utf-8',body:genericHtml});
 if(url.pathname.startsWith('/fixtures/')&&url.pathname.endsWith('.png'))return route.fulfill({status:failImage&&url.pathname.endsWith('failed.png')?503:200,contentType:'image/png',body:url.pathname.endsWith('icon.png')?icon:url.pathname.endsWith('banner.png')?banner:url.pathname.endsWith('2.png')?small:original});
 return route.fulfill({status:503,body:'Isolated acceptance: backend unavailable'});
});
const uuid='724f819b-5306-11ea-b7ea-024352452ce0';
const fullCatalogHtml=await readFile(path.join(root,'apps/extension/src/sources/sites/mangacopy/tests/catalog.html'),'utf8');
await context.route(/https:\/\/(www\.)?(copy4000|mangacopy)\.com\/comic\//,route=>{
 if(new URL(route.request().url()).pathname.startsWith('/comic/broken/chapter/'))return route.fulfill({contentType:'text/html',body:'<title>Broken source</title><script>var cct="0123456789abcdef";var contentKey="abcdefghijklmnopprivate-invalid-data";</script>'});
 if(new URL(route.request().url()).pathname==='/comic/laizishenyuan')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h6>Catalog fixture</h6>'+fullCatalogHtml});
 const chapter=route.request().url().includes('/chapter/');
 return route.fulfill({contentType:'text/html; charset=utf-8',body:chapter?`<title>漫画阅读</title><span class="comicCount">2</span><ul class="comicContent-list"><li><img data-src="${origin}/fixtures/1.png"></li><li><img data-src="${origin}/fixtures/2.png"></li></ul>`:`<title>镜像作品</title><div class="comicParticulars-title-right"><h6>镜像作品</h6></div><div class="upLoop"><h4>默认</h4><div class="table-default"><div class="tab-pane" id="default全部"><a href="/comic/sample/chapter/${uuid}">第 1 话</a></div></div></div>`});
});
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 const extensionUrl=new URL('reader.html',worker.url()).href,popupUrl=new URL('popup.html',worker.url()).href;
 const source=await context.newPage();await source.goto(origin+'/fixtures/page');
 async function popup(){
  await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});await chrome.tabs.update(tab.id,{active:true});},source.url());
  const created=context.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),popupUrl);const page=await created;
  await page.waitForURL(popupUrl);await page.setViewportSize({width:420,height:600});
  await page.getByRole('button',{name:'发现网页图片'}).waitFor();assert.equal(await page.locator('.nc-image-choice').count(),0);await page.getByRole('button',{name:'发现网页图片'}).click();await page.waitForFunction(()=>!!document.querySelector('.nc-popup-results')&&!document.querySelector('.nc-popup-discover').disabled);await page.bringToFront();return page;
 }
 async function openImport(page){const created=context.waitForEvent('page');await page.getByRole('button',{name:/^加入漫画/}).click();const reader=await created;await reader.getByRole('dialog').waitFor();return reader;}
 async function data(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-library');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['copies','library'],'readonly'),copies=tx.objectStore('copies').getAll(),library=tx.objectStore('library').get('library');tx.oncomplete=()=>{resolve({copies:copies.result,library:library.result});db.close();};};}));}
 async function setSourceImages(names){await source.evaluate(({origin,names})=>{document.querySelectorAll('img').forEach(img=>img.remove());for(const name of names){const img=document.createElement('img');img.src=origin+'/fixtures/'+name+'.png';img.width=800;img.height=1200;document.body.append(img);}}, {origin,names});await source.waitForFunction(()=>[...document.images].every(img=>img.complete));}
 let p=await popup();assert.equal(await p.locator('.nc-image-choice').count(),3);assert.equal(await p.locator('.is-selected').count(),3);
 assert(await p.locator('.nc-image-choice').evaluateAll(cards=>cards.every(card=>card.querySelector('.nc-image-caption').getBoundingClientRect().bottom<=card.getBoundingClientRect().bottom)),'Image dimensions and reorder controls must fit inside every card');
 await p.locator('.nc-popup-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await p.locator('.nc-popup').screenshot({path:path.join(output,'popup-light.png')});
 assert(await p.evaluate(()=>document.documentElement.scrollWidth<=420&&document.querySelector('.nc-popup').getBoundingClientRect().height<=600));
 const orderedIds=await p.locator('.is-selected').evaluateAll(cards=>cards.map(card=>card.dataset.imageId));await p.locator('.is-selected img').first().dragTo(p.locator('.is-selected img').nth(1));assert.deepEqual(await p.locator('.is-selected').evaluateAll(cards=>cards.map(card=>card.dataset.imageId)),[orderedIds[1],orderedIds[0],orderedIds[2]]);await p.getByRole('button',{name:'恢复网页顺序',exact:true}).click();
 await p.getByLabel('选择网页图片 1',{exact:true}).uncheck();await p.getByRole('button',{name:'上移网页图片 3',exact:true}).click();
 const beforeRemount=await p.locator('.nc-image-choice').evaluateAll(cards=>cards.map(card=>card.dataset.imageId));
 await source.evaluate(()=>document.querySelectorAll('img').forEach(img=>img.replaceWith(img.cloneNode(true))));
 await source.waitForFunction(()=>[...document.images].every(img=>img.complete));
 await p.getByRole('button',{name:'刷新网页图片'}).click();await p.waitForFunction(()=>!document.querySelector('.nc-popup-discover').disabled);
 assert.deepEqual(await p.locator('.nc-image-choice').evaluateAll(cards=>cards.map(card=>card.dataset.imageId)),beforeRemount);
 assert.equal(await p.getByLabel('选择网页图片 1',{exact:true}).isChecked(),false);
 checks.push('DOM remount preserves deselection, slot identity and manually chosen order');
 assert.equal(await p.getByText('显示已过滤图片',{exact:false}).count(),0);assert.equal(await p.locator('.nc-image-choice').count(),3);
 await source.evaluate(origin=>{const img=document.createElement('img');img.src=origin+'/fixtures/4.png';document.body.append(img);},origin);await source.waitForFunction(()=>document.images[5].complete);
 await p.getByRole('button',{name:'刷新网页图片'}).click();await p.waitForFunction(()=>!document.querySelector('.nc-popup-discover').disabled);
 assert.deepEqual(await p.locator('.is-selected img').evaluateAll(images=>images.map(img=>new URL(img.src).pathname.split('/').at(-1))),['3.png','2.png','4.png']);
 await p.close();p=await popup();assert.deepEqual(await p.locator('.is-selected img').evaluateAll(images=>images.map(img=>new URL(img.src).pathname.split('/').at(-1))),['3.png','2.png','4.png']);
 checks.push('Manual discovery using inline candidate rules, no secondary filtering, selection/order and refresh/reopen persistence');
 let reader=await openImport(p);await reader.getByLabel('作品名称',{exact:true}).fill('网页漫画验收');await selectOption(reader.getByLabel('内容归属',{exact:true}),'chapter');await reader.getByLabel('副本／新条目名称',{exact:true}).fill('第 1 话');
 await reader.getByRole('dialog').screenshot({path:path.join(output,'assign-new.png')});await reader.getByRole('button',{name:'获取原图并加入漫画',exact:true}).click();await reader.getByLabel('跳转页码').waitFor();
 let state=await data(reader);assert.equal(state.library.works.length,1);assert.equal(state.library.chapters.length,1);assert.deepEqual(state.copies[0].pages.map(page=>page.sourceUrl.split('/').at(-1)),['3.png','2.png','4.png']);assert(state.copies[0].pages.every(page=>page.blobKey));
 const workId=state.library.works[0].id,copyId=state.copies[0].id,originalPageIds=state.copies[0].pages.map(page=>page.id);
 await reader.getByLabel('跳转页码').fill('2');await reader.getByLabel('跳转页码').press('Enter');await reader.getByLabel('跳转页码').blur();await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
 await setSourceImages(['5']);p=await popup();let insert=await openImport(p);await insert.getByRole('button',{name:'插入已有副本',exact:true}).click();await selectOption(insert.getByLabel('目标作品',{exact:true}),workId);await selectOption(insert.getByLabel('目标副本',{exact:true}),copyId);await selectOption(insert.getByLabel('插入位置',{exact:true}),'after');await selectOption(insert.getByLabel('接在哪一页后',{exact:true}),originalPageIds[0]);
 await insert.getByRole('dialog').screenshot({path:path.join(output,'insert-desktop.png')});
 await insert.getByRole('button',{name:'插入图片并继续阅读',exact:true}).click();await insert.getByLabel('跳转页码').waitFor();assert.equal(await insert.getByLabel('跳转页码').inputValue(),'3');
 state=await data(insert);assert.equal(state.library.works.length,1);assert.equal(state.copies.length,1);assert.equal(state.copies[0].pages.length,4);assert.equal(state.copies[0].pageId,originalPageIds[1]);assert.deepEqual(state.copies[0].pages.filter(page=>originalPageIds.includes(page.id)).map(page=>page.id),originalPageIds);
 await insert.getByRole('button',{name:'返回我的漫画',exact:true}).click();await insert.reload();await insert.getByRole('dialog').waitFor();await insert.getByRole('button',{name:'插入已有副本',exact:true}).click();await selectOption(insert.getByLabel('目标作品',{exact:true}),workId);await selectOption(insert.getByLabel('插入位置',{exact:true}),'after');await selectOption(insert.getByLabel('接在哪一页后',{exact:true}),originalPageIds[0]);await insert.getByRole('button',{name:'插入图片并继续阅读',exact:true}).click();await insert.getByLabel('跳转页码').waitFor();state=await data(insert);assert.equal(state.copies[0].pages.length,4);assert.equal(await insert.getByLabel('跳转页码').inputValue(),'3');
 checks.push('New chapter import; insertion inside an existing copy; page IDs, work count, position and duplicate retry preserved');
 await setSourceImages(['6']);p=await popup();const chapter=await openImport(p);await selectOption(chapter.getByLabel('归入作品',{exact:true}),workId);await selectOption(chapter.getByLabel('内容归属',{exact:true}),'publication');await chapter.getByLabel('副本／新条目名称',{exact:true}).fill('第 1 卷');await chapter.getByRole('button',{name:'获取原图并加入漫画',exact:true}).click();await chapter.getByLabel('跳转页码').waitFor();state=await data(chapter);assert.equal(state.library.works.length,1);assert.equal(state.library.publications.length,1);assert.equal(state.copies.length,2);checks.push('New volume assigned to the same work');
 await setSourceImages(['failed']);p=await popup();failImage=true;const failed=await openImport(p);await selectOption(failed.getByLabel('归入作品',{exact:true}),workId);await failed.getByRole('button',{name:'获取原图并加入漫画',exact:true}).click();await failed.getByLabel('跳转页码').waitFor();state=await data(failed);assert(state.copies.some(copy=>copy.pages.some(page=>page.fetchError?.includes('503'))));await failed.screenshot({path:path.join(output,'failed-image.png')});failImage=false;await failed.reload();await failed.getByRole('button',{name:'获取原图并加入漫画',exact:true}).click();await failed.getByLabel('跳转页码').waitFor();state=await data(failed);assert(state.copies.every(copy=>copy.pages.every(page=>page.blobKey)));checks.push('Per-image HTTP failure saved with actionable reason and restored by retry without another work/copy');
 await worker.evaluate(async url=>{const tab=await chrome.tabs.create({url,active:false});return tab.id;},extensionUrl);const settingsPage=context.pages().find(page=>page.url()===extensionUrl)??reader;
 await settingsPage.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings')||'{}'),appearance:'dark',accentTheme:'rose'})));
 p=await popup();await p.locator('.nc-popup-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await p.locator('.nc-popup').screenshot({path:path.join(output,'popup-dark.png')});assert.equal(await p.evaluate(()=>document.documentElement.dataset.appearance),'dark');assert.equal(await p.evaluate(()=>document.documentElement.dataset.accent),'rose');await p.close();checks.push('Popup uses the existing appearance and accent settings');
 for(const domain of ['copy4000.com','www.copy4000.com','mangacopy.com','www.mangacopy.com']){
  const page=await context.newPage();await page.goto(`https://${domain}/comic/sample`);await page.getByRole('button',{name:'NodeLane Comics · 导入／管理漫画',exact:true}).waitFor();
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,page.url());
  if(domain==='copy4000.com'){
   const identity=()=>worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'NC_NAVIGATION'},{frameId:0}),tabId);
   const before=await identity();
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
   assert.equal(await page.getByRole('button',{name:'NodeLane Comics · 导入／管理漫画',exact:true}).count(),0);
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
   await page.getByRole('button',{name:'NodeLane Comics · 导入／管理漫画',exact:true}).waitFor();
   assert.notEqual((await identity()).navigationId,before.navigationId);
   await page.evaluate(()=>document.querySelector('.comicParticulars-title-right').replaceWith(document.querySelector('.comicParticulars-title-right').cloneNode(true)));
   await page.getByRole('button',{name:'NodeLane Comics · 导入／管理漫画',exact:true}).waitFor();
   await page.screenshot({path:path.join(output,'source-restored.png')});
   checks.push('Simulated BFCache lifecycle recreates the import button and navigation identity; a remounted anchor is restored');
   const observation=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:async()=>{
    const footer=document.createElement('footer');document.body.append(footer);
    let count=0;const release=document.__nodeComicsSource.subscribe({changed(){count++;},invalidated(){}});
    await new Promise(resolve=>setTimeout(resolve,30));count=0;
    footer.style.color='red';await new Promise(resolve=>setTimeout(resolve,30));const unrelated=count;
    document.querySelector('.comicParticulars-title-right').classList.add('fixture-visible');
    await new Promise(resolve=>setTimeout(resolve,30));const relevant=count;
    release();footer.remove();return {unrelated,relevant};
   }}),tabId);
   assert.deepEqual(observation[0].result,{unrelated:0,relevant:1});
   checks.push('Unrelated footer styling does not trigger discovery while declared container changes do');
  }
  const catalog=await settingsPage.evaluate(async tabId=>chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId}),tabId);assert(catalog.ok,catalog.error);assert.equal(catalog.data.catalog.id,'mangacopy:sample');assert.equal(new URL(catalog.data.catalog.url).hostname,domain);
  await page.goto(`https://${domain}/comic/sample/chapter/${uuid}`);const result=await settingsPage.evaluate(async tabId=>chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId}),tabId);assert(result.ok);assert.equal(result.data.manifest.adapter,'mangacopy');assert.equal(result.data.manifest.items.length,2);await page.close();
 }
 const fullSource=await context.newPage();await fullSource.goto('https://www.mangacopy.com/comic/laizishenyuan');
 const broken=await context.newPage();await broken.goto('https://www.mangacopy.com/comic/broken/chapter/'+uuid);
 const brokenId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,broken.url());
 const diagnostic=await settingsPage.evaluate(tabId=>chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId}),brokenId);
 assert.equal(diagnostic.ok,false);assert.equal(diagnostic.code,'SOURCE_DATA_FORMAT');assert(diagnostic.error.includes('数据格式已变化'));assert(!diagnostic.error.includes('private-invalid-data'));await broken.close();
 checks.push('Adapter diagnostics survive content and background messages without including source data');
 const fullId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,fullSource.url());
 const fullCatalog=await settingsPage.evaluate(tabId=>chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId}),fullId);assert(fullCatalog.ok,fullCatalog.error);assert(fullCatalog.data.catalog.complete);assert.equal(fullCatalog.data.catalog.entries.length,100);assert.equal(fullCatalog.data.catalog.groups[0].entryIds.length,82);assert(fullCatalog.data.catalog.entries.some(entry=>entry.suggestedKind==='publication'));assert(!('workId' in fullCatalog.data.catalog));await fullSource.close();checks.push('Full stored catalog fixture validates groups, ownership and normalized kind suggestions');
 checks.push('Production install permissions and automatic content scripts on all four root/www mirror hosts, shared catalog identity and chapter logic (fixture DOM)');
 const catalog={id:'mangacopy:redirect_sample',sourceId:'mangacopy',url:'https://www.mangacopy.com/comic/redirect_sample',title:'镜像跳转样本',entries:[{id:'redirect-entry',catalogId:'mangacopy:redirect_sample',remoteId:uuid,title:'Chapter',order:0,groupIds:[],rawTypes:[],related:false,url:`https://www.mangacopy.com/comic/redirect_sample/chapter/${uuid}`}],groups:[],complete:true,observedAt:Date.now(),note:'',excludedEntryIds:[]};
 const send=message=>settingsPage.evaluate(message=>chrome.runtime.sendMessage(message),message);
 assert((await send({type:'NC_REGISTER_CATALOG',catalog})).ok);const createdManaged=context.waitForEvent('page');const managed=await send({type:'NC_OPEN_SOURCE',catalogId:catalog.id,entryId:'redirect-entry'});assert(managed.ok);
 // Navigate after debugger attachment to reproduce a mirror switch with the fixture DOM.
 const managedPage=await createdManaged;await managedPage.goto(catalog.entries[0].url.replace('www.mangacopy.com','www.copy4000.com'));
 let redirected;for(let i=0;i<30;i++){redirected=await send({type:'NC_POLL_SOURCE',tabId:managed.data.tabId});assert(redirected.ok,redirected.error);if(redirected.data)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(new URL(redirected.data.url).hostname,'www.copy4000.com');assert.equal(redirected.data.items.length,2);assert((await send({type:'NC_CLOSE_SOURCE',tabId:managed.data.tabId})).ok);checks.push('Managed acquisition continues after a same-chapter mirror navigation');
 p=await popup();await setSourceImages([]);await p.getByRole('button',{name:'刷新网页图片'}).click();await p.getByText('暂未发现图片。滚动原网页让图片加载，再刷新发现。',{exact:true}).waitFor();
 assert(await p.getByRole('button',{name:'加入漫画 · 0 张',exact:true}).isDisabled());
 await p.locator('.nc-popup-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await p.screenshot({path:path.join(output,'popup-empty.png')});
 await setSourceImages(['1']);await p.getByRole('button',{name:'刷新网页图片'}).click();await p.getByRole('button',{name:'加入漫画 · 1 张',exact:false}).waitFor();assert.equal(await p.locator('.nc-image-choice').count(),1);await p.close();
 checks.push('Empty discovery disables import; refreshing loaded images restores selection');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'results.json'),JSON.stringify({checkedAt:new Date().toISOString(),browser:context.browser()?.version(),checks,errors,fixtureOnly:true},null,2));console.log('Passed '+checks.length+' browser scenarios. Evidence: '+output);
}catch(error){await writeFile(path.join(output,'failure.txt'),String(error.stack));for(const [index,page] of context.pages().entries())await page.screenshot({path:path.join(output,`failure-${index}.png`)}).catch(()=>{});throw error;}
finally{await context.close();}
