// Real MV3 UI/IndexedDB acceptance with synthetic directories and a local image server.
// No live source or user profile is accessed. Build apps/extension before running.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),out=path.join(root,'artifacts/book-downloads');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
function png(){
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const name=Buffer.from(type),value=Buffer.alloc(data.length+12);value.writeUInt32BE(data.length);name.copy(value,4);data.copy(value,8);value.writeUInt32BE(crc(Buffer.concat([name,data])),data.length+8);return value;};
  const header=Buffer.alloc(13);header.writeUInt32BE(800);header.writeUInt32BE(1200,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(2401*1200);for(let y=0;y<1200;y++)for(let x=0;x<800;x++){const i=y*2401+1+x*3,inside=x>40&&x<760&&y%380>30&&y%380<345;rows[i]=inside?60+y%90:240;rows[i+1]=inside?120+x%70:245;rows[i+2]=inside?195:250;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const original=png(),requests=[],errors=[],checks=[];let delay=0,fail=true,offline=false,reader;
const server=createServer((request,response)=>{
  requests.push(request.url);const bad=offline||fail&&request.url==='/4/2.png';
  setTimeout(()=>{response.writeHead(bad?503:200,{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'});response.end(bad?'Fixture unavailable':original);},delay);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const imageOrigin='http://127.0.0.1:'+server.address().port;
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,locale:'zh-CN',viewport:{width:1440,height:1000},
  args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(15000);context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),url=new URL('reader.html',worker.url()).href;
async function open(){const page=await context.newPage();await page.goto(url);await page.locator('.nc-library').waitFor();return page;}
async function state(){return worker.evaluate(async()=>{
  const read=(name,tables)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(tables),values=Object.fromEntries(tables.map(table=>[table,tx.objectStore(table).getAll()]));tx.oncomplete=()=>{resolve(Object.fromEntries(Object.entries(values).map(([table,request])=>[table,request.result])));db.close();};tx.onerror=()=>reject(tx.error);};});
  const catalog=await read('node-comics-reading-v2-catalog',['metadata','tasks','entries','positions','comics']);
  const exists=(await indexedDB.databases()).some(db=>db.name==='node-comics-reading-v2-downloads');
  const saved=exists?await read('node-comics-reading-v2-downloads',['metadata']):{metadata:[]};
  return {...catalog,plan:catalog.metadata.find(item=>item.id==='book-download:fixture-book'),saved:saved.metadata};
});}
async function waitState(predicate,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('State timeout: '+JSON.stringify(await state()));}
async function rendered(page=reader){await page.waitForFunction(()=>[...document.querySelectorAll('img.nc-page-image')].some(image=>image.complete&&image.naturalWidth===800));}
async function snapshot(name){await reader.screenshot({path:path.join(out,name+'.png')});}
const button=name=>reader.getByRole('button',{name,exact:true});
const shelf=()=>reader.locator('article.nc-book[data-comic-id="fixture-book"]');
const cachedBook=()=>reader.locator('article.nc-download-book[data-comic-id="fixture-book"]');
const readCachedBook=()=>cachedBook().getByRole('button',{name:'打开漫画 星光书店 · 多语言离线',exact:true}).click();
const moreCachedBook=()=>cachedBook().getByRole('button',{name:'更多操作 · 星光书店 · 多语言离线',exact:true});
async function bookMenu({rightClick=false}={}){
  if(rightClick)await cachedBook().click({button:'right'});else await moreCachedBook().click();
  const menu=reader.getByRole('menu',{name:'星光书店 · 多语言离线',exact:true});await menu.waitFor();return menu;
}
async function bookAction(name){const menu=await bookMenu();await menu.getByRole('menuitem',{name,exact:true}).click();}
async function compactCard(){
  for(const name of ['缓存语言','取消缓存','打开来源','清除离线内容'])assert.equal(await cachedBook().getByRole('button',{name,exact:true}).count(),0,name+' must only be available from the context menu');
  assert.equal(await cachedBook().getByRole('link',{name:'打开来源',exact:true}).count(),0);
  const status=cachedBook().locator('.nc-download-status'),size=cachedBook().locator('.nc-download-size');
  assert.match(await size.innerText(),/离线占用/);assert.match(await size.innerText(),/MB/);
  assert.equal(await cachedBook().locator('.nc-download-meta .nc-download-size').count(),0);
  const shape=await status.evaluate(element=>{const style=getComputedStyle(element);return {background:style.backgroundColor,radius:parseFloat(style.borderRadius),padding:parseFloat(style.paddingLeft)};});
  assert(shape.radius>0&&shape.padding>0&&shape.background!=='rgba(0, 0, 0, 0)','Task state must be styled as a tag');
  const bounds=await cachedBook().evaluate(card=>{const box=selector=>{const r=card.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};return {size:box('.nc-download-size'),meta:box('.nc-download-meta'),progress:box('.nc-download-progress')};});
  assert(bounds.size.top>=bounds.meta.bottom-2,'Retained size belongs below the metadata');
  assert(bounds.size.left>=bounds.progress.right-2,'Retained size belongs beside the lower progress area');
}
async function languageChooser(){
  const chooser=reader.getByRole('dialog',{name:'缓存语言',exact:true});await chooser.waitFor();
  assert.equal(await chooser.evaluate(element=>element.matches(':popover-open')),true);
  assert.equal(await reader.locator('dialog:modal').count(),0,'Language selection must not be a modal');
  await chooser.getByRole('checkbox',{name:/English/}).waitFor();
  assert.equal(await chooser.locator('.nc-flag-icon').count(),3);
  assert.match(await chooser.innerText(),/English/);assert.match(await chooser.innerText(),/日本語/);
  for(const name of [/中文/,/English/,/日本語/])assert.match(await chooser.getByRole('checkbox',{name}).locator('..').innerText(),/[34]/);
  return chooser;
}
async function library(){
  if(await reader.locator('.nc-reader').count())await reader.getByRole('button',{name:/^返回(我的漫画|离线中心)$/}).click();
  await reader.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的漫画',exact:true}).click();
  await reader.locator('.nc-library').waitFor();
}
async function center(){await button('离线缓存').click();await reader.locator('.nc-download-center').waitFor();assert.match(reader.url(),/#downloads$/);assert.equal(await reader.getByRole('dialog').count(),0);}
async function directory(){
  await button('打开目录').click();const contents=reader.getByRole('complementary',{name:'漫画目录'});await contents.getByRole('searchbox').fill('第');return contents;
}
const marker=(contents,id)=>contents.locator('[data-release-choice][data-entry-id="'+id+'"] [data-cache-status="complete"]');
async function cachedMarkersBesideLanguage(contents){
  const violations=await contents.locator('.nc-chapter-entry').evaluateAll(rows=>rows.flatMap(row=>{
    const markers=[...row.querySelectorAll('[data-cache-status="complete"]')];
    if(markers.length>1)return [row.dataset.entryId+': duplicate cache markers'];
    if(!markers.length)return [];
    const marker=markers[0],release=row.hasAttribute('data-release-choice');
    const language=row.querySelector(release?'.nc-release-heading>b':'.nc-chapter-language');
    if(!language)return [];
    const stateBox=marker.getBoundingClientRect(),languageBox=language.getBoundingClientRect(),tags=row.querySelector('.nc-release-tags')?.getBoundingClientRect(),pages=row.querySelector('.nc-release-pages')?.getBoundingClientRect();
    if(stateBox.left<languageBox.right-1||stateBox.top>=languageBox.bottom||stateBox.bottom<=languageBox.top)return [row.dataset.entryId+': cache marker must be beside the language'];
    if(tags&&stateBox.bottom>tags.top+1)return [row.dataset.entryId+': cache marker must appear above the release group'];
    if(pages&&(stateBox.right>pages.left+1||pages.right>row.getBoundingClientRect().right+1))return [row.dataset.entryId+': page count must remain separate and inside the row'];
    return [];
  }));
  assert.deepEqual(violations,[]);
}
async function noShelfCache(){assert.equal(await shelf().locator('.nc-cache-badge,[data-cache-status],progress').count(),0);assert.doesNotMatch(await shelf().innerText(),/缓存中|已暂停|已缓存|已保留|缓存进度|完整缓存/);}

try{
  await worker.evaluate(()=>chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN'}}));
  reader=await open();await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single',appearance:'light'})));
  await reader.evaluate(async({imageOrigin})=>{
    const now=Date.now(),uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
    const comic={id:'fixture-book',title:'星光书店 · 多语言离线',sourceKey:'fixture-book',cover:{entryId:'entry:0',contentId:'content:0',pageId:'entry:0:p0'},sourceName:'MangaDex',sourceUrl:'https://mangadex.org/title/'+uuid(900),startEntryId:'entry:0',
      source:{connectionId:'website:mangadex',providerItemId:uuid(900),locator:{catalogId:'fixture-catalog'},generation:1,status:'active'},createdAt:now,updatedAt:now,catalogSync:{nextCheckAt:now+86400000}};
    const entries=Array.from({length:10},(_,n)=>({id:'entry:'+n,comicId:comic.id,title:'第 '+(n===9?1:Math.floor(n/3)+1)+' 话',order:n===9?0:Math.floor(n/3),sourceOrder:n,
      sourceEntryId:uuid(n),sourceUrl:'https://mangadex.org/chapter/'+uuid(n),format:'website',contentId:'content:'+n,generation:1,indexState:'ready',
      sequenceId:'main',readingSlotId:'slot:'+(n===9?0:Math.floor(n/3)),contentLanguage:n===9?'en':['zh-Hans','en','ja'][n%3],
      discoveryComplete:true,pageCount:3,knownTotal:3,createdAt:now,updatedAt:now}));
    const pages=entries.flatMap((entry,n)=>Array.from({length:3},(_,ordinal)=>({contentId:entry.contentId,pageId:entry.id+':p'+ordinal,ordinal,name:'Page '+(ordinal+1),formatLocator:String(ordinal),
      width:800,height:1200,locator:{url:imageOrigin+'/'+n+'/'+(ordinal+1)+'.png',manifestId:'manifest:'+n,sourceId:'page:'+ordinal}})));
    const groups=[{id:'main',title:'正文',complete:true,entryIds:[...entries.slice(0,6),entries[9]].map(e=>e.sourceEntryId)},{id:'extras',title:'番外',complete:true,entryIds:[]},
      {id:'special',title:'特别篇',parentId:'extras',complete:true,entryIds:entries.slice(3,9).map(e=>e.sourceEntryId)}];
    const catalog={id:'fixture-catalog',comicId:comic.id,sourceId:'mangadex',url:comic.sourceUrl,title:comic.title,complete:true,note:'',observedAt:now,groups,
      entries:entries.map(entry=>({id:entry.sourceEntryId,catalogId:'fixture-catalog',remoteId:entry.sourceEntryId,url:entry.sourceUrl,title:entry.title,order:entry.order,
        groupIds:groups.filter(group=>group.entryIds.includes(entry.sourceEntryId)).map(group=>group.id),rawTypes:[entry.id==='entry:9'?'Second release group':'Starlight group'],
        related:false,contentLanguage:entry.contentLanguage,sequenceId:entry.sequenceId,readingSlotId:entry.readingSlotId}))};
    const single={...comic,id:'single-book',title:'静谧小镇 · 单语言',sourceKey:'single-book',cover:undefined,startEntryId:'single:0',sourceUrl:'https://mangadex.org/title/'+uuid(901),
      source:{...comic.source,providerItemId:uuid(901),locator:{catalogId:'single-catalog'}}};
    const singleEntry={...entries[0],id:'single:0',comicId:single.id,sourceEntryId:uuid(1000),sourceUrl:'https://mangadex.org/chapter/'+uuid(1000),contentId:'single-content',contentLanguage:'zh-Hans'};
    const singleCatalog={...catalog,id:'single-catalog',comicId:single.id,title:single.title,url:single.sourceUrl,
      groups:[{id:'main',title:'正文',complete:true,entryIds:[singleEntry.sourceEntryId]}],entries:[{...catalog.entries[0],id:singleEntry.sourceEntryId,catalogId:'single-catalog',remoteId:singleEntry.sourceEntryId,url:singleEntry.sourceUrl,groupIds:['main']} ]};
    await chrome.storage.local.set(Object.fromEntries(entries.map((entry,n)=>['manifest:manifest:'+n,{id:'manifest:'+n,revision:1,adapter:'mangadex',url:entry.sourceUrl,title:entry.title,direction:'ltr',discoveryComplete:true,knownTotal:3,note:'',
      items:pages.filter(page=>page.contentId===entry.contentId).map(page=>({id:page.locator.sourceId,url:page.locator.url,order:page.ordinal,width:800,height:1200}))}])));
    await new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-reading-v2-catalog');r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction(['connections','comics','entries','pageDescriptors','catalogs'],'readwrite');
      tx.objectStore('connections').put({id:'website:mangadex',provider:'website',displayName:'MangaDex',status:'connected',generation:1,createdAt:now,updatedAt:now});
      tx.objectStore('comics').put(comic);tx.objectStore('comics').put(single);tx.objectStore('entries').put(singleEntry);tx.objectStore('catalogs').put(singleCatalog);for(const entry of entries)tx.objectStore('entries').put(entry);for(const page of pages)tx.objectStore('pageDescriptors').put(page);tx.objectStore('catalogs').put(catalog);
      tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
    };});
  },{imageOrigin});
  await reader.reload();await shelf().waitFor();
  await center();await reader.getByRole('heading',{name:'离线中心',exact:true}).waitFor();assert.equal(await reader.locator('.nc-download-book').count(),0);
  await library();await button('打开漫画 静谧小镇 · 单语言').click({button:'right'});
  assert.equal(await reader.getByRole('menuitem',{name:'缓存语言',exact:true}).count(),0);await reader.keyboard.press('Escape');
  await button('打开漫画 星光书店 · 多语言离线').click({button:'right'});await reader.getByRole('menuitem',{name:'缓存语言',exact:true}).click();
  const chooser=await languageChooser();await chooser.getByRole('checkbox',{name:/日本語/}).uncheck();
  assert(await chooser.getByRole('checkbox',{name:/English/}).isChecked());assert.equal(await chooser.getByRole('checkbox',{checked:true}).count(),2);
  await snapshot('languages-light');await chooser.getByRole('button',{name:'保存选择',exact:true}).click();await chooser.waitFor({state:'hidden'});
  const languagePreference=(await state()).metadata.find(value=>value.id==='download-languages:fixture-book');
  await button('打开漫画 星光书店 · 多语言离线').click({button:'right'});await reader.getByRole('menuitem',{name:'缓存语言',exact:true}).click();
  const dismissed=await languageChooser();await dismissed.getByRole('checkbox',{name:/English/}).uncheck();await reader.keyboard.press('Escape');await dismissed.waitFor({state:'hidden'});
  assert.deepEqual((await state()).metadata.find(value=>value.id==='download-languages:fixture-book'),languagePreference);
  checks.push('右上角进入整页空离线中心；单语言漫画隐藏缓存语言，多语言默认全选并独立保存中英文选择');
  await shelf().getByRole('button',{name:'开始阅读',exact:true}).click();await rendered();
  const jump=reader.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('2');await jump.press('Enter');await rendered();
  assert.equal((await state()).tasks.length,0,'Automatic reading must not register downloads');
  assert.equal(await button('离线缓存').count(),0);assert.equal(await button('缓存整本').count(),0);
  await button('阅读设置').click();assert.equal(await button('下载原图').count(),0);await button('关闭面板').click();
  let contents=await directory();assert.equal(await contents.locator('[data-cache-status]').count(),0);assert.equal(await contents.getByRole('button',{name:/^(缓存整本|离线缓存|当前全部目录已缓存|所选语言已缓存)$/}).count(),0);
  await contents.getByRole('searchbox').fill('第 1');await button('关闭面板').click();await library();
  delay=500;await button('打开漫画 星光书店 · 多语言离线').click({button:'right'});await reader.getByRole('menuitem',{name:'缓存整本',exact:true}).click();
  await waitState(s=>s.plan?.status==='running');await reader.waitForFunction(()=>document.querySelector('[data-downloads-trigger]')?.textContent.trim()==='1');await noShelfCache();await snapshot('shelf-caching-no-badge');
  await center();await compactCard();
  const activeMenu=await bookMenu({rightClick:true});await activeMenu.getByRole('menuitem',{name:'取消缓存',exact:true}).waitFor();
  await activeMenu.getByRole('menuitem',{name:'缓存语言',exact:true}).waitFor();await activeMenu.getByRole('menuitem',{name:'打开来源',exact:true}).waitFor();
  await snapshot('task-context-menu');await activeMenu.getByRole('menuitem',{name:'缓存语言',exact:true}).click();
  const menuLanguages=await languageChooser();await snapshot('task-language-popover');await reader.keyboard.press('Escape');await menuLanguages.waitFor({state:'hidden'});
  assert.equal(await moreCachedBook().evaluate(element=>element===document.activeElement),true);
  await cachedBook().getByRole('button',{name:'暂停缓存',exact:true}).click();
  const paused=await waitState(s=>s.plan.status==='paused');assert.equal(paused.plan.entryIds.length,7);assert.equal(new Set(paused.plan.entryIds).size,7);assert(paused.plan.entryIds.includes('entry:9'));
  assert.equal(await reader.locator('.nc-download-book').count(),1);assert.equal(await cachedBook().locator('.nc-download-chapter,.nc-download-directory,.nc-download-group').count(),0);
  await reader.waitForFunction(()=>document.querySelector('[data-downloads-trigger]')?.textContent.trim()==='');
  await readCachedBook();await rendered();assert.equal(await jump.inputValue(),'2');
  await button('返回离线中心').click();await snapshot('paused-progress-light');
  checks.push('书架卡片不显示缓存状态；右上角仅统计缓存中的书本；任务状态为标签，离线占用移至右下方，次要操作收进右键及更多菜单；暂停和阅读返回保持第2页');
  const other=await open();await other.getByRole('button',{name:'离线缓存',exact:true}).click();await other.locator('.nc-download-center').waitFor();
  await Promise.all([cachedBook().getByRole('button',{name:'继续缓存',exact:true}).click(),other.getByRole('button',{name:'继续缓存',exact:true}).click()]);
  await waitState(s=>s.plan.status==='running');await reader.close();reader=other;
  const interrupted=await waitState(s=>s.plan.status==='paused'&&s.plan.reason==='interrupted');const before=interrupted.saved.length;
  await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await state()).saved.length,before);assert.equal((await state()).tasks.length,7);
  await snapshot('interrupted');checks.push('多标签页并发继续仅一个任务；执行页关闭后全部暂停，等待明确继续');
  delay=0;await cachedBook().getByRole('button',{name:'继续缓存',exact:true}).click();await waitState(s=>s.plan.status==='partial');await cachedBook().getByText('部分已缓存',{exact:true}).waitFor();
  assert.equal((await state()).saved.length,20);assert.equal(await cachedBook().getByRole('progressbar').getAttribute('value'),'6');
  assert.equal(await cachedBook().getByRole('button',{name:'继续阅读',exact:true}).count(),0);
  assert.equal(await cachedBook().locator('.nc-download-flags .nc-flag-icon').count(),2);
  assert(await cachedBook().locator('.nc-download-flags .nc-flag-icon').first().evaluate(element=>element.getBoundingClientRect().width>=28));
  assert.match(await cachedBook().locator('.nc-download-source').innerText(),/MangaDex/);assert(await cachedBook().locator('.nc-download-source img,.nc-download-source svg').count()>0);assert.match(await cachedBook().innerText(),/MB/);
  await cachedBook().locator('.nc-download-cover img').waitFor();await reader.waitForFunction(()=>document.querySelector('.nc-download-cover img')?.naturalWidth>0);await snapshot('partial-failure');
  await readCachedBook();await rendered();contents=await directory();
  await marker(contents,'entry:0').waitFor();assert.equal(await marker(contents,'entry:4').count(),0);assert.equal(await marker(contents,'entry:2').count(),0);await cachedMarkersBesideLanguage(contents);
  assert.equal(await contents.getByRole('button',{name:/^(缓存整本|离线缓存|当前全部目录已缓存|所选语言已缓存)$/}).count(),0);await snapshot('directory-partial-cache');
  await button('关闭面板').click();await button('返回离线中心').click();
  checks.push('单页模拟失败保留其余20页，漫画行显示缩略图、语言、大小及6/7进度；目录仅完整缓存的语言版本显示已缓存');
  fail=false;const priorRequests=requests.length;await cachedBook().getByRole('button',{name:'重试未完成',exact:true}).click();
  await waitState(s=>s.plan.status==='complete');assert.equal(requests.length-priorRequests,1);assert.equal((await state()).saved.length,21);
  await cachedBook().locator('.nc-download-status[data-state="complete"]').waitFor();await compactCard();await reader.waitForFunction(()=>!document.querySelector('[data-downloads-trigger]')?.textContent.trim());await snapshot('complete-light');
  await readCachedBook();await rendered();contents=await directory();await marker(contents,'entry:4').waitFor();assert.equal(await marker(contents,'entry:2').count(),0);await cachedMarkersBesideLanguage(contents);await snapshot('directory-complete-cache');
  await button('关闭面板').click();await button('返回离线中心').click();checks.push('重试仅请求缺少的一页；目录主条目与展开选项在语言右侧、译组上方显示单个已缓存标记，未选日文仍无标记');
  await reader.evaluate(async()=>{const settings={uiLanguage:'zh-CN',layout:'single',appearance:'dark',textScale:1.25,accentTheme:'amber'};localStorage.setItem('nc-settings',JSON.stringify(settings));await chrome.storage.local.set({'nc-reader-settings':settings});});
  await reader.reload();await cachedBook().waitFor();await reader.waitForFunction(()=>document.querySelector('.nc-download-cover img')?.naturalWidth>0);await snapshot('complete-dark-large');
  assert.equal(await reader.evaluate(()=>document.documentElement.dataset.appearance),'dark');
  assert.equal(await reader.evaluate(()=>document.documentElement.style.getPropertyValue('--text-scale')),'1.25');
  assert(await reader.evaluate(()=>document.querySelector('.nc-download-center').scrollWidth<=document.querySelector('.nc-download-center').clientWidth+1));
  await reader.setViewportSize({width:980,height:900});assert(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await snapshot('complete-dark-narrow');
  await readCachedBook();await rendered();contents=await directory();await marker(contents,'entry:4').waitFor();await cachedMarkersBesideLanguage(contents);await snapshot('directory-dark-large');
  await button('关闭面板').click();await button('返回离线中心').click();await reader.setViewportSize({width:1440,height:1000});
  const editLanguages=()=>bookAction('缓存语言');
  await editLanguages();const escaped=await languageChooser();await escaped.getByRole('checkbox',{name:/中文/}).uncheck();
  await reader.keyboard.press('Escape');await escaped.waitFor({state:'hidden'});await reader.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='更多操作 · 星光书店 · 多语言离线');
  assert.equal(await moreCachedBook().evaluate(element=>element===document.activeElement),true);assert.deepEqual((await state()).metadata.find(value=>value.id==='download-languages:fixture-book'),languagePreference);
  await editLanguages();const outside=await languageChooser();await outside.getByRole('checkbox',{name:/中文/}).uncheck();
  await button('离线缓存').click();await outside.waitFor({state:'hidden'});assert.equal(await button('离线缓存').evaluate(element=>element===document.activeElement),true);
  assert.deepEqual((await state()).metadata.find(value=>value.id==='download-languages:fixture-book'),languagePreference);
  checks.push('语言选择为有旗帜和话数的非模态气泡；Escape还原入口焦点，外部点击保留目标焦点，未保存选择均丢弃');
  await editLanguages();const edit=await languageChooser();await edit.getByRole('checkbox',{name:/中文/}).uncheck();
  await edit.getByRole('button',{name:'应用并补缓存',exact:true}).click();await edit.waitFor({state:'hidden'});
  await waitState(s=>s.plan.status==='complete'&&s.plan.languages?.length===1&&s.plan.languages[0]==='en');assert.equal((await state()).saved.length,21);
  await readCachedBook();await rendered();contents=await directory();await marker(contents,'entry:0').waitFor();
  await button('关闭面板').click();await button('返回离线中心').click();
  checks.push('缩小缓存语言范围后仍保留中文原图，阅读目录继续显示其已缓存状态');
  await library();await noShelfCache();
  // Clear only ordinary image bytes, then re-open a saved chapter with the source offline.
  await reader.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-reading-v2-source-pages');r.onsuccess=()=>{const db=r.result,tx=db.transaction(['metadata','objects','state','reservations'],'readwrite');for(const name of ['metadata','objects','state','reservations'])tx.objectStore(name).clear();tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};r.onerror=()=>reject(r.error);}));
  offline=true;await context.setOffline(true);const requestsBeforeOffline=requests.length;await reader.close();reader=await open();
  await center();await readCachedBook();await rendered();contents=await directory();
  await contents.locator('[data-release-choice][data-entry-id="entry:7"]').click();
  await reader.waitForFunction(()=>document.querySelector('[data-page-id="entry:7:p0"] img.nc-page-image')?.naturalWidth===800);
  const offlineJump=reader.getByRole('spinbutton',{name:'跳转页码'});await offlineJump.fill('2');await offlineJump.press('Enter');
  await reader.waitForFunction(()=>document.querySelector('[data-page-id="entry:7:p1"] img.nc-page-image')?.naturalWidth===800);
  assert.equal(requests.length,requestsBeforeOffline);await snapshot('offline-reading');
  checks.push('暗色大字号整页及980px宽桌面无横向溢出；清空普通缓存并断网、重开插件后，通过阅读器目录读取另一已缓存章节');
  await button('返回离线中心').click();await waitState(s=>s.positions.some(value=>value.entryId==='entry:7'&&value.pageId==='entry:7:p1'));const position=(await state()).positions.find(value=>value.entryId==='entry:7');
  await bookAction('清除离线内容');
  const clearDialog=reader.getByRole('dialog',{name:'清除离线内容',exact:true});await clearDialog.waitFor();assert.equal(await clearDialog.evaluate(element=>element.matches(':modal')),true);
  await clearDialog.getByRole('button',{name:'清除离线内容',exact:true}).click();await waitState(s=>!s.plan&&s.tasks.length===0&&s.saved.length===0);await cachedBook().waitFor({state:'hidden'});
  const cleared=await state();assert.equal(cleared.comics.length,2);assert.deepEqual(cleared.positions.find(value=>value.entryId==='entry:7'),position);await snapshot('cleared');
  checks.push('复用对话框确认清理，移除漫画离线计划、子任务和原图，保留两本漫画与阅读位置');
  await context.setOffline(false);offline=false;delay=800;await library();
  await button('打开漫画 星光书店 · 多语言离线').click({button:'right'});await reader.getByRole('menuitem',{name:'缓存整本',exact:true}).click();
  await waitState(s=>s.plan?.status==='running'&&s.saved.length>0);await center();await cachedBook().getByRole('button',{name:'暂停缓存',exact:true}).click();
  await waitState(s=>s.plan?.status==='paused');assert((await state()).saved.length>0);assert.equal(await cachedBook().count(),1);assert.equal(await cachedBook().getByRole('button',{name:'停止缓存',exact:true}).count(),0);
  await bookAction('取消缓存');const cancelDialog=reader.getByRole('dialog',{name:'取消缓存',exact:true});await cancelDialog.waitFor();
  assert.equal(await cancelDialog.evaluate(element=>element.matches(':modal')),true);await snapshot('cancel-confirm');await cancelDialog.getByRole('button',{name:'取消',exact:true}).click();
  assert((await state()).saved.length>0);assert.equal((await state()).plan.status,'paused');
  await bookAction('取消缓存');await cancelDialog.getByRole('button',{name:'取消缓存',exact:true}).click();
  await waitState(s=>!s.plan&&s.tasks.length===0&&s.saved.length===0);await cachedBook().waitFor({state:'hidden'});
  await reader.reload();await reader.locator('.nc-download-center').waitFor();await new Promise(resolve=>setTimeout(resolve,1500));
  const canceled=await state();assert.equal(canceled.plan,undefined);assert.equal(canceled.tasks.length,0);assert.equal(canceled.saved.length,0);assert.equal(await reader.locator('.nc-download-book').count(),0);assert.equal(canceled.comics.length,2);assert.deepEqual(canceled.positions.find(value=>value.entryId==='entry:7'),position);
  delay=0;await library();await button('打开漫画 星光书店 · 多语言离线').click({button:'right'});await reader.getByRole('menuitem',{name:'缓存整本',exact:true}).click();
  await waitState(s=>s.plan?.status==='complete'&&s.saved.length>0);await center();await cachedBook().locator('.nc-download-status[data-state="complete"]').waitFor();
  checks.push('暂停保留任务和原图；取消确认可撤回，确认后删除计划/任务/原图；重开插件无已停止记录或任务复活，可重新缓存');
  await library();await button('外观与设置').click();assert.equal(await reader.getByText('离线原图',{exact:true}).count(),0);checks.push('设置页移除离线原图管理行');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,requests,browser:context.browser()?.version(),liveSites:false},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){if(reader&&!reader.isClosed()){await snapshot('failure');await writeFile(path.join(out,'failure.txt'),await reader.locator('body').innerText());}await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors,state:await state().catch(String),requests},null,2));throw error;}
finally{await context.close();await new Promise(resolve=>server.close(resolve));}
