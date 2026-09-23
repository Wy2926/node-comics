// Built extension, isolated Chromium profile, fixture site and a real local HTTP header server.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),base=path.join(root,'artifacts/source-boundaries');await mkdir(base,{recursive:true});
const out=await mkdtemp(path.join(base,'run-')),extension=path.join(out,'extension');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*','https://comix.to/*','https://*.wowpic1.store/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const source=path.join(root,'apps/extension/src').replaceAll('\\','/'),probe=path.join(extension,'probe.js');
await writeFile(probe,`export {fetchSourceImage,sourceImage} from '${source}/sources/runtime/image-fetch.ts';export {recoverImageHeaders} from '${source}/sources/runtime/image-headers.ts';export {catalog} from '${source}/comics/repositories/index.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-runtime.js'}}});
let png,held;
const timers=new Set();
const server=createServer((req,res)=>{
  if(req.url==='/hold'){held?.();return;}
  const finish=()=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({referer:req.headers.referer??'',path:req.url}));};
  if(req.url.startsWith('/slow')){const timer=setTimeout(()=>{timers.delete(timer);finish();},1000);timers.add(timer);}else finish();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const checks=[],errors=[];let reader;
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
await context.route('https://*.nodelane.net/**',route=>route.fulfill({status:503,body:'Isolated source acceptance'}));
await context.route('https://comix.to/**',route=>{
  const url=new URL(route.request().url()),chapter='/title/review-fixture/20-chapter-1';
  if(url.pathname.includes('/manga/'))return route.fulfill({json:{status:'ok',result:{items:[{id:20,number:1,mangaId:1,language:'en',isOfficial:true,url:chapter}],meta:{page:1,lastPage:1,total:1,hasNext:false}}}});
  if(url.pathname.includes('/chapters/'))return route.fulfill({json:{status:'ok',result:{id:20,number:1,url:chapter,pages:{items:[{url:'https://images.wowpic1.store/page.png',width:800,height:1200}]}}}});
  return route.fulfill({contentType:'text/html',body:'<script id="initial-data">'+JSON.stringify({queries:{'["manga","detail","review"]':{id:1,hid:'review',url:'/title/review-fixture',title:'来源边界测试'}}})+'</script>'});
});
// The adapter requires HTTPS; the local HTTP server separately verifies actual DNR headers.
await context.route('https://images.wowpic1.store/page.png',route=>route.fulfill({contentType:'image/png',body:png}));
try {
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const readerUrl=new URL('reader.html',worker.url()).href;reader=await context.newPage();await reader.goto(readerUrl);
  png=Buffer.from(await reader.evaluate(async()=>{const canvas=new OffscreenCanvas(800,1200),ctx=canvas.getContext('2d');ctx.fillStyle='#f8e5f0';ctx.fillRect(0,0,800,1200);ctx.fillStyle='#333';ctx.font='40px sans-serif';ctx.fillText('Source boundary fixture',50,200);return Array.from(new Uint8Array(await(await canvas.convertToBlob()).arrayBuffer()));}));
  await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN'})));await reader.reload();
  await reader.getByRole('button',{name:'漫画网站',exact:true}).click();
  await reader.getByLabel('通过链接添加漫画').fill('https://unsupported.example/book');
  await reader.getByRole('button',{name:'添加到书架',exact:true}).click();
  await reader.locator('.nc-site-link-import [role=alert]').waitFor();
  await reader.screenshot({path:path.join(out,'sites-error.png')});checks.push('Unsupported source stays in the shared directory with an actionable error');
  await reader.getByLabel('通过链接添加漫画').fill('https://comix.to/title/review-fixture');
  await reader.screenshot({path:path.join(out,'sites.png')});
  const pagesBefore=context.pages().length;
  await reader.getByRole('button',{name:'添加到书架',exact:true}).click();
  await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth===800,null,{timeout:30000});
  assert.equal(context.pages().length,pagesBefore);await reader.screenshot({path:path.join(out,'reader.png')});
  const record=await reader.evaluate(async()=>{
    const {catalog}=await import(chrome.runtime.getURL('verify-runtime.js'));
    const data=await chrome.storage.local.get(null),manifest=Object.values(data).find(v=>v?.adapter==='comix'&&v.items);
    return {manifestId:manifest.id,context:manifest.pageContext,accepted:(await catalog.list('catalogs'))[0].entries.length,shadows:Object.keys(data).filter(k=>k.startsWith('nc-source:'))};
  });assert.equal(record.context,undefined);assert.equal(record.accepted,1);assert.deepEqual(record.shadows,[]);
  checks.push('Link import uses library state, creates no source tab, and displays the authorized source image');
  await reader.goto(readerUrl+'?manifest='+record.manifestId);
  await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth===800);checks.push('Reopening the manifest restores a readable cached page');

  const second=await context.newPage();await second.goto(readerUrl);
  const read=(page,url,referer)=>page.evaluate(async({url,referer})=>{const {fetchSourceImage}=await import(chrome.runtime.getURL('verify-runtime.js'));return JSON.parse(await(await fetchSourceImage(url,undefined,referer?{referer}:undefined)).blob.text());},{url,referer});
  const shared=origin+'/slow?image=A%2BB';
  const results=await Promise.all([read(reader,shared,'https://source-a.test/'),read(second,shared,'https://source-b.test/'),read(reader,shared)]);
  assert.deepEqual(results.map(v=>v.referer),['https://source-a.test/','https://source-b.test/','']);
  checks.push('Same resource across extension pages serializes distinct Referers and a plain read');
  const a=read(reader,origin+'/slow?a=1','https://source-a.test/');
  const b=read(second,origin+'/slow?b=2','https://source-b.test/');
  assert.deepEqual((await Promise.all([a,b])).map(v=>v.referer),['https://source-a.test/','https://source-b.test/']);
  checks.push('Different resources on one host keep independent headers');
  const cancelled=await reader.evaluate(async origin=>{
    const {fetchSourceImage}=await import(chrome.runtime.getURL('verify-runtime.js')),controller=new AbortController();
    const pending=fetchSourceImage(origin+'/slow-abort',controller.signal,{referer:'https://source-a.test/'});
    setTimeout(()=>controller.abort(),80);try{await pending;return false;}catch{return controller.signal.aborted;}
  },origin);assert(cancelled);
  assert.deepEqual(await reader.evaluate(()=>chrome.declarativeNetRequest.getSessionRules()),[]);checks.push('Cancellation releases the request rule');
  let heldResolve;const started=new Promise(resolve=>{heldResolve=resolve;});held=heldResolve;
  const abandoned=read(second,origin+'/hold','https://source-a.test/').catch(()=>{});await started;
  await reader.evaluate(async()=>{const {recoverImageHeaders}=await import(chrome.runtime.getURL('verify-runtime.js'));await recoverImageHeaders();});
  assert.equal((await reader.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,1);
  await second.close();await abandoned;
  await reader.evaluate(async()=>{const {recoverImageHeaders}=await import(chrome.runtime.getURL('verify-runtime.js'));await recoverImageHeaders();});
  assert.deepEqual(await reader.evaluate(()=>chrome.declarativeNetRequest.getSessionRules()),[]);
  checks.push('Recovery preserves a live reader rule and removes it after the requester closes');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({out,checks,errors}));
} catch(error) {if(reader){console.log((await reader.locator('body').innerText()).slice(-1800));await reader.screenshot({path:path.join(out,'failure.png')});}throw error;}
finally {await context.close();for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
