// Isolated MV3 reader using the built manifest host access. Never opens a MangaDex website tab.
// Default: synthetic API/images. RUN_LIVE_MANGADEX=1: public API and image hosts.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),live=process.env.RUN_LIVE_MANGADEX==='1',out=path.join(root,'artifacts/mangadex',live?'live-reader':'fixture-reader');
await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(manifest.host_permissions?.includes('http://*/*'));
assert(manifest.host_permissions?.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
const source=path.join(root,'apps/extension/src').replaceAll('\\','/'),probe=path.join(extension,'probe.js');
await writeFile(probe,`export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {readerSequence,comicDirectory} from '${source}/comics/application/library-service.ts';
export {sourcePageCache} from '${source}/storage/source-pages/index.ts';
export {pageReference,RENDER_PROFILE} from '${source}/comics/pages/identity.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-source.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,
  locale:'zh-CN',viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
context.setDefaultTimeout(30000);context.setDefaultNavigationTimeout(30000);
const errors=[],checks=[],created=[],chapterReads=[],chapterMetadataReads=[],imageReads=[],cacheDiagnostics=[],networkFailures=[],scrollDiagnostics=[];
context.on('page',page=>{created.push(page);page.on('pageerror',error=>errors.push(error.message));});
context.on('requestfailed',request=>networkFailures.push({host:new URL(request.url()).hostname,error:request.failure()?.errorText}));
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const manga=live?'42f40118-dff5-4f23-acbf-e54e89f026bd':uuid(1);
const ids={empty:uuid(9),en1:uuid(11),zh1:uuid(12),en2a:uuid(21),en2b:uuid(22),en3:uuid(31),zh3:uuid(32),vi4:uuid(41)};
let removeChosen=false,failFeed=false,failChapterApi=false,server='first-fixture.mangadex.network';
const blockedImageHosts=new Set();
function rows(){return [[ids.empty,'0','en',0,'Unavailable preface','Group Zero'],[ids.en1,'1','en',3,'English one','Group One'],[ids.zh1,'1','zh-hk',5,'中文第一话','中文组'],
  [ids.en2a,'2','en',2,'English two A','Group A'],[ids.en2b,'2','en',4,'English two B','Group B'],[ids.en3,'3','en',2,'English three','Group Three'],
  [ids.zh3,'3','zh-hk',3,'中文第三话','中文组'],[ids.vi4,'4','vi',2,'Vietnamese four','Group Four']]
  .filter(([id])=>!removeChosen||id!==ids.en2b).map(([id,chapter,language,pages,title,group])=>({id,type:'chapter',attributes:{volume:'1',chapter,title,
    translatedLanguage:language,pages,externalUrl:null,isUnavailable:false},relationships:[{id:manga,type:'manga'},{id:uuid(90),type:'scanlation_group',attributes:{name:group}}]}));}
function aggregate(){const chapters={};for(const row of rows()){const key=row.attributes.chapter;if(!chapters[key])chapters[key]={chapter:key,id:row.id,others:[],count:1};else {chapters[key].others.push(row.id);chapters[key].count++;}}
  return {result:'ok',volumes:{'1':{volume:'1',count:rows().length,chapters}}};}
function png(){const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const name=Buffer.from(type),output=Buffer.alloc(12+data.length);output.writeUInt32BE(data.length);name.copy(output,4);data.copy(output,8);output.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return output;};
  const header=Buffer.alloc(13);header.writeUInt32BE(800);header.writeUInt32BE(1200,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(2401*1200);for(let y=0;y<1200;y++)for(let x=0;x<800;x++){const offset=y*2401+1+x*3;pixels[offset]=220;pixels[offset+1]=190+Math.floor(y/100);pixels[offset+2]=140+Math.floor(x/10);}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
if(!live){
  const bytes=png();
  await context.route('https://api.mangadex.org/**',async route=>{
    const url=new URL(route.request().url()),parts=url.pathname.split('/');let value;
    if(parts[1]==='manga'&&parts[3]==='feed'){
      if(failFeed)return route.fulfill({status:503,body:'Unavailable'});
      const all=rows(),offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
      value={result:'ok',response:'collection',data:all.slice(offset,offset+limit),limit,offset,total:all.length};
    }else if(parts[1]==='manga'&&parts[3]==='aggregate')value=aggregate();
    else if(parts[1]==='manga')value={result:'ok',response:'entity',data:{id:manga,type:'manga',attributes:{title:{en:'MangaDex multilingual fixture'},originalLanguage:'ja'},relationships:[{id:uuid(2),type:'cover_art',attributes:{fileName:'fixture-cover.png'}}]}};
    else if(parts[1]==='chapter'){chapterMetadataReads.push(parts[2]);if(failChapterApi===true)return route.fulfill({status:503,body:'Unavailable'});const chapter=rows().find(row=>row.id===parts[2]);value={result:'ok',response:'entity',data:chapter};}
    else if(parts[1]==='at-home'){chapterReads.push(parts[3]);if(failChapterApi)return route.fulfill({status:503,body:'Unavailable'});const chapter=rows().find(row=>row.id===parts[3]);value={result:'ok',baseUrl:'https://'+server,chapter:{hash:'a'.repeat(32),data:Array.from({length:chapter.attributes.pages},(_,n)=>`${chapter.id}-${n}.png`)}};}
    else throw Error('Unexpected fixture API route: '+url.pathname);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  });
  for(const host of ['https://*.mangadex.network/**','https://uploads.mangadex.org/**'])await context.route(host,route=>{
    const url=new URL(route.request().url());imageReads.push({host:url.hostname,path:url.pathname});
    return blockedImageHosts.has(url.hostname)?route.fulfill({status:503,body:'Expired image node'}):route.fulfill({status:200,contentType:'image/png',body:bytes});
  });
}
let reader,activeEntryId,targetLanguage='zh-Hans';
const state=()=>reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-source.js'));return {comics:await catalog.list('comics'),entries:await catalog.list('entries',{limit:10000}),positions:await catalog.list('positions'),pages:await catalog.list('pageDescriptors',{limit:1500}),materializations:await catalog.list('materializations',{limit:1500})};});
const apiCounts=remote=>({chapter:chapterMetadataReads.filter(id=>id===remote).length,atHome:chapterReads.filter(id=>id===remote).length});
function pageIdentity(snapshot,entry){return {contentId:snapshot.entries.find(item=>item.id===entry.id).contentId,
  pageIds:snapshot.pages.filter(page=>page.contentId===entry.contentId).sort((a,b)=>a.ordinal-b.ordinal).map(page=>page.pageId),
  images:snapshot.materializations.filter(page=>page.contentId===entry.contentId).map(page=>({pageId:page.pageId,imageSha256:page.imageSha256})).sort((a,b)=>a.pageId.localeCompare(b.pageId))};}
async function image(index=0){await reader.waitForFunction(({index,id})=>document.querySelector(`${id?`[data-copy-id="${id}"] `:''}[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth>0,{index,id:activeEntryId},{timeout:60000});}
const remoteId=entry=>entry.sourceEntryId.split(':').at(-1);
async function entryFor(remote){const entry=(await state()).entries.find(entry=>remoteId(entry)===remote);assert(entry,'Missing stored release '+remote);return entry;}
async function directory(){return reader.evaluate(async({currentId,targetLanguage})=>{const p=await import(chrome.runtime.getURL('verify-source.js')),comic=(await p.catalog.list('comics'))[0];return p.comicDirectory(comic.id,currentId,targetLanguage);},{currentId:activeEntryId,targetLanguage});}
async function sequence(remote){const entry=await entryFor(remote);return reader.evaluate(async({entryId,targetLanguage})=>{const p=await import(chrome.runtime.getURL('verify-source.js'));return (await p.readerSequence(entryId,undefined,targetLanguage)).copies.map(copy=>({id:copy.id,title:copy.title}));},{entryId:entry.id,targetLanguage});}
async function closePanel(){const close=reader.getByRole('button',{name:'关闭面板',exact:true});if(await close.isVisible())await close.click();}
async function openDirectory(){
  const button=reader.getByRole('button',{name:'打开目录',exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click();
  const tab=reader.getByRole('tab',{name:/^目录/});if(await tab.isVisible()&&await tab.getAttribute('aria-selected')!=='true')await tab.click();
  await reader.getByRole('searchbox',{name:'搜索目录',exact:true}).waitFor();
  assert.equal(await reader.getByRole('combobox',{name:'内容语言',exact:true}).count(),0);
}
async function waitEntry(remote,page){
  const entry=await entryFor(remote);activeEntryId=entry.id;
  await reader.waitForFunction(title=>document.querySelector('[aria-label="打开目录"]')?.title.includes(title),entry.title);
  if(page!==undefined)await reader.waitForFunction(page=>document.querySelector('[aria-label="跳转页码"]')?.value===String(page),page);
  await image((page??Number(await reader.getByLabel('跳转页码',{exact:true}).inputValue()))-1);
}
async function slotFor(remote){
  const entry=await entryFor(remote),chapter=(await directory()).chapters.find(chapter=>chapter.entryIds.includes(entry.id));assert(chapter,'Missing logical chapter');
  const slot=reader.locator(`[data-reading-slot=${JSON.stringify(chapter.id)}]`);
  for(const ancestor of await slot.locator('xpath=ancestor::details[not(@open)]').all())await ancestor.locator(':scope > summary').click();
  return {entry,chapter,slot};
}
async function chooseRelease(remote,page){
  await openDirectory();await reader.getByRole('searchbox',{name:'搜索目录',exact:true}).fill('');
  const {entry,chapter,slot}=await slotFor(remote);
  if(chapter.entryIds.length>1){
    const expand=slot.getByRole('button',{name:'展开章节选项',exact:true});if(await expand.isVisible())await expand.click();
    await slot.locator(`[data-release-choice="true"][data-entry-id="${entry.id}"]`).click();
  }else await slot.locator(`[data-chapter-main="true"][data-entry-id="${entry.id}"]`).click();
  await waitEntry(remote,page);
}
async function setTargetLanguage(code,label){
  await closePanel();await reader.locator('.nc-translation-trigger').click();
  await reader.getByRole('combobox',{name:'翻译目标语言',exact:true}).click();await reader.getByRole('option',{name:label,exact:true}).click();
  await reader.waitForFunction(code=>document.querySelector('[aria-label="翻译目标语言"]')?.getAttribute('data-value')===code,code);
  targetLanguage=code;await closePanel();
}
async function setLayout(label){await closePanel();await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.getByRole('group',{name:'阅读布局',exact:true}).getByRole('button',{name:label,exact:true}).click();await closePanel();}
async function readingGeometry(entryId){return reader.evaluate(entryId=>{
  const viewport=document.querySelector('.nc-reading-viewport'),target=document.querySelector(`[data-copy-id="${entryId}"] [data-page-index="0"]`),stack=target?.closest('.nc-page-stack');
  const box=element=>{const rect=element?.getBoundingClientRect();return rect?{top:rect.top,bottom:rect.bottom,height:rect.height}:null;};
  return {title:document.querySelector('[aria-label="打开目录"]')?.title,page:document.querySelector('[aria-label="跳转页码"]')?.value,
    viewport:box(viewport),scrollTop:viewport?.scrollTop,scrollHeight:viewport?.scrollHeight,target:box(target),stack:box(stack),
    chapters:[...document.querySelectorAll('[data-copy-id]')].map(chapter=>({id:chapter.getAttribute('data-copy-id'),...box(chapter),pages:[...chapter.querySelectorAll('[data-page-index]')].map(page=>({index:page.getAttribute('data-page-index'),...box(page)}))}))};
},entryId);}
async function scrollToRelease(remote){
  const entry=await entryFor(remote);await closePanel();
  // Explicit navigation can still be restoring its anchor when the first image decodes.
  // Wait for committed layout across animation frames, then use a real wheel event.
  await reader.waitForFunction(async entryId=>{
    const sample=()=>{const viewport=document.querySelector('.nc-reading-viewport'),target=document.querySelector(`[data-copy-id="${entryId}"] [data-page-index="0"]`);if(!viewport||!target)return;const rect=target.getBoundingClientRect();return rect.height>0?JSON.stringify([viewport.scrollTop,viewport.scrollHeight,rect.top,rect.height]):undefined;};
    const first=sample();await new Promise(resolve=>requestAnimationFrame(resolve));const second=sample();await new Promise(resolve=>requestAnimationFrame(resolve));return first!==undefined&&first===second&&second===sample();
  },entry.id);
  const diagnostic={remote,before:await readingGeometry(entry.id)};scrollDiagnostics.push(diagnostic);
  const viewport=await reader.locator('.nc-reading-viewport').boundingBox();assert(viewport);assert(diagnostic.before.target);
  await reader.mouse.move(viewport.x+viewport.width*.65,viewport.y+viewport.height*.5);
  await reader.mouse.wheel(0,diagnostic.before.target.top-viewport.y-40||1);diagnostic.after=await readingGeometry(entry.id);
  try{await waitEntry(remote);diagnostic.selected=await readingGeometry(entry.id);}catch(error){diagnostic.failed=await readingGeometry(entry.id);throw error;}
}
async function jump(number,remote){await reader.getByLabel('跳转页码',{exact:true}).fill(String(number));await image(number-1);
  await reader.waitForFunction(async({remote,ordinal})=>{const {catalog}=await import(chrome.runtime.getURL('verify-source.js'));const entry=(await catalog.list('entries',{limit:10000})).find(item=>item.sourceEntryId==='mangadex:chapter:'+remote);if(!entry)return false;const position=await catalog.get('positions',entry.id),pages=await catalog.listPages(entry.contentId);return position?.pageId===pages[ordinal]?.pageId;},{remote,ordinal:number-1});}
async function refresh(){return reader.evaluate(async()=>{const p=await import(chrome.runtime.getURL('verify-source.js')),comic=(await p.catalog.list('comics'))[0];const snapshot=await p.readWebsiteCatalog(comic.sourceUrl);await p.applyCatalogRefresh(comic.id,comic.source.generation,snapshot);return snapshot.entries.length;});}
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),home=new URL('reader.html',worker.url()).href;
  reader=await context.newPage();await reader.goto(home);await reader.evaluate(async()=>{const settings={uiLanguage:'zh-CN',language:'zh-Hans',layout:'continuous',fit:'window'};localStorage.setItem('nc-settings',JSON.stringify(settings));await chrome.storage.local.set({'nc-reader-settings':settings});});await reader.reload();
  await reader.getByRole('button',{name:'漫画网站',exact:true}).click();await reader.getByRole('heading',{name:'MangaDex',exact:true}).waitFor();
  await reader.getByLabel('通过链接添加漫画').fill(`https://mangadex.org/title/${manga}`);await reader.getByRole('button',{name:'添加到书架',exact:true}).click();
  await reader.getByLabel('跳转页码',{exact:true}).waitFor({timeout:60000});
  const imported=await state();assert.equal(imported.comics.length,1);assert.equal(imported.entries.length,live?84:8);
  assert.equal(await reader.getByRole('region',{name:'选择开始阅读的位置'}).count(),0);
  checks.push('Title import immediately opens the first readable chapter, keeps one comic and imports every release without a start-position screen');
  if(live){
    const english=imported.entries.filter(entry=>entry.contentLanguage==='en').sort((a,b)=>a.order-b.order)[0];
    assert(english);const remote=remoteId(english);await waitEntry(remote,1);
    await openDirectory();assert.equal((await directory()).chapters.length,47);assert.equal(await reader.locator('[data-reading-slot]').count(),47);
    await reader.screenshot({path:path.join(out,'merged-directory.png')});await closePanel();
    await jump(3,remote);await reader.screenshot({path:path.join(out,'english-page-3.png')});
    const before=await state(),en=before.entries.find(entry=>entry.id===english.id);assert.equal(en.pageCount,4);
    const chinese=before.entries.find(entry=>entry.contentLanguage==='zh-HK'&&entry.readingSlotId===en.readingSlotId);assert(chinese);
    await chooseRelease(remoteId(chinese),1);
    const current=await state();assert.equal(current.entries.find(entry=>entry.id===chinese.id).pageCount,10);
    await jump(4,remoteId(chinese));await reader.screenshot({path:path.join(out,'chinese-page-4.png')});
    checks.push('Public MangaDex API and CDN images decode in the reader: English chapter 1 has 4 pages; Chinese has 10 independent pages');
    await chooseRelease(remote,3);
    checks.push('The directory merges 84 releases into 47 chapters; expanding one chapter switches language and restores each release position');
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    const cover=reader.locator('.nc-book .nc-thumbnail img');await cover.waitFor();await cover.evaluate(img=>img.decode());assert(await cover.evaluate(img=>img.naturalWidth>0));
    await reader.close();reader=await context.newPage();await reader.goto(home);await reader.getByRole('button',{name:'继续阅读',exact:true}).click();await waitEntry(remote,3);
    assert.equal(await refresh(),imported.entries.length);checks.push('Dedicated cover, reader reopen, and full catalog refresh work without a source website tab');
  }else{
    await waitEntry(ids.en1,1);await jump(3,ids.en1);
    assert(!chapterReads.includes(ids.empty)&&!chapterReads.includes(ids.zh1)&&!chapterReads.includes(ids.en2b),'Unavailable and unchosen alternate releases must not be leased');
    await openDirectory();assert.equal((await directory()).chapters.length,5);assert.equal(await reader.locator('[data-reading-slot]').count(),5);
    const first=await slotFor(ids.en1),collapse=first.slot.getByRole('button',{name:'收起章节选项',exact:true});if(await collapse.isVisible())await collapse.click();
    assert.equal(await first.slot.locator('[data-release-choice="true"]').count(),0);await first.slot.getByRole('button',{name:'展开章节选项',exact:true}).click();
    assert.equal(await first.slot.locator('[data-release-choice="true"]').count(),2);assert.equal(await reader.getByLabel('跳转页码').inputValue(),'3');
    await reader.screenshot({path:path.join(out,'merged-directory.png')});
    checks.push('The compact directory contains five logical chapters for eight releases and expands language choices without changing the current page');
    await chooseRelease(ids.zh1,1);await jump(4,ids.zh1);await chooseRelease(ids.en1,3);
    assert(!chapterReads.includes(ids.en2b),'Alternate scanlation group must remain unloaded until selected');
    await chooseRelease(ids.en2b,1);await jump(3,ids.en2b);
    checks.push('Expanded language and group choices load only the selected release and retain independent English page 3 and Chinese page 4');
    await setTargetLanguage('zh-Hant','繁體中文');await waitEntry(ids.en2b,3);
    const resolved=await sequence(ids.en2b),expected=[ids.empty,ids.en1,ids.en2b,ids.zh3,ids.vi4];
    assert.deepEqual(resolved.map(copy=>copy.id),(await Promise.all(expected.map(entryFor))).map(entry=>entry.id));
    assert.equal(await reader.locator('[data-reading-boundary]').count(),0);
    await jump(4,ids.en2b);await scrollToRelease(ids.zh3);await jump(3,ids.zh3);await scrollToRelease(ids.vi4);await jump(2,ids.vi4);
    await reader.screenshot({path:path.join(out,'automatic-language-sequence.png')});
    checks.push('Changing translation target preserves the current page; continuous reading chooses English fallback, Chinese again on chapter 3, then the first Vietnamese release on chapter 4');
    await chooseRelease(ids.en1,3);await scrollToRelease(ids.en2b);await jump(3,ids.en2b);
    checks.push('Returning to chapter 1 and continuing remembers the manually selected scanlation group for chapter 2');
    const chosen=await entryFor(ids.en2b);
    await reader.waitForFunction(async({id,count})=>{const {sourcePageCache}=await import(chrome.runtime.getURL('verify-source.js'));return (await sourcePageCache.inventory([id],true)).length===count;},{id:chosen.id,count:chosen.pageCount});
    const before=await state(),chosenPosition=before.positions.find(position=>position.entryId===chosen.id),chosenIdentity=pageIdentity(before,chosen),beforeCachedOpen=apiCounts(ids.en2b);
    server='second-fixture.mangadex.network';failChapterApi=true;
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.close();reader=await context.newPage();await reader.goto(home);
    const openedAt=Date.now();await reader.getByRole('button',{name:'继续阅读',exact:true}).click();await waitEntry(ids.en2b,3);
    const elapsedMs=Date.now()-openedAt,reopened=await state();assert(elapsedMs<5000,`Cached reopen took ${elapsedMs}ms`);
    assert.deepEqual(apiCounts(ids.en2b),beforeCachedOpen,'A cached shelf reopen must not request chapter metadata or an at-home server');
    assert.deepEqual(pageIdentity(reopened,chosen),chosenIdentity);assert.equal(reopened.positions.find(position=>position.entryId===chosen.id).pageId,chosenPosition.pageId);
    assert(reopened.pages.filter(page=>page.contentId===chosen.contentId).every(page=>new URL(page.locator.url).hostname==='first-fixture.mangadex.network'));
    cacheDiagnostics.push({scenario:'cached-shelf-reopen-with-unavailable-api',elapsedMs,requests:apiCounts(ids.en2b)});
    checks.push('A fully cached shelf reopen displays the selected release at page 3 within five seconds with zero chapter/at-home requests, even when both APIs are unavailable; page and image identities remain unchanged');
    const beforeNeighborOpen=apiCounts(ids.en2b);await chooseRelease(ids.en1,3);
    await reader.waitForFunction(id=>document.querySelector(`[data-copy-id="${id}"] [data-page-index="0"] img.nc-page-image`)?.naturalWidth>0,chosen.id);
    assert.deepEqual(apiCounts(ids.en2b),beforeNeighborOpen,'Preloading an indexed adjacent chapter must not refresh its image manifest');
    await scrollToRelease(ids.en2b);await jump(3,ids.en2b);
    assert.deepEqual(apiCounts(ids.en2b),beforeNeighborOpen,'Scrolling into a cached adjacent chapter must not refresh its image manifest');
    checks.push('An already cached adjacent chapter preloads and becomes active through continuous scrolling without chapter/at-home requests');
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.close();reader=await context.newPage();await reader.goto(home);
    await reader.evaluate(async id=>{const {sourcePageCache}=await import(chrome.runtime.getURL('verify-source.js'));await sourcePageCache.deleteOwner(id);if((await sourcePageCache.inventory([id],true)).length)throw Error('Selected chapter cache was not cleared');},chosen.id);
    failChapterApi=false;blockedImageHosts.add('first-fixture.mangadex.network');const beforeExpiredOpen=apiCounts(ids.en2b),imageReadStart=imageReads.length;
    await reader.getByRole('button',{name:'继续阅读',exact:true}).click();await waitEntry(ids.en2b,3);
    await reader.waitForFunction(async({id,count})=>{const {sourcePageCache}=await import(chrome.runtime.getURL('verify-source.js'));return (await sourcePageCache.inventory([id],true)).length===count;},{id:chosen.id,count:chosen.pageCount});
    assert.deepEqual(apiCounts(ids.en2b),{chapter:beforeExpiredOpen.chapter+1,atHome:beforeExpiredOpen.atHome+1},'Concurrent missing pages must share one manifest refresh after the old image node fails');
    const recovered=await state(),retriedImages=imageReads.slice(imageReadStart).filter(item=>item.path.includes(ids.en2b));
    assert(retriedImages.some(item=>item.host==='first-fixture.mangadex.network'),'The saved image URL must be tried before refreshing');
    assert(retriedImages.some(item=>item.host===server),'The refreshed image node must actually supply image bytes');
    assert(recovered.pages.filter(page=>page.contentId===chosen.contentId).every(page=>new URL(page.locator.url).hostname===server));
    assert.deepEqual(pageIdentity(recovered,chosen),chosenIdentity);assert.equal(recovered.positions.find(position=>position.entryId===chosen.id).pageId,chosenPosition.pageId);
    cacheDiagnostics.push({scenario:'expired-node-cache-miss',requests:apiCounts(ids.en2b),images:retriedImages});
    checks.push('After deleting ordinary image cache, failed saved image URLs trigger one shared chapter/at-home refresh; the replacement node supplies images without changing release, page 3, content IDs or image hashes');
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.close();reader=await context.newPage();await reader.goto(home);
    await reader.evaluate(async({entryId,contentId,pageId})=>{const {sourcePageCache,pageReference,RENDER_PROFILE}=await import(chrome.runtime.getURL('verify-source.js'));await sourcePageCache.delete(pageReference({entryId,contentId,pageId,renderProfileId:RENDER_PROFILE}));},{entryId:chosen.id,contentId:chosen.contentId,pageId:chosenPosition.pageId});
    blockedImageHosts.add(server);server='third-fixture.mangadex.network';failChapterApi='at-home';const beforeFailedRefresh=apiCounts(ids.en2b);
    await reader.getByRole('button',{name:'继续阅读',exact:true}).click();
    const failedPage=reader.locator(`[data-copy-id="${chosen.id}"] [data-page-index="2"] .nc-image-failure`);await failedPage.waitFor();
    assert.equal(await reader.getByLabel('跳转页码',{exact:true}).inputValue(),'3');await image(0);
    assert.deepEqual(apiCounts(ids.en2b),{chapter:beforeFailedRefresh.chapter+1,atHome:beforeFailedRefresh.atHome+1},'A failed at-home refresh must not loop');
    const failedRefresh=await state();assert.deepEqual(pageIdentity(failedRefresh,chosen),chosenIdentity);assert.equal(failedRefresh.positions.find(position=>position.entryId===chosen.id).pageId,chosenPosition.pageId);
    await reader.screenshot({path:path.join(out,'expired-node-refresh-failure.png')});
    checks.push('If an uncached page cannot renew its image node, only that page shows an error; other cached pages decode and the selected page and content identities remain intact');
    failChapterApi=false;await failedPage.getByRole('button',{name:'重试',exact:true}).click();await image(2);
    assert.deepEqual(pageIdentity(await state(),chosen),chosenIdentity);await chooseRelease(ids.en1,3);
    checks.push('Retrying the failed page after API recovery displays the original image with the same page identity');
    const priorRemoval=await state(),savedChoicePosition=priorRemoval.positions.find(position=>position.entryId===chosen.id);
    removeChosen=true;assert.equal(await refresh(),7);
    const remaining=await sequence(ids.en1),alternate=await entryFor(ids.en2a);assert(remaining.some(copy=>copy.id===alternate.id));assert(!remaining.some(copy=>copy.id===chosen.id));
    const afterRemoval=await state(),removed=afterRemoval.entries.find(entry=>entry.id===chosen.id);assert(removed.sourceRemoved);assert.equal(removed.contentId,chosen.contentId);
    assert.equal(afterRemoval.positions.find(position=>position.entryId===chosen.id).pageId,savedChoicePosition.pageId);
    assert.equal(await reader.locator('[data-reading-boundary]').count(),0);assert.equal((await directory()).chapters.length,5);
    await openDirectory();await reader.screenshot({path:path.join(out,'removed-choice-fallback.png')});await closePanel();
    checks.push('Removing the chosen group automatically falls back to the remaining release without blocking, while retaining the removed content and progress');
    const retained=await state();failFeed=true;await assert.rejects(refresh());assert.equal((await state()).entries.length,retained.entries.length);
    checks.push('Failed full catalog refresh preserves all existing language and release records');
    failFeed=false;await setLayout('单页阅读');await waitEntry(ids.en1,3);await reader.getByRole('button',{name:'下一页',exact:true}).click();await waitEntry(ids.en2a,1);
    await jump(2,ids.en2a);await reader.getByRole('button',{name:'下一页',exact:true}).click();await waitEntry(ids.zh3,1);
    await jump(3,ids.zh3);await reader.getByRole('button',{name:'下一页',exact:true}).click();await waitEntry(ids.vi4,1);
    checks.push('Single-page next-page navigation crosses logical chapters using the same automatic language selection without an explicit navigation reload');
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.getByRole('button',{name:'漫画网站',exact:true}).click();
    await reader.getByLabel('通过链接添加漫画').fill(`https://mangadex.org/chapter/${ids.zh1}`);await reader.getByRole('button',{name:'添加到书架',exact:true}).click();
    await waitEntry(ids.zh1,4);assert.equal((await state()).comics.length,1);
    checks.push('Importing a chapter link selects that exact language release and restores its own page without creating a second comic');
  }
  assert(created.every(page=>!page.url().startsWith('https://mangadex.org')),'Acceptance never opens the source website');
  assert.deepEqual(errors,[]);
  await reader.screenshot({path:path.join(out,'final.png')});
  await writeFile(path.join(out,'results.json'),JSON.stringify({status:'passed',live,checks,errors,chapterMetadataReads,chapterReads,cacheDiagnostics,networkFailures,scrollDiagnostics,sourceWebsiteOpened:false,nativePermissionPromptTested:false},null,2));
  console.log(JSON.stringify({out,live,checks,errors}));
}catch(error){await writeFile(path.join(out,'results.json'),JSON.stringify({status:'failed',live,checks,errors,chapterMetadataReads,chapterReads,cacheDiagnostics,networkFailures,scrollDiagnostics,error:error.message,sourceWebsiteOpened:false,nativePermissionPromptTested:false},null,2));if(reader&&!reader.isClosed()){await reader.screenshot({path:path.join(out,'failure.png')});console.log((await reader.locator('body').innerText()).slice(-2200));}console.log(JSON.stringify({networkFailures}));throw error;}
finally{await context.close();}
