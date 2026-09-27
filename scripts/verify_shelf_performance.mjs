// Isolated production MV3 benchmark: synthetic books, directories, positions and cached covers.
// Build the extension first. SHELF_PERF_LABEL=before records a baseline; after asserts bounded reads.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),label=process.env.SHELF_PERF_LABEL||'after';
const baseline=label.endsWith('before');
const count=Number(process.env.SHELF_PERF_BOOKS||60),chapters=Number(process.env.SHELF_PERF_CHAPTERS||200);
const output=path.join(root,'artifacts/shelf-performance');await mkdir(output,{recursive:true});
const out=await mkdtemp(path.join(output,label+'-')),extension=path.join(out,'extension');
await cp(process.env.SHELF_PERF_EXTENSION||path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,
 executablePath:process.env.TEST_CHROMIUM,
 viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce',
 args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(30000);
const errors=[],checks=[],requests=[],rounds=[],scrollChecks=[],thumbnailChecks=[];let page;
context.on('page',value=>value.on('pageerror',error=>errors.push(error.message)));
await context.route(/https?:\/\//,route=>{requests.push(route.request().url());return route.abort();});
await context.addInitScript(()=>{
 if(location.protocol!=='chrome-extension:')return;
 localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light',language:'en',layout:'single',fit:'window'}));
 const fresh=()=>({start:performance.now(),last:performance.now(),pending:0,continues:0,entries:0,catalogs:0,thumbnailReads:0,thumbnailBlobReads:0,objectURLsCreated:0,objectURLsRevoked:0,reads:{},entryComics:{},longTasks:[]});
 window.__shelfPerf=fresh();window.__resetShelfPerf=()=>{window.__shelfPerf=fresh();};
 const sourceInfo=source=>{const store=source instanceof IDBIndex?source.objectStore:source;return {store:store.name,index:source instanceof IDBIndex?source.name:undefined,database:store.transaction.db.name};};
 for(const prototype of [IDBObjectStore.prototype,IDBIndex.prototype])for(const method of ['get','getAll','openCursor']){
  const original=prototype[method];prototype[method]=function(...args){
   const stats=window.__shelfPerf,{store,index,database}=sourceInfo(this),key=store+'.'+method+(index?'.'+index:'');
   if(database==='node-comics-reading-v2-thumbnails'){stats.thumbnailReads++;if(store==='objects')stats.thumbnailBlobReads++;}
   stats.reads[key]=(stats.reads[key]||0)+1;stats.pending++;stats.last=performance.now();
   const request=original.apply(this,args);let finished=false,watchingTransaction=false;
   const done=()=>{if(!finished){finished=true;stats.pending--;stats.last=performance.now();}};
   request.addEventListener('error',done);
   request.addEventListener('success',()=>{
    stats.last=performance.now();const value=request.result;
    const rows=method==='openCursor'?(value?[value.value]:[]):Array.isArray(value)?value:value===undefined?[]:[value];
    if(store==='entries'){stats.entries+=rows.length;for(const row of rows)stats.entryComics[row.comicId]=(stats.entryComics[row.comicId]||0)+1;}
    if(store==='catalogs')stats.catalogs+=rows.length;
    // The app may stop at a cursor limit without asking for its terminal null result.
    if(method!=='openCursor'||!value)done();
    else if(!watchingTransaction){watchingTransaction=true;const transaction=value.source instanceof IDBIndex?value.source.objectStore.transaction:value.source.transaction;transaction.addEventListener('complete',done,{once:true});transaction.addEventListener('abort',done,{once:true});}
   });return request;
  };
 }
 const next=IDBCursor.prototype.continue;
 IDBCursor.prototype.continue=function(...args){window.__shelfPerf.continues++;return next.apply(this,args);};
 for(const [method,key]of [['createObjectURL','objectURLsCreated'],['revokeObjectURL','objectURLsRevoked']]){const original=URL[method];URL[method]=function(...args){window.__shelfPerf[key]++;return original.apply(this,args);};}
 window.__visibleShelfCovers=()=>[...document.querySelectorAll('.nc-library .nc-book-cover')].filter(node=>{const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;}).map(node=>({id:node.closest('[data-comic-id]').dataset.comicId,image:node.querySelector('img')}));
 new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__shelfPerf.longTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
});
const snapshot=()=>page.evaluate(()=>{const value=window.__shelfPerf;return {...value,elapsed:performance.now()-value.start,workMs:value.last-value.start,uniqueEntryComics:Object.keys(value.entryComics).length,renderedCards:document.querySelectorAll('.nc-book').length};});
const settle=()=>page.waitForFunction(()=>window.__shelfPerf.pending===0&&performance.now()-window.__shelfPerf.last>200,null,{timeout:60000});
const waitForCovers=()=>page.waitForFunction(()=>{const covers=window.__visibleShelfCovers();return covers.length>0&&covers.every(({image})=>image?.complete&&image.naturalWidth>0);});
const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true});
// Sticky navigation is already visible; locator.click may scroll the document before the click.
const clickNav=async name=>{const box=await nav(name).boundingBox();assert(box&&box.y>=0&&box.y+box.height<=page.viewportSize().height);await page.mouse.click(box.x+box.width/2,box.y+box.height/2);};
const measure=async(name,action)=>{
 await page.evaluate(()=>window.__resetShelfPerf());await action();await page.locator('.nc-book').first().waitFor();
 const firstPaintMs=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.__shelfPerf.start)))));
 await settle();const result={name,firstPaintMs,...await snapshot()};rounds.push(result);
 console.log(JSON.stringify({name,firstPaintMs:Math.round(firstPaintMs),workMs:Math.round(result.workMs),entries:result.entries,entryComics:result.uniqueEntryComics,cursorContinues:result.continues,cards:result.renderedCards}));
 return result;
};
try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');page=await context.newPage();
 await page.goto(new URL('reader.html',worker.url()).href);await page.locator('.nc-library').waitFor();await settle();
 await page.evaluate(async({count,chapters})=>{
  const now=Date.now(),open=name=>new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const db=await open('node-comics-reading-v2-catalog');
  const comics=Array.from({length:count},(_,n)=>({id:'perf-book-'+n,title:'性能夹具 '+String(n).padStart(3,'0')+(n===0?' · 多语言':n===1?' · 单语言':''),
   sourceKey:'perf-book-'+n,sourceName:'MangaDex',sourceUrl:'https://mangadex.org/title/fixture-'+n,
   source:{connectionId:'website:mangadex',providerItemId:'perf-catalog-'+n,locator:{catalogId:'perf-catalog-'+n},generation:1,status:'active'},
   sourceCover:{url:'https://uploads.mangadex.org/covers/fixture-'+n+'.png'},startEntryId:'perf-entry-'+n+'-0',
   createdAt:now-n*1000,updatedAt:now-n*1000,catalogSync:{nextCheckAt:now+86400000},
   ...(n%3!==2?{lastReadAt:now-n*1000,lastEntryId:'perf-entry-'+n+'-50',lastPage:5,lastPageCount:20}:{}),
  }));
  await new Promise((resolve,reject)=>{
   const tx=db.transaction(['connections','comics','entries','catalogs','positions'],'readwrite');
   tx.objectStore('connections').put({id:'website:mangadex',provider:'website',displayName:'MangaDex',status:'connected',generation:1,createdAt:now,updatedAt:now});
   for(const [n,comic]of comics.entries()){
    tx.objectStore('comics').put(comic);
    const entries=Array.from({length:chapters},(_,i)=>({id:'perf-entry-'+n+'-'+i,comicId:comic.id,title:'第 '+(i+1)+' 话',order:i,sourceOrder:i,
     sourceEntryId:'fixture-'+n+'-'+i,sourceUrl:'https://mangadex.org/chapter/fixture-'+n+'-'+i,format:'website',contentId:'perf-content-'+n+'-'+i,
     generation:1,indexState:'pending',sequenceId:'main',readingSlotId:'slot-'+(n===1?i:Math.floor(i/2)),contentLanguage:n===1?'zh-Hans':i%2?'en':'zh-Hans',
     discoveryComplete:false,knownTotal:20,createdAt:now,updatedAt:now,...(i<50?{readAt:now-10000}:{}),}));
    for(const entry of entries)tx.objectStore('entries').put(entry);
    tx.objectStore('catalogs').put({id:'perf-catalog-'+n,comicId:comic.id,sourceId:'mangadex',url:comic.sourceUrl,title:comic.title,cover:comic.sourceCover,
     complete:true,observedAt:now,groups:[{id:'main',title:'正文',complete:true,entryIds:entries.map(entry=>entry.sourceEntryId)}],
     entries:entries.map(entry=>({id:entry.sourceEntryId,catalogId:'perf-catalog-'+n,remoteId:entry.sourceEntryId,url:entry.sourceUrl,title:entry.title,order:entry.order,
      groupIds:['main'],rawTypes:[],related:false,contentLanguage:entry.contentLanguage,sequenceId:entry.sequenceId,readingSlotId:entry.readingSlotId}))});
    if(comic.lastEntryId)tx.objectStore('positions').put({id:comic.lastEntryId,comicId:comic.id,entryId:comic.lastEntryId,contentId:'perf-content-'+n+'-50',pageId:'p4',relativeOffset:0,updatedAt:comic.lastReadAt});
   }
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });db.close();
  const thumb=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-reading-v2-thumbnails',1);request.onupgradeneeded=()=>{
   const metadata=request.result.createObjectStore('metadata',{keyPath:'key'});for(const name of ['usedAt','owner','connectionId','contentId'])metadata.createIndex(name,name);
   request.result.createObjectStore('objects');request.result.createObjectStore('state',{keyPath:'id'});const reservations=request.result.createObjectStore('reservations',{keyPath:'id'});for(const name of ['expiresAt','key'])reservations.createIndex(name,name);
  };request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const canvas=new OffscreenCanvas(240,360),ctx=canvas.getContext('2d');ctx.fillStyle='#527ba8';ctx.fillRect(0,0,240,360);ctx.fillStyle='#ffffff';ctx.font='22px sans-serif';ctx.fillText('SHELF FIXTURE',26,180);
  const blob=await canvas.convertToBlob({type:'image/png'});
  await new Promise((resolve,reject)=>{const tx=thumb.transaction(['metadata','objects','state'],'readwrite');for(const comic of comics){const key='source-cover:'+JSON.stringify([comic.id,comic.sourceCover.url]);tx.objectStore('metadata').put({key,size:blob.size,usedAt:now,owner:'source-cover:'+comic.id,connectionId:'website:mangadex'});tx.objectStore('objects').put(blob,key);}tx.objectStore('state').put({id:'usage',bytes:blob.size*comics.length,reservedBytes:0,count:comics.length,epoch:0});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});thumb.close();
 },{count,chapters});
 await measure('initial',()=>page.reload());
 if(!baseline)assert.equal(await page.evaluate(()=>document.documentElement.style.overflowAnchor),'none','Active shelf owns manual document scroll restoration');
 for(let n=1;n<=3;n++){
  await clickNav('漫画网站');await page.locator('.nc-library').waitFor({state:'hidden'});await settle();
  if(!baseline)assert.equal(await page.evaluate(()=>document.documentElement.style.overflowAnchor),'','Leaving the shelf restores the previous document anchoring policy');
  await measure('return-'+n,()=>clickNav('我的漫画'));
  if(!baseline)assert.equal(await page.evaluate(()=>document.documentElement.style.overflowAnchor),'none');
 }
 for(const result of rounds){assert(result.renderedCards>0&&result.renderedCards<=Math.min(count,30),'Shelf must render a bounded card window');if(!baseline){
  assert(result.uniqueEntryComics<=result.renderedCards,'Opening the shelf must only read chapter progress for the rendered card window');
  assert(result.entries<=result.renderedCards*chapters,'Opening the shelf must not duplicate or scan offscreen chapter directories');
 }}
 checks.push('初次载入及三次切回记录 IDB 数据量、cursor 调用、首屏和后台读取时间；卡片保持虚拟窗口');
 // Visit every cover once, then compare actual image nodes and Blob URLs across warm navigation.
 const visited=new Set();
 for(let top=0;;top+=600){
  const maximum=await page.evaluate(top=>{window.scrollTo(0,top);return Math.max(0,document.documentElement.scrollHeight-innerHeight);},top);
  await settle();await waitForCovers();
  for(const id of await page.evaluate(()=>window.__visibleShelfCovers().map(({id})=>id)))visited.add(id);
  if(top>=maximum)break;
 }
 assert.equal(visited.size,count,'Every fixture cover was visited and decoded before the warm-navigation comparison');
 await page.evaluate(()=>window.scrollTo(0,0));await settle();await waitForCovers();
 for(let n=1;n<=3;n++){
  const before=await page.evaluate(()=>{window.__savedShelfImages=new Map(window.__visibleShelfCovers().map(({id,image})=>[id,{image,src:image.src}]));window.__resetShelfPerf();return [...window.__savedShelfImages].map(([id,{src}])=>({id,src}));});
  await clickNav('漫画网站');await page.locator('.nc-library').waitFor({state:'hidden'});await settle();
  await clickNav('我的漫画');await page.locator('.nc-library').waitFor();
  const firstReturnFrame=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.__visibleShelfCovers().map(({id,image})=>({id,decoded:!!image?.complete&&image.naturalWidth>0,sameNode:image===window.__savedShelfImages.get(id)?.image,sameURL:image?.src===window.__savedShelfImages.get(id)?.src})))))));
  await settle();await waitForCovers();
  const after=await page.evaluate(()=>window.__visibleShelfCovers().map(({id,image})=>({id,src:image.src,sameNode:image===window.__savedShelfImages.get(id)?.image,sameURL:image.src===window.__savedShelfImages.get(id)?.src})));
  const stats=await snapshot(),result={round:n,visited:visited.size,before,firstReturnFrame,after,thumbnailReads:stats.thumbnailReads,thumbnailBlobReads:stats.thumbnailBlobReads,objectURLsCreated:stats.objectURLsCreated,objectURLsRevoked:stats.objectURLsRevoked};thumbnailChecks.push(result);
  console.log(JSON.stringify({thumbnailRound:n,visibleCovers:after.length,sameNodes:after.filter(value=>value.sameNode).length,sameURLs:after.filter(value=>value.sameURL).length,thumbnailReads:stats.thumbnailReads,thumbnailBlobReads:stats.thumbnailBlobReads}));
  if(!baseline){assert(after.length>0);assert(firstReturnFrame.every(value=>value.decoded&&value.sameNode&&value.sameURL),'Warm return keeps decoded cover nodes and Blob URLs from its first frame');assert(after.every(value=>value.sameNode&&value.sameURL));assert.equal(stats.thumbnailReads,0,'Warm return must not reread the thumbnail database');}
 }
 checks.push('全部封面访问后，三次切回记录首帧图片、DOM节点、Blob URL及缩略图IDB读取；after要求全部复用且读取为零');
 await page.screenshot({path:path.join(out,'shelf-top.png')});
 for(const requested of [600,1800]){
  const target=await page.evaluate(top=>Math.min(top,Math.max(0,document.documentElement.scrollHeight-innerHeight)),requested);
  await page.evaluate(top=>window.scrollTo(0,top),target);await page.waitForFunction(top=>Math.abs(window.scrollY-top)<2,target);await settle();const before=await page.evaluate(()=>window.scrollY);
  await clickNav('漫画网站');await page.locator('.nc-library').waitFor({state:'hidden'});await settle();await clickNav('我的漫画');await page.locator('.nc-book').first().waitFor();await settle();const after=await page.evaluate(()=>window.scrollY);
  scrollChecks.push({requested,before,after,restored:Math.abs(after-before)<2});
  if(!baseline)assert(Math.abs(after-before)<2,`Shelf scroll must be restored: ${before} -> ${after}`);
 }
 await page.screenshot({path:path.join(out,'shelf-restored.png')});checks.push('记录 600px 与 1800px 书架切换前后滚动实值（见 scrollChecks）');
 if(!baseline){
  await page.evaluate(()=>window.scrollTo(0,600));await settle();const before=await page.evaluate(()=>window.scrollY);
  await clickNav('漫画网站');await page.locator('.nc-library').waitFor({state:'hidden'});await page.evaluate(()=>window.scrollTo(0,300));await settle();const otherPageScroll=await page.evaluate(()=>window.scrollY);assert(otherPageScroll>0,'The other page must actually scroll while the library is hidden');
  await clickNav('我的漫画');await page.locator('.nc-library').waitFor();await settle();const after=await page.evaluate(()=>window.scrollY);scrollChecks.push({scenario:'other-page-scroll',before,otherPageScroll,after,restored:Math.abs(after-before)<2});assert(Math.abs(after-before)<2,'Scrolling another page must not overwrite the hidden shelf position');
  await page.evaluate(()=>window.scrollTo(0,0));await settle();await page.getByRole('combobox',{name:'排序',exact:true}).click();await page.locator('.nc-library .nc-select-list:popover-open').waitFor();
  await clickNav('漫画网站');await page.locator('.nc-library').waitFor({state:'hidden'});assert.equal(await page.locator('.nc-library :popover-open').count(),0,'Hidden shelf must not retain a visible sorting popover');await clickNav('我的漫画');await settle();assert.equal(await page.locator('.nc-library :popover-open').count(),0);
  checks.push('隐藏书架时滚动漫画网站不会覆盖书架位置；打开排序后切页无残留popover');
 }
 await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>!!document.querySelector('[data-comic-id="perf-book-0"]'));await settle();
 await page.getByRole('button',{name:'打开漫画 性能夹具 001 · 单语言',exact:true}).click({button:'right'});await settle();
 assert.equal(await page.getByRole('menuitem',{name:'缓存语言',exact:true}).count(),0);await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'打开漫画 性能夹具 000 · 多语言',exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'缓存语言',exact:true}).waitFor();
 await page.getByRole('menuitem',{name:'缓存语言',exact:true}).click();await page.getByRole('dialog',{name:'缓存语言',exact:true}).waitFor();
 await page.getByRole('checkbox',{name:/English/}).waitFor();assert.equal(await page.getByRole('checkbox').count(),3);await page.screenshot({path:path.join(out,'cache-languages.png')});
 if(!baseline){
  await page.evaluate(()=>{location.hash='sites';});await page.locator('.nc-library').waitFor({state:'hidden'});await page.getByRole('dialog',{name:'缓存语言',exact:true}).waitFor({state:'hidden'});
  await clickNav('我的漫画');await page.locator('.nc-library').waitFor();await settle();assert.equal(await page.getByRole('dialog',{name:'缓存语言',exact:true}).count(),0,'Language popover must stay closed after hash navigation away and back');
  checks.push('缓存语言弹层打开时通过hash直接离开（无pointerdown），弹层关闭且返回不复活');
 }else await page.keyboard.press('Escape');
 checks.push('单语言菜单隐藏缓存语言；多语言菜单按需打开并显示两种语言');
 const multi=page.locator('[data-comic-id="perf-book-0"]');
 await multi.click({button:'right'});await page.getByRole('menuitem',{name:'缓存语言',exact:true}).waitFor();await page.keyboard.press('Escape');
 await multi.getByRole('button',{name:'打开漫画 性能夹具 000 · 多语言',exact:true}).focus();await page.keyboard.press('Shift+F10');await page.getByRole('menuitem',{name:'缓存语言',exact:true}).waitFor();await page.keyboard.press('Escape');
 if(!baseline){
  await page.evaluate(()=>{
   const original=IDBObjectStore.prototype.get;window.__scopeFixture='delay';
   IDBObjectStore.prototype.get=function(...args){
    if(this.name!=='comics'||args[0]!=='perf-book-0'||!window.__scopeFixture)return original.apply(this,args);
    const fixture=window.__scopeFixture;window.__scopeFixture='';if(fixture==='fail')throw Error('Synthetic scope read failure');
    const request=original.apply(this,args);Object.defineProperty(request,'onsuccess',{set(callback){request.addEventListener('success',event=>{window.__shelfPerf.pending++;setTimeout(()=>{callback.call(request,event);window.__shelfPerf.pending--;window.__shelfPerf.last=performance.now();},350);});}});return request;
   };
  });
  await multi.getByRole('button',{name:'打开漫画 性能夹具 000 · 多语言',exact:true}).click({button:'right'});await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');await settle();assert.equal(await page.getByRole('menu').count(),0,'Delayed language result must not reopen a closed menu');
  await page.evaluate(()=>{window.__scopeFixture='fail';});await multi.click({button:'right'});await settle();assert.equal(await page.getByRole('menuitem',{name:'缓存语言',exact:true}).count(),0);await page.getByRole('menuitem',{name:'继续阅读',exact:true}).waitFor();await page.keyboard.press('Escape');
  await multi.click({button:'right'});await page.getByRole('menuitem',{name:'缓存语言',exact:true}).waitFor();await page.keyboard.press('Escape');
  checks.push('右键和 Shift+F10 显示语言菜单；关闭菜单后迟到结果不重开；目录读取失败不影响其他操作，重新打开可恢复');
 }
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,label+'.json'),JSON.stringify({label,fixture:{books:count,chaptersPerBook:chapters,totalEntries:count*chapters},out,rounds,thumbnailChecks,scrollChecks,checks,errors,externalRequestsBlocked:requests},null,2));
 console.log(JSON.stringify({label,out,scrollChecks,checks,errors}));
}catch(error){await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await writeFile(path.join(output,label+'.json'),JSON.stringify({label,out,rounds,thumbnailChecks,scrollChecks,checks,errors,failure:String(error)},null,2));throw error;}
finally{await context.close();}
