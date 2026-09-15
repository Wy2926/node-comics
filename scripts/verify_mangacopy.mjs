/** Explicit live source acceptance: RUN_LIVE_MANGACOPY=1.
 * Uses an isolated unpacked build/profile; test-only required host permissions
 * pregrant the observed image origins. Native permission prompts are not tested.
 * Does not call any translation provider or reuse the user's browser profile.
 */
import {createRequire} from 'node:module';
import {cp,readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.env.RUN_LIVE_MANGACOPY,'1','This check downloads one public manga entry. Explicit opt-in required.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const launch={headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chromium'})};
const output=path.join(root,'artifacts/mangacopy-validation');await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-')),extension=path.join(run,'extension');await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const url=process.env.MANGACOPY_URL||'https://www.mangacopy.com/comic/laizishenyuan',sample=process.env.MANGACOPY_ENTRY||'第九卷番外';
// Focused source acceptance also runs independently of the management UI.
// RUN_LIVE_MANGACOPY=1 MANGACOPY_DISCOVERY_ONLY=1: chapter, volume, extra,
// and the direct popup discovery route, using actual inactive source tabs.
if(process.env.MANGACOPY_DISCOVERY_ONLY==='1'){
 const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
 manifest.host_permissions=[...manifest.host_permissions,new URL(url).origin+'/*'];
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
 const context=await chromium.launchPersistentContext(path.join(run,'profile'),{...launch,args:['--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:1000}});
 try{
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const reader=await context.newPage();await reader.goto(new URL('reader.html',worker.url()).href);
  const send=message=>reader.evaluate(async message=>{const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error??'No source response');return result.data;},message);
  const tab=await reader.evaluate(url=>chrome.tabs.create({url,active:false}),url);
  let catalog;
  for(let i=0;i<60;i++){
   await reader.waitForTimeout(500);const state=await reader.evaluate(id=>chrome.tabs.get(id),tab.id);if(state.status!=='complete')continue;
   const result=await send({type:'NC_DISCOVER_TAB',tabId:tab.id});if(result.catalog?.complete){catalog=result.catalog;break;}
  }
  assert(catalog?.complete,'Live source directory must be complete');await send({type:'NC_REGISTER_CATALOG',catalog});
  const results=[];
  for(const title of (process.env.MANGACOPY_ENTRIES||'第73話,第1卷,第九卷番外').split(',')){
   const entry=catalog.entries.find(e=>e.title===title);assert(entry,'Missing sample '+title);
   const {tabId}=await send({type:'NC_OPEN_SOURCE',catalogId:catalog.id,entryId:entry.id});
   const started=Date.now(),counts=[];let last,lastProgress=started,lastLog=0;
   try{
    for(let i=0;i<1200&&Date.now()-started<600000;i++){
     const next=await send({type:'NC_POLL_SOURCE',tabId});
     if(next){
      last=next;
      if(counts.at(-1)!==next.items.length){counts.push(next.items.length);lastProgress=Date.now();}
      if(Date.now()-lastLog>10000){lastLog=Date.now();console.log(JSON.stringify({title,found:next.items.length,total:next.knownTotal}));}
      if(next.discoveryComplete)break;
     }
     assert(Date.now()-lastProgress<40000,`${title}: no discovery progress for 40 seconds`);
     await reader.waitForTimeout(200);
    }
    assert(last?.discoveryComplete,title+' incomplete');assert.equal(last.items.length,last.knownTotal);
    assert(last.items.every((item,n)=>item.id==='slot-'+n&&item.order===n&&/^https?:/.test(item.url)));
    assert.equal((await reader.evaluate(id=>chrome.tabs.get(id),tabId)).active,false);
    const source=context.pages().find(p=>p.url()===entry.url);assert(source);
    const pageState=await source.evaluate(()=>({scrollY,domImages:document.querySelectorAll('.comicContent-list img').length,inlineData:[...document.scripts].some(script=>!script.src&&/var\s+contentKey\s*=/.test(script.textContent))}));
    assert.equal(pageState.scrollY,0,'Discovery must not scroll the source');assert(pageState.inlineData);assert(pageState.domImages<last.items.length,'The full list should come from JS data, not rendered slots');
    await source.screenshot({path:path.join(output,'discovery-'+results.length+'.png')});
    const result={title,total:last.knownTotal,initial:counts[0],growthSnapshots:counts.length,inactiveTab:true,durationMs:Date.now()-started,...pageState};results.push(result);console.log(JSON.stringify(result));
   }finally{await send({type:'NC_CLOSE_SOURCE',tabId});}
  }
  const entry=catalog.entries.find(e=>e.title===sample);assert(entry);
  const direct=await reader.evaluate(url=>chrome.tabs.create({url,active:false}),entry.url);
  for(let i=0;i<60;i++){await reader.waitForTimeout(500);if((await reader.evaluate(id=>chrome.tabs.get(id),direct.id)).status==='complete')break;}
  const directResult=await send({type:'NC_DISCOVER_TAB',tabId:direct.id});assert(directResult.manifest?.discoveryComplete);assert.equal(directResult.manifest.items.length,directResult.manifest.knownTotal);
  await reader.evaluate(id=>chrome.tabs.remove(id),direct.id);
  await writeFile(path.join(output,'discovery-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),catalogEntries:catalog.entries.length,results,directDiscovery:{title:sample,total:directResult.manifest.knownTotal,complete:true},scope:'Live JS image-list decoding in an isolated extension without scrolling; no translation, extension image downloads or native permission-dialog acceptance.'},null,2));
 }finally{await context.close();}
 process.exit(0);
}
const probeBrowser=await chromium.launch(launch),probe=await probeBrowser.newPage();
let origins;
try{await probe.goto(url);await probe.locator('.upLoop .tab-pane').first().waitFor();const href=await probe.locator('.upLoop a[href*="/chapter/"]').evaluateAll((links,title)=>links.find(a=>a.getAttribute('title')===title)?.href,sample);assert(href,'Sample must exist in the current rendered directory');await probe.goto(href);await probe.waitForSelector('.comicContent-list img[data-src]');origins=await probe.locator('.comicContent-list img[data-src]').evaluateAll(images=>[...new Set(images.map(i=>new URL(i.getAttribute('data-src')).origin+'/*'))]);}finally{await probeBrowser.close();}
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=[...manifest.host_permissions,new URL(url).origin+'/*',...origins];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const profile=path.join(run,'profile'),options={...launch,args:['--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:1000}};
let context=await chromium.launchPersistentContext(profile,options);const errors=[];let translationWrites=0;const checks={sample,permissions:'test-only pregrant',completeCatalog:false,restarted:false,multipleReaders:false};
const track=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/(translation-previews|translation-batches|translations)\b/.test(r.url()))translationWrites++;});};
const state=page=>page.evaluate(()=>new Promise((resolve,reject)=>{
 const r=indexedDB.open('node-comics-library');
 r.onsuccess=()=>{
  const tx=r.result.transaction(['library','copies'],'readonly'),a=tx.objectStore('library').get('library'),b=tx.objectStore('copies').getAll();
  tx.oncomplete=()=>{
   resolve({library:a.result,copies:b.result.map(c=>({id:c.id,title:c.title,sourceEntryId:c.sourceEntryId,complete:c.discoveryComplete,total:c.knownTotal,pages:c.pages.map(p=>({id:p.id,blobKey:p.blobKey,width:p.width,height:p.height}))}))});r.result.close();
  };
 };
 r.onerror=()=>reject(r.error);
}));
try{
 let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');let readerUrl=new URL('reader.html',worker.url()).href;
 const source=await context.newPage();await source.goto(url);await source.locator('.upLoop .tab-pane').first().waitFor();
 const opened=context.waitForEvent('page');await source.getByRole('button',{name:'Node Comics · 导入／管理漫画'}).click();let reader=await opened;track(reader);await reader.waitForURL('**/reader.html?catalog=*');
 await reader.getByRole('group',{name:'来源分组'}).getByRole('button',{name:/全部分组/}).click();await reader.getByRole('button',{name:'全选当前结果（跨页）',exact:true}).click();await reader.getByRole('button',{name:'下一步 · 确认归属',exact:true}).click();
 await reader.screenshot({path:path.join(output,'catalog-confirm.png')});await reader.getByRole('button',{name:/确认导入 \d+ 项/}).click();await reader.getByRole('heading',{name:/我的漫画/}).waitFor();
 const initial=await state(reader);const catalog=initial.library.catalogs[0];assert(catalog.complete);assert.equal(initial.copies.length,catalog.entries.length);assert.equal(initial.library.tasks.length,0);checks.completeCatalog=true;checks.catalogEntries=catalog.entries.length;
 for(const e of catalog.entries.filter(e=>e.related)){const copy=initial.copies.find(c=>c.sourceEntryId===e.id);const coverage=initial.library.coverage.find(c=>c.copyId===copy.id);assert.notEqual(coverage.workId,catalog.workId);assert.equal(coverage.target.kind,'unclassified');}
 const wanted=initial.copies.find(c=>c.title===sample);assert(wanted);
 await reader.getByRole('button',{name:/采集中心/}).click();
 const capture=()=>reader.locator('.nc-capture-card').filter({has:reader.getByRole('heading',{name:sample,exact:true})});
 await capture().getByRole('button',{name:'下载／补齐',exact:true}).click();
 await reader.getByRole('status').filter({hasText:sample+'已加入采集队列'}).first().waitFor();
 let savedBefore=[],finished=false,second;
 for(let i=0;i<260;i++){
  await reader.waitForTimeout(1500);const snapshot=await state(reader),copy=snapshot.copies.find(c=>c.id===wanted.id),task=snapshot.library.tasks.find(t=>t.copyId===wanted.id);
  if(task?.status==='failed')throw Error(task.error);
  if(!checks.restarted&&task?.phase==='images'&&copy.pages.filter(p=>p.blobKey).length>=5){
   savedBefore=copy.pages.filter(p=>p.blobKey).map(p=>p.id);await context.close();context=await chromium.launchPersistentContext(profile,options);worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');readerUrl=new URL('reader.html',worker.url()).href;reader=await context.newPage();track(reader);await reader.goto(readerUrl);await reader.getByRole('button',{name:/采集中心/}).click();await capture().getByRole('button',{name:'继续采集',exact:true}).waitFor();const resumed=await state(reader);assert(savedBefore.every(id=>resumed.copies.find(c=>c.id===wanted.id).pages.some(p=>p.id===id&&p.blobKey)));checks.restarted=true;
   second=await context.newPage();track(second);await second.goto(readerUrl);checks.multipleReaders=true;await capture().getByRole('button',{name:'继续采集',exact:true}).click();continue;
  }
  if(task?.status==='complete'){assert(copy.complete);assert.equal(copy.pages.length,copy.total);assert(copy.pages.every(p=>p.blobKey&&p.width>0&&p.height>0));assert(savedBefore.every(id=>copy.pages.some(p=>p.id===id)));checks.saved=copy.pages.length;finished=true;break;}
 }
 assert(finished,'Download did not finish within the bounded test');assert(checks.restarted);await second?.close();
 await reader.screenshot({path:path.join(output,'capture-complete.png')});await capture().getByRole('button',{name:'阅读已有页',exact:true}).click();
 await reader.locator('.nc-manga-page[data-page-index="0"] .nc-page-image').waitFor();await reader.screenshot({path:path.join(output,'reader-first.png')});const jump=reader.getByLabel('跳转页码');await jump.fill(String(checks.saved));await jump.press('Enter');await jump.blur();await reader.locator('.nc-manga-page[data-page-index="'+(checks.saved-1)+'"] .nc-page-image').waitFor();await reader.screenshot({path:path.join(output,'reader-last.png')});
 await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.setViewportSize({width:390,height:844});await reader.screenshot({path:path.join(output,'library-mobile.png')});assert.equal(await reader.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.equal(translationWrites,0);
 await writeFile(path.join(output,'results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,errors,translationWrites},null,2));console.log(JSON.stringify(checks));
}finally{await context.close();}
