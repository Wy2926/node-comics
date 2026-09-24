// Built MV3 extension, isolated profile and synthetic Comix routes; no translation calls.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),out=path.join(root,'artifacts/comix-entry');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('https://comix.to/*','https://*.wowpic1.store/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const errors=[],checks=[],limitations=[],sample=await readFile(path.join(root,'apps/extension/public/samples/starlight-bookshop.png'));
const catalogPath='/title/entry-fixture',chapterCatalog='/title/fresh-fixture',chapterPath=chapterCatalog+'/121-chapter-2';let failCatalog=false,source;
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
try{
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.protocol==='chrome-extension:')return route.continue();
  if(url.hostname==='images.wowpic1.store')return route.fulfill({contentType:'image/png',body:sample});
  if(url.hostname!=='comix.to')return route.abort();
  if(url.pathname.includes('/manga/')){const fresh=url.pathname.includes('/fresh/'),base=fresh?chapterCatalog:catalogPath,offset=fresh?119:19;return route.fulfill({status:failCatalog?503:200,json:{status:'ok',result:{items:[1,2].map(n=>({id:offset+n,number:n,mangaId:1,language:'en',isOfficial:true,url:base+'/'+(offset+n)+'-chapter-'+n})),meta:{page:1,lastPage:1,total:2,hasNext:false}}}});}
  if(url.pathname.includes('/chapters/')){const id=Number(url.pathname.split('/').at(-1)),n=id%100-19,base=id>=100?chapterCatalog:catalogPath;return route.fulfill({json:{status:'ok',result:{id,mangaId:1,number:n,url:base+'/'+id+'-chapter-'+n,pages:{items:[1,2].map(page=>({url:`https://images.wowpic1.store/${id}-${page}.png`,width:800,height:1200}))}}}});}
  const hid=/^\/title\/([a-z0-9]+)-/.exec(url.pathname)?.[1]??'entry';
  const initial=JSON.stringify({queries:{['["manga","detail","'+hid+'"]']:{id:1,hid,url:'/title/'+hid+'-fixture',title:'Comix embedded entry fixture'}}});
  return route.fulfill({status:failCatalog&&hid==='failed'?503:200,contentType:'text/html',body:`<!doctype html><html><head><title>Comix entry fixture</title><style>body{font:16px sans-serif;background:#171b26;color:#edf2ff;padding:32px}.mpage__actions{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:20px;background:#242b3b}.rpage-main{height:500px;background:#242b3b}button{padding:12px}</style></head><body><h1>Comix embedded entry fixture</h1>
   <button onclick="history.pushState({},'', '${catalogPath}');document.getElementById('anchor').className='mpage__actions'">Open comic</button>
   <button onclick="document.getElementById('anchor').replaceWith(document.getElementById('anchor').cloneNode(false))">Replace actions</button>
   <button onclick="history.pushState({},'', '/browse')">Leave comic</button>
   <div id="anchor" class="${url.pathname===catalogPath||hid==='failed'?'mpage__actions':''}"></div>
   ${url.pathname.includes('-chapter-')?'<div class="rpage-floatctl" role="toolbar" style="position:fixed;right:12px;top:12px;z-index:50;display:flex;flex-direction:column;align-items:flex-end"><button>Reader controls</button></div><main class="rpage-main" style="position:absolute;inset:0;height:100%">Reader image area</main>':''}
   <script type="application/json" id="initial-data">${initial}</script></body></html>`});
 });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const bootstrap=await context.newPage();await bootstrap.goto(new URL('reader.html',worker.url()).href);
 await bootstrap.evaluate(async()=>{localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN'}));await chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN',autoTranslateTabs:false}});});
 source=await context.newPage();await source.goto('https://comix.to/browse');
 const registration=await bootstrap.evaluate(async()=>{
  for(let n=0;n<100;n++){const scripts=await chrome.scripting.getRegisteredContentScripts();const entry=scripts.find(s=>s.id==='nc-source-entry-comix');if(entry)return entry;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('Comix optional content entry was not registered');
 });assert.deepEqual(registration.matches,['https://comix.to/*']);
 await bootstrap.close();
 await source.reload();const button=source.getByRole('button',{name:/NodeLane Comics/});assert.equal(await button.count(),0);
 await source.getByRole('button',{name:'Open comic',exact:true}).click();await button.waitFor();assert.equal(await button.count(),1);
 await source.screenshot({path:path.join(out,'catalog-entry.png')});
 const waitImage=page=>page.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth>0,null,{timeout:30000});
 let opened=context.waitForEvent('page');await button.click();let reader=await opened;await waitImage(reader);
 await reader.screenshot({path:path.join(out,'imported-reader.png')});checks.push('Granted host auto-registers the entry; first click after SPA navigation imports and renders the comic');
 await reader.getByLabel('跳转页码').fill('2');await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
 await reader.getByRole('button',{name:'继续阅读',exact:true}).click();await waitImage(reader);assert.equal(await reader.getByLabel('跳转页码').inputValue(),'2');await reader.close();
 checks.push('Imported comic reopens at its saved page');
 await source.getByRole('button',{name:'Replace actions',exact:true}).click();await button.waitFor();assert.equal(await button.count(),1);
 await source.getByRole('button',{name:'Leave comic',exact:true}).click();await button.waitFor({state:'detached'});
 checks.push('Replacing the source actions remounts one entry; leaving the comic removes it');
 await source.goto('https://comix.to'+chapterPath);await button.waitFor();
 assert.equal(await source.locator('.rpage-floatctl').getByRole('button',{name:/NodeLane Comics/}).count(),1);await source.screenshot({path:path.join(out,'chapter-entry.png')});
 opened=context.waitForEvent('page');await button.click();reader=await opened;await waitImage(reader);
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();assert.equal(await reader.locator('.nc-chapter-entry[aria-current="true"] b').innerText(),'Chapter 2');await reader.close();
 checks.push('Chapter entry imports the currently selected chapter through the HTTP adapter');
 await source.goto('https://comix.to/title/failed-fixture');await button.waitFor();failCatalog=true;await button.click();
 await source.getByRole('status').filter({hasText:/失败|稍后|重试/}).waitFor();assert(await button.isEnabled());await source.screenshot({path:path.join(out,'import-failure.png')});
 failCatalog=false;await source.goto('https://comix.to'+catalogPath);await button.waitFor();opened=context.waitForEvent('page');await button.click();reader=await opened;await waitImage(reader);
 checks.push('An import failure is visible and the next import succeeds');
 assert.deepEqual(errors,[]);
 if(process.env.RUN_LIVE_COMIX==='1'){
  await context.unroute('**/*');await context.route('https://*.nodelane.net/**',route=>route.abort());
  await source.goto('https://comix.to/title/nr83-the-sword-bearing-flower',{waitUntil:'domcontentloaded'});
  await source.locator('.mpage__actions').getByRole('button',{name:/NodeLane Comics/}).waitFor({timeout:30000});
  await source.screenshot({path:path.join(out,'live-catalog-entry.png')});
  await source.goto('https://comix.to/title/nr83-the-sword-bearing-flower/6887743-chapter-2',{waitUntil:'domcontentloaded'});
  await source.locator('.rpage-floatctl').getByRole('button',{name:/NodeLane Comics/}).waitFor({timeout:30000});
  assert.equal(await button.count(),1);
  assert(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}));
  try{await button.click({trial:true,timeout:5000});}catch(error){
   const overlay=await button.evaluate(el=>{const r=el.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),bounds=top?.getBoundingClientRect();return top?.tagName==='A'&&!!bounds&&bounds.width>=innerWidth&&bounds.height>=innerHeight;});
   if(!overlay)throw error;
   limitations.push('Live chapter has a source-owned full-screen link overlay intercepting clicks; entry layout verified, live click-through unverified.');
  }
  await source.screenshot({path:path.join(out,'live-chapter-entry.png')});
  checks.push('Live Comix detail and chapter pages render one embedded entry each; no live import or model request');
 }
 await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,limitations},null,2));console.log(JSON.stringify({out,checks,errors,limitations}));
}catch(error){if(source)await source.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await context.close();}
