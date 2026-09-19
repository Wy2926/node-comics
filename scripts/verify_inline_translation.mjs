// Isolated Chromium + built MV3 extension + synthetic API/images. No live provider or credentials.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const out=path.resolve('artifacts/inline-validation',randomUUID());await mkdir(out,{recursive:true});
const extension=path.join(out,'extension');await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(!manifest.host_permissions.includes('http://*/*'),'Broad source access must remain optional');
assert(!manifest.content_scripts.some(s=>s.js.includes('content-scripts/inline.js')),'No automatic page injection');
// The fixture grants optional origins without a native permission dialog. Dispatch the actual
// registered menu callback; only this temporary copy exposes its listener and installed menu titles.
manifest.host_permissions.push('http://*/*','https://*/*');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const background=path.join(extension,'background.js');
await writeFile(background,`chrome.permissions.request=permissions=>chrome.permissions.contains(permissions);globalThis.fixtureMenus=[];const originalMenuCreate=chrome.contextMenus.create.bind(chrome.contextMenus);chrome.contextMenus.create=(...a)=>{fixtureMenus.push(a[0]);return originalMenuCreate(...a)};const originalMenuListener=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=listener=>{globalThis.fixtureMenu=listener;return originalMenuListener(listener)};\n`+await readFile(background,'utf8'));
const requests=[],submissions=new Map(),jobs=new Map(),uploads=new Map(),images=new Map();
const mode='classic',language='zh-Hans',checks=[],errors=[];
const rights={plan:'free',queue_capacity:3,realtime_slots:3,modes:Object.fromEntries(['classic','redraw'].map(m=>[m,{allowed:true,unlimited:true,quota_kind:m==='classic'?'classic_unlimited':'redraw_grant',consent_version:'fixture',quota:null}]))};
const caps={modes:[{id:'classic',enabled:true,label:'常规翻译',languages:['zh-Hans','en']},{id:'redraw',enabled:true,label:'AI 重绘',languages:['zh-Hans','en']}],languages:[{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'}],limits:{max_bytes:41943040,max_pixels:60000000,max_dimension:20000,max_batch:3},entitlements:rights,retention_days:0};
let output,api,site,complete=true,version=0;
const sha=data=>createHash('sha256').update(data).digest('hex');
const refresh=()=>{for(const job of jobs.values())if(complete&&job.status==='queued'&&Date.now()-Date.parse(job.created_at)>700)Object.assign(job,{status:'succeeded',output_asset_id:'output-'+job.id,updated_at:new Date().toISOString()});};
const allQueues=()=>['classic','redraw'].map(mode=>{const active=[...jobs.values()].filter(j=>j.mode===mode&&['awaiting_upload','queued','running'].includes(j.status)).length;return {mode,capacity:3,in_flight:active,available_slots:3-active,realtime_limit:3,realtime_count:0,version,paused:false};});
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://fixture');let body;
    if(req.method==='POST'||req.method==='PUT'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=Buffer.concat(chunks);if(req.headers['content-type']?.includes('application/json'))body=JSON.parse(body);}
    const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data));};
    if(url.pathname.startsWith('/source/')){const source=images.get(parseInt(url.pathname.split('/')[2],10));res.writeHead(200,{'Content-Type':'image/png'});res.end(source);return;}
    if(url.pathname==='/result.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(output);return;}
    requests.push({method:req.method,path:url.pathname,authorization:!!req.headers.authorization});refresh();
    if(url.pathname==='/v1/auth/config')return json({dev_auth:true});
    if(url.pathname==='/v1/capabilities')return json(caps);
    if(url.pathname==='/v1/me/entitlements')return json(rights);
    if(url.pathname==='/v1/me/queues')return json({items:allQueues()});
    if(url.pathname.endsWith('/priority')){assert(Number.isSafeInteger(body.sequence)&&body.sequence>=0&&body.sequence<=2147483647,'priority sequence must fit the backend integer contract');return json({version:++version,realtime_job_ids:body.realtime_job_ids,expires_at:new Date(Date.now()+90000).toISOString()});}
    if(url.pathname==='/v1/me/translation-changes')return json({items:[...jobs.values()],deleted_job_ids:[],cursor:'fixture',has_more:false});
    if(url.pathname==='/v1/file-pages/match')return json({items:body.pages.map(source=>{const matching=[...jobs.values()].filter(j=>j.image_sha256===source.image_sha256&&j.mode===body.mode&&j.target_language===body.target_language);return {...source,asset:matching.length?{id:'original-'+source.image_sha256,width:800,height:1100,byte_size:images.get(1).length,mime:'image/png',sha256:source.image_sha256,expires_at:null}:null,jobs:matching};})});
    if(url.pathname==='/v1/translation-submissions'&&req.method==='POST'){
      const key=req.headers['idempotency-key'];if(submissions.has(key))return json(submissions.get(key));
      const receipt={id:randomUUID(),mode:body.mode,target_language:body.target_language,items:body.items.map(item=>{
        const id=randomUUID(),job={id,input_asset_id:'original-'+item.image_sha256,output_asset_id:null,mode:body.mode,target_language:body.target_language,status:'awaiting_upload',phase:'queued',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false,image_sha256:item.image_sha256,file_hash:item.file_hash,page_index:item.page_index};jobs.set(id,job);
        return {client_item_id:item.client_item_id,job,upload:{id,url:api+'/upload/'+id,method:'PUT',authorization_required:true,headers:{'Content-Type':'image/png'},expires_at:new Date(Date.now()+60000).toISOString()}};
      })};submissions.set(key,receipt);return json(receipt);
    }
    if(url.pathname.startsWith('/v1/translation-submissions/'))return json([...submissions.values()].find(r=>r.id===url.pathname.split('/').at(-1)));
    if(url.pathname.startsWith('/upload/')){uploads.set(url.pathname.split('/').at(-1),body);res.writeHead(200);res.end();return;}
    if(url.pathname.startsWith('/v1/uploads/')){const id=url.pathname.split('/')[3],job=jobs.get(id);assert.equal(sha(uploads.get(id)),job.image_sha256);job.status='queued';return json(job);}
    if(url.pathname.startsWith('/v1/images/'))return json({url:api+'/result.png',authorization_required:true,expires_at:null});
    return json({error:{message:'fixture missing '+url.pathname}},404);
  }catch(error){errors.push(error.message);res.writeHead(500);res.end('fixture failure');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));api=`http://127.0.0.1:${server.address().port}`;
const web=createServer((req,res)=>{
  if(req.url==='/strict')res.setHeader('Content-Security-Policy',`default-src 'self'; img-src ${api}; style-src 'unsafe-inline'; script-src 'none'; connect-src 'self';`);
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><html><head><title>网页漫画翻译验收</title><style>body{margin:0;background:#edf2f8;font:16px system-ui;color:#20304b}header{padding:16px 28px;background:white}main{width:min(600px,90vw);margin:auto}img.comic{display:block;width:100%;height:auto;margin:24px 0}button{padding:10px}footer{height:800px}#thumb{width:80px;height:110px}#banner{width:900px;height:120px}#hidden{display:none}#third{aspect-ratio:1/1;object-fit:cover}</style></head><body><header><b>原网站 · 漫画阅读页</b>　<button id=site-button>网站按钮</button><a id=site-link href=#bottom>原有链接</a></header><main><img id=thumb src=${api}/source/1.png><p>下方漫画完成后原位显示，链接和滚动应保持正常。</p><picture><source srcset="${api}/source/1.png"><img id=first class=comic src=${api}/source/1.png></picture><img id=second class=comic src=${api}/source/2.png><img id=third class=comic src=${api}/source/3.png><img id=lazy class=comic><img id=hidden class=comic src=${api}/source/4.png></main><footer id=bottom>原网站页尾</footer></body></html>`);
});await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));site=`http://127.0.0.1:${web.address().port}`;
const browser=await chromium.launchPersistentContext(path.join(out,'profile'),{channel:'chromium',headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
const worker=browser.serviceWorkers()[0]??await browser.waitForEvent('serviceworker');
const extensionId=new URL(worker.url()).hostname;
const check=message=>{checks.push(message);console.log('PASS '+message);};
let cdp=await browser.newCDPSession(page);
async function button(name){
  const {nodes}=await cdp.send('Accessibility.getFullAXTree');const node=nodes.find(n=>n.role?.value==='button'&&n.name?.value===name);assert(node,'missing button '+name);
  const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});const q=model.content;
  await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);
}
const activate=()=>worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url);await globalThis.fixtureMenu({menuItemId:'nc-translate-page',pageUrl:url},tab);},page.url());
const geometry=()=>page.locator('#first').evaluate(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height,src:i.getAttribute('src'),srcset:i.parentElement.querySelector('source').getAttribute('srcset'),scroll:scrollY,clicks:window.fixtureClicks??0}));
try{
  // Generate public synthetic test panels, deliberately changing output aspect ratio.
  await page.setContent('<body style="margin:0;width:800px;height:1100px;background:#fff5df;font:42px system-ui"><div style="margin:50px;border:6px solid #20304b;height:880px;padding:35px">Original comic panel<br><br>HELLO!<br><br>READ THE STORY</div></body>');
  const source=await page.screenshot({clip:{x:0,y:0,width:800,height:1100},captureBeyondViewport:true});
  for(let n=1;n<=6;n++)images.set(n,Buffer.concat([source,Buffer.from(`fixture-${n}`)]));
  await page.setContent('<body style="margin:0;width:900px;height:900px;background:#e3f3ff;font:42px system-ui"><div style="margin:50px;border:6px solid #224560;height:650px;padding:35px">译文效果示例<br><br>你好！<br><br>继续阅读故事</div></body>');
  output=await page.screenshot({clip:{x:0,y:0,width:900,height:900},captureBeyondViewport:true});
  const seed=(n,status)=>{const hash=sha(images.get(n)),id='seed-'+n;jobs.set(id,{id,input_asset_id:'original-'+hash,output_asset_id:status==='succeeded'?'output-'+id:null,mode,target_language:language,status,phase:'done',quota_pages:0,version:1,cache_hit:true,created_at:'2026-01-01',image_sha256:hash,file_hash:hash,page_index:0,...(status==='failed'?{error:{message:'示例翻译失败',code:'FIXTURE_FAILED'}}:{})});};seed(1,'succeeded');seed(3,'failed');
  await worker.evaluate(async api=>{await chrome.storage.local.set({'nc-reader-settings':{apiBase:api,language:'zh-Hans',translationMode:'classic',requestConcurrency:2},'nc-reader-session':{token:'isolated-fixture',user:{id:'fixture-reader',name:'Fixture',role:'reader'},apiOrigin:api}});},api);
  await page.goto(site);await page.locator('#first').evaluate(i=>i.decode());await page.evaluate(()=>{window.fixtureClicks=0;document.querySelector('#site-button').addEventListener('click',()=>window.fixtureClicks++);});
  const before=await geometry();assert.equal(await page.locator('#first').evaluate(i=>i.style.content),'');
  const menus=await worker.evaluate(()=>fixtureMenus);assert(menus.some(m=>m.id==='nc-translate-page'&&m.title==='翻译当前页面'));check('build registers page menu and does not inject on its own');
  await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:20000});
  assert.deepEqual(await geometry(),before);assert.equal(await page.locator('#thumb').evaluate(i=>i.style.content),'');assert.equal(await page.locator('#hidden').evaluate(i=>i.style.content),'');
  check('existing result replaces picture visually with unchanged geometry, src, srcset and scroll; thumbnail/hidden image excluded');
  await page.locator('#site-button').click();assert.equal((await geometry()).clicks,1);check('original website button remains clickable');
  await page.screenshot({path:path.join(out,'translated-desktop.png')});
  await page.waitForFunction(()=>document.querySelector('#second').style.content.includes('blob:'),{},{timeout:15000});assert.equal(submissions.size,1);assert.equal(uploads.size,1);check('next page submits, uploads verified bytes and displays completion; failed page does not loop');
  await activate();await page.waitForTimeout(900);assert.equal(submissions.size,1);check('repeated page activation creates no duplicate submissions');
  await button('恢复原图');await page.waitForFunction(()=>document.querySelector('#first').style.content==='');assert.equal(await page.locator('#first').getAttribute('width'),null);assert.equal(await page.locator('#first').getAttribute('height'),null);check('restore originals removes only extension-owned changes');
  await button('显示译图');await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'));
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);const mobile=await geometry();assert.equal(Math.round(mobile.width),351);assert(Math.abs(mobile.height-mobile.width*before.height/before.width)<1,JSON.stringify({before,mobile}));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'translated-mobile.png')});check('responsive page keeps original aspect ratio at 390px');
  await page.setViewportSize({width:1280,height:900});await page.locator('#third').scrollIntoViewIfNeeded();await page.waitForTimeout(700);await page.screenshot({path:path.join(out,'failed-page.png')});const thirdBefore=await page.locator('#third').evaluate(i=>({width:i.clientWidth,height:i.clientHeight}));await button('翻译失败 · 重试');await page.waitForFunction(()=>document.querySelector('#third').style.content.includes('blob:'),{},{timeout:18000});assert.equal(submissions.size,2);assert.deepEqual(await page.locator('#third').evaluate(i=>({width:i.clientWidth,height:i.clientHeight})),thirdBefore);check('individual failed image retries explicitly without blocking neighbours');
  await button('暂停');const count=submissions.size;await page.locator('#lazy').evaluate((i,url)=>i.src=url,api+'/source/4.png');await page.locator('#lazy').scrollIntoViewIfNeeded();await page.waitForTimeout(1200);assert.equal(submissions.size,count);await button('继续');await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:18000});check('pause stops new work; resuming discovers lazy-loaded images');
  await page.locator('#lazy').evaluate((i,url)=>i.src=url,api+'/source/5.png');await page.waitForFunction(()=>document.querySelector('#lazy').style.content==='');await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:18000});check('site-owned source change removes stale translation and translates the new image');
  await page.locator('#lazy').evaluate((i,bytes)=>i.src=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/png'})),[...images.get(6)]);await page.waitForFunction(()=>document.querySelector('#lazy').style.content==='');await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:18000});check('page-owned blob images are read in the content script without exposing credentials');
  await worker.evaluate(async()=>{await chrome.storage.local.set({'nc-reader-session':null});});await page.waitForFunction(()=>document.querySelector('#first').style.content==='');await page.waitForTimeout(800);assert.equal(await page.locator('#lazy').evaluate(i=>i.style.content),'');await page.screenshot({path:path.join(out,'logged-out.png')});check('logout immediately restores every image and stops authenticated work');
  await button('关闭');assert.equal(await page.locator('#lazy').evaluate(i=>i.style.content),'');
  await worker.evaluate(async api=>{await chrome.storage.local.set({'nc-reader-session':{token:'isolated-fixture',user:{id:'fixture-reader',name:'Fixture',role:'reader'},apiOrigin:api}});},api);
  await page.goto(site+'/strict');await activate();await page.waitForTimeout(6000);await page.screenshot({path:path.join(out,'strict-csp.png')});
  assert((await page.locator('#first').evaluate(i=>i.style.content)).includes('blob:'));check('strict-CSP page displays decoded translation with isolated controls');
  await page.goto(site);await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'));
  await page.evaluate(()=>{history.pushState({},'','/next-chapter');document.querySelector('#first').src+='?new';});
  await page.waitForFunction(()=>document.querySelector('#first').style.content==='');await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:15000});check('same-document navigation stops the old session and can be activated again');
  const reader=await browser.newPage();reader.on('pageerror',e=>errors.push(e.message));await reader.goto(`chrome-extension://${extensionId}/reader.html#settings`);await reader.getByLabel('默认目标语言').waitFor();
  assert.equal(await reader.getByLabel('默认目标语言').inputValue(),'zh-Hans');
  jobs.set('seed-en',{...jobs.get('seed-1'),id:'seed-en',target_language:'en'});
  await reader.getByLabel('默认目标语言').selectOption('en');await page.waitForFunction(()=>document.querySelector('#first').style.content==='');await page.bringToFront();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:15000});check('reader UI shares language and login settings with in-page translation');
  // Content scripts may not access the mirrored login session.
  const security=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url);return chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try{await chrome.storage.local.get('nc-reader-session');return false;}catch{return true;}}});},page.url());assert.equal(security[0].result,true);check('credential storage is restricted to trusted extension contexts');
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,submissions:submissions.size,uploads:uploads.size,liveProvider:false,nativeMenuDialog:false,extensionId},null,2));
  console.log('Artifacts: '+out);
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,requests},null,2));console.error('Artifacts: '+out);throw error;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>web.close(resolve));}
