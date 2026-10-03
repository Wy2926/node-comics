// Isolated Chromium + built MV3 extension + synthetic API/images. No live provider or credentials.
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {probeImageMetadata} from '../backend/shared/translation-images/image-metadata.ts';
const sitesDirectory=path.resolve('apps/extension/src/sources/sites');
const siteChecks=[];
for(const site of await readdir(sitesDirectory,{withFileTypes:true})) {
  if(!site.isDirectory())continue;
  const tests=path.join(sitesDirectory,site.name,'tests');
  const files=await readdir(tests).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(files.includes('verify-inline.mjs'))siteChecks.push({id:site.name,url:pathToFileURL(path.join(tests,'verify-inline.mjs')).href});
}
const selectedSite=process.env.INLINE_SITE_ONLY;
assert(!selectedSite||['generic','feedback','prefetch','window'].includes(selectedSite)||siteChecks.some(site=>site.id===selectedSite),'Unknown INLINE_SITE_ONLY');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const out=path.resolve('artifacts/inline-validation',randomUUID());await mkdir(out,{recursive:true});
const extension=path.join(out,'extension');await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(manifest.host_permissions.includes('http://*/*')&&manifest.host_permissions.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
assert(!(manifest.content_scripts??[]).some(s=>s.js.includes('content-scripts/inline.js')),'No automatic page injection');
// Dispatch the actual registered menu callback. Only this temporary copy exposes its listener
// and installed menu titles; required host access must never cause a runtime permission request.
const background=path.join(extension,'background.js');
await writeFile(background,`globalThis.fixturePermissionRequests=0;chrome.permissions.request=()=>{globalThis.fixturePermissionRequests++;throw Error('Unexpected host permission request')};globalThis.fixtureMenus=[];const originalMenuCreate=chrome.contextMenus.create.bind(chrome.contextMenus);chrome.contextMenus.create=(...a)=>{fixtureMenus.push(a[0]);return originalMenuCreate(...a)};const originalMenuListener=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=listener=>{globalThis.fixtureMenu=listener;return originalMenuListener(listener)};\n`+await readFile(background,'utf8'));
await writeFile(background,`globalThis.fixtureTransfers={maxMessageBytes:0,resultChunks:0,sourceChunks:0};const observeChunk=(v,kind)=>{if(v?.type==='chunk'){fixtureTransfers.maxMessageBytes=Math.max(fixtureTransfers.maxMessageBytes,JSON.stringify(v).length);fixtureTransfers[kind]++;}};const connectListener=chrome.runtime.onConnect.addListener.bind(chrome.runtime.onConnect);chrome.runtime.onConnect.addListener=fn=>connectListener(port=>{const post=port.postMessage.bind(port);port.postMessage=v=>{observeChunk(v,'resultChunks');post(v)};fn(port)});const connectTab=chrome.tabs.connect.bind(chrome.tabs);chrome.tabs.connect=(...args)=>{const port=connectTab(...args);port.onMessage.addListener(v=>observeChunk(v,'sourceChunks'));return port};\n`+await readFile(background,'utf8'));
const requests=[],sourceRequests=[],translations=new Map(),jobs=new Map(),uploads=new Map(),images=new Map();let createdJobs=0;
const mode='classic',language='zh-Hans',checks=[],errors=[];
const rights={plan:'free',image_rate_limit:{window_seconds:60,limit:10},timezone:'Asia/Shanghai',plus_started_at:null,plus_expires_at:null,pending_previous_period_pages:0,modes:Object.fromEntries(['classic'].map(m=>[m,{allowed:true,unlimited:true,quota_kind:'classic_unlimited',consent_version:'fixture',quota:null}]))};
const caps={result_protocol:'overlay-v1',modes:[{id:'classic',enabled:true,label:'常规翻译',languages:['zh-Hans','en']}],languages:[{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'}],limits:{max_bytes:41943040,max_pixels:60000000,max_dimension:20000},entitlements:rights};
let output,api,site,complete=true;
let liveWindowSource=false;
const resultRequests=[];
const eventStreams=new Set();
let heldResult,releaseResult,failResult;
let preparationGate,releasePreparation;
const accessCount=()=>requests.filter(r=>r.path.startsWith('/v1/images/')&&r.path.endsWith('/access')).length;
const sha=data=>createHash('sha256').update(data).digest('hex');
const refresh=()=>{for(const job of jobs.values())if(complete&&job.status==='queued'&&Date.now()-Date.parse(job.created_at)>700)Object.assign(job,{status:'succeeded',output_asset_id:'output-'+job.id,updated_at:new Date().toISOString()});};
const translationResult=id=>{
  const entry=translations.get(id);if(!entry)return;
  const job=jobs.get(entry.jobId),state=job.status==='awaiting_upload'?'needs_input':job.status;
  return {id,state,mode:job.mode,target_language:job.target_language,image_sha256:job.image_sha256,
    created_at:job.created_at,updated_at:job.updated_at??job.created_at,
    result:state==='succeeded'?{kind:'translated',representation:'overlay-v1',input_sha256:job.image_sha256,normalization_version:1,width:job.width??800,height:job.height??1100,bbox:{x:40,y:40,width:512,height:192},composite:'source-atop',artifact:{sha256:sha(output),byte_size:output.length,mime:'image/webp',path:'/v1/translations/'+id+'/result'}}:null,
    error:state==='failed'?{code:'FIXTURE_FAILED',message:'示例翻译失败'}:null};
};
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://fixture');let body;
    if(req.method==='POST'||req.method==='PUT'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=Buffer.concat(chunks);if(req.headers['content-type']?.includes('application/json'))body=JSON.parse(body);}
    const json=(data,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*',...headers});res.end(JSON.stringify(data));};
    if(url.pathname.startsWith('/source/')){
      sourceRequests.push({path:url.pathname,referer:req.headers.referer??null});
      if(req.headers.referer!==site+'/'){res.writeHead(403,{'Cache-Control':'no-store'});res.end();return;}
      await preparationGate;
      const source=images.get(parseInt(url.pathname.split('/')[2],10));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(source);return;
    }
    if(/^\/v1\/translations\/[^/]+\/result$/.test(url.pathname)){
      assert(req.headers.authorization,'result requires bearer authentication');
      const entry=translations.get(url.pathname.split('/')[3]),id='output-'+entry.jobId;resultRequests.push(id);
      if(id===heldResult)await new Promise(resolve=>{releaseResult=resolve;});
      if(id===failResult){failResult=undefined;res.writeHead(503);res.end();return;}
      res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-store'});res.end(output);return;
    }
    requests.push({method:req.method,path:url.pathname,authorization:!!req.headers.authorization});refresh();
    if(url.pathname==='/v1/auth/config')return json({dev_auth:true});
    if(url.pathname==='/v1/capabilities'){await preparationGate;return json(caps);}
    if(url.pathname==='/v1/me/entitlements')return json(rights);
    if(url.pathname==='/v1/translations/events'&&req.method==='GET'){
      const ids=(url.searchParams.get('ids')??'').split(',').filter(Boolean);let previous='';
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
      eventStreams.add(res);
      const update=()=>{
        refresh();const items=ids.map(translationResult).filter(Boolean),data=JSON.stringify({items,missing_ids:ids.filter(id=>!translations.has(id))});
        if(data!==previous){previous=data;res.write('event: snapshot\ndata: '+data+'\n\n');}
        if(items.every(item=>['succeeded','failed'].includes(item.state))){res.end('event: end\ndata: {"reason":"complete"}\n\n');}
      };
      const timer=setInterval(update,50);res.on('close',()=>{clearInterval(timer);eventStreams.delete(res);});update();return;
    }
    if(url.pathname==='/v1/translations'&&req.method==='GET'){
      const ids=(url.searchParams.get('ids')??'').split(',').filter(Boolean);
      const items=ids.map(translationResult).filter(Boolean),value={items,missing_ids:ids.filter(id=>!translations.has(id))},etag='"'+sha(JSON.stringify(value))+'"';
      if(req.headers['if-none-match']!==etag)return json(value,200,{ETag:etag});
      res.writeHead(304,{ETag:etag});res.end();return;
    }
    const route=url.pathname.match(/^\/v1\/translations\/([a-f0-9-]{36})(\/input)?$/);
    if(route){
      const [,id,input]=route;
      if(input&&req.method==='PUT'){
        const entry=translations.get(id);assert(entry,'input requires an accepted request');const job=jobs.get(entry.jobId);
        assert.equal(sha(body),job.image_sha256);uploads.set(id,body);const size=await probeImageMetadata(new Blob([body]));assert(size,'input has valid image dimensions');job.width=size.width;job.height=size.height;
        if(job.status==='awaiting_upload')Object.assign(job,{status:'queued',updated_at:new Date().toISOString()});
        return json(translationResult(id),202);
      }
      if(req.method==='GET')return translations.has(id)?json(translationResult(id)):json({error:{code:'NOT_FOUND'}},404);
      if(req.method==='PUT'){
        assert.equal(req.headers['x-translation-protocol'],'overlay-v1');
        const {priority,...intent}=body,fingerprint=sha(JSON.stringify(intent));
        if(translations.has(id)){assert.equal(translations.get(id).fingerprint,fingerprint);return json(translationResult(id));}
        const previousId=body.retry_of??body.regenerate_of,previous=previousId&&translations.get(previousId),source=previous&&jobs.get(previous.jobId);
        if(previousId)assert(source,'explicit generation must reference a translation owned by the reader');
        const image=body.image??{sha256:source.image_sha256},requestedMode=body.mode??source.mode,requestedLanguage=body.target_language??source.target_language;
        let job=!previousId&&[...jobs.values()].filter(j=>j.image_sha256===image.sha256&&j.mode===requestedMode&&j.target_language===requestedLanguage).at(-1);
        if(!job){const jobId=randomUUID();job={id:jobId,input_asset_id:'original-'+image.sha256,output_asset_id:null,mode:requestedMode,target_language:requestedLanguage,status:source?'queued':'awaiting_upload',width:source?.width,height:source?.height,created_at:new Date().toISOString(),image_sha256:image.sha256};jobs.set(jobId,job);createdJobs++;}
        translations.set(id,{jobId:job.id,fingerprint});return json(translationResult(id),job.status==='succeeded'?200:202);
      }
    }
    return json({error:{message:'fixture missing '+url.pathname}},404);
  }catch(error){errors.push(error.message);res.writeHead(500);res.end('fixture failure');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));api=`http://127.0.0.1:${server.address().port}`;
// Redirect the build-time service only inside the isolated fixture copy.
for(const file of await readdir(extension,{recursive:true}))if(file.endsWith('.js')){const target=path.join(extension,file),source=await readFile(target,'utf8');await writeFile(target,source.replaceAll(process.env.INLINE_BUILD_API||'https://comics.nodelane.net',api));}
const web=createServer((req,res)=>{
  if(req.url==='/sliced'){
    res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><title>Sliced reading surface</title>
      <style>body{margin:0;background:#edf2f8}main{height:810px;overflow:hidden;position:relative}.sheet{position:absolute;top:0;width:500px;height:810px}img{display:block;width:500px;height:270px}nav{position:fixed;bottom:8px;left:16px}button{padding:8px}</style>
      <main>${Array.from({length:8},(_,p)=>`<section class="sheet" id="sheet-${p}" style="left:${p<2?p*500:-1500-p*500}px">${Array.from({length:3},(_,n)=>`<img id="slice-${p*3+n+22}" src="${api}/source/${p*3+n+22}.png">`).join('')}</section>`).join('')}</main>
      <nav><button id="forward">Next spread</button><button id="back">Previous spread</button></nav>
      <script>window.turn=pair=>{for(const p of document.querySelectorAll('.sheet')){const id=Number(p.id.split('-')[1]);p.style.left=(id===pair?0:id===pair+1?500:id<pair?1500+id*500:-1500-id*500)+'px';}for(const id of [pair+1,pair])document.querySelector('main').append(document.querySelector('#sheet-'+id));};document.querySelector('#forward').onclick=()=>turn(2);document.querySelector('#back').onclick=()=>turn(0);</script>`);return;
  }
  if(req.url==='/generic-canvas'){
    res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><title>Generic canvas fixture</title>
      <style>body{margin:0;background:#edf2f8}main{display:flex;gap:16px;padding:16px}.slot{position:relative;width:400px;height:550px;flex:none}canvas{width:400px;height:550px}#small{width:40px;height:55px}#offscreen{position:absolute;left:-2000px}</style>
      <main>${['ready','lazy','tainted'].map(id=>'<div class="slot"><canvas id="'+id+'" width="800" height="1100"></canvas></div>').join('')}</main>
      <canvas id="small" width="800" height="1100"></canvas><canvas id="offscreen" width="800" height="1100"></canvas>
      <script>window.drawFixture=(c,n=0)=>{const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle=['#20304b','#983844','#487030'][n];x.font='90px sans-serif';x.fillText('Original '+n,50,250);x.fillRect(40,500,600,100);};drawFixture(document.querySelector('#ready'));drawFixture(document.querySelector('#small'));drawFixture(document.querySelector('#offscreen'));
      const foreign=new Image();foreign.onload=()=>document.querySelector('#tainted').getContext('2d').drawImage(foreign,0,0,800,1100);foreign.src='https://canvas-fixture-cdn.test/image.png';document.querySelector('#ready').onclick=()=>document.body.dataset.clicked='yes';</script>`);return;
  }
  if(req.url.startsWith('/rolling')){
    const parameters=new URL(req.url,'http://fixture').searchParams,height=parameters.has('long')?3000:825,first=parameters.has('short')?15:7;
    res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><title>滚动预翻译验收</title><style>body{margin:0;background:#edf2f8}img{display:block;width:600px;height:${height}px;margin:24px auto}</style>${Array.from({length:7},(_,n)=>`<img id="rolling-${n+1}" src="${api}/source/${n+first}.png">`).join('')}`);return;
  }
  if(req.url==='/strict')res.setHeader('Content-Security-Policy',`default-src 'self'; img-src ${api}; style-src 'unsafe-inline'; script-src 'none'; connect-src 'self';`);
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><html><head><title>网页漫画翻译验收</title><style>body{margin:0;background:#edf2f8;font:16px system-ui;color:#20304b}header{padding:16px 28px;background:white}main{width:min(600px,90vw);margin:auto}img.comic{display:block;width:100%;height:auto;margin:24px 0}button{padding:10px}footer{height:800px}#thumb{width:80px;height:110px}#banner{width:900px;height:120px}#hidden{display:none}#third{aspect-ratio:1/1;object-fit:cover}</style></head><body><header><b>原网站 · 漫画阅读页</b>　<button id=site-button>网站按钮</button><a id=site-link href=#bottom>原有链接</a></header><main><img id=thumb src=${api}/source/1.png><p>下方漫画完成后原位显示，链接和滚动应保持正常。</p><picture><source srcset="${api}/source/1.png"><img id=first class=comic src=${api}/source/1.png></picture><img id=second class=comic src=${api}/source/2.png><img id=third class=comic src=${api}/source/3.png><img id=lazy class=comic><img id=hidden class=comic src=${api}/source/4.png></main><footer id=bottom>原网站页尾</footer></body></html>`);
});await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));site=`http://127.0.0.1:${web.address().port}`;
const browser=await chromium.launchPersistentContext(path.join(out,'profile'),{channel:'chromium',headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
let permissionRequests=0;
await browser.exposeBinding('fixturePermissionRequest',()=>{permissionRequests++;});
await browser.addInitScript(()=>{if(location.protocol==='chrome-extension:')chrome.permissions.request=()=>{void window.fixturePermissionRequest();throw Error('Unexpected host permission request');};});
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
  // Generate public synthetic test panels plus one compact overlay used at native page coordinates.
  await page.setContent('<body style="margin:0;width:800px;height:1100px;background:#fff5df;font:42px system-ui"><div style="margin:50px;border:6px solid #20304b;height:880px;padding:35px">Original comic panel<br><br>HELLO!<br><br>READ THE STORY</div></body>');
  const source=await page.screenshot({clip:{x:0,y:0,width:800,height:1100},captureBeyondViewport:true});
  console.log(`Fixture input ${source.readUInt32BE(16)}x${source.readUInt32BE(20)}`);
  for(let n=1;n<=45;n++)images.set(n,Buffer.concat([source,Buffer.from(`fixture-${n}`)]));
  output=Buffer.from(await page.evaluate(async()=>{const canvas=new OffscreenCanvas(512,192),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,512,192);ctx.fillStyle='#224560';ctx.font='42px system-ui';ctx.fillText('你好！继续阅读故事',24,96);return [...new Uint8Array(await(await canvas.convertToBlob({type:'image/webp',quality:1})).arrayBuffer())];}));
  const seed=(n,status)=>{const hash=sha(images.get(n)),id='seed-'+n;jobs.set(id,{id,width:images.get(n).readUInt32BE(16),height:images.get(n).readUInt32BE(20),input_asset_id:'original-'+hash,output_asset_id:status==='succeeded'?'output-'+id:null,mode,target_language:language,status,phase:'done',quota_pages:0,version:1,cache_hit:true,result_available:status==='succeeded',result_expired:false,created_at:'2026-01-01T00:00:00Z',image_sha256:hash,file_hash:hash,page_index:0,...(status==='failed'?{error:{message:'示例翻译失败',code:'FIXTURE_FAILED'}}:{})});};seed(1,'succeeded');seed(3,'failed');
  await worker.evaluate(async api=>{await chrome.storage.local.set({'nc-reader-settings':{apiBase:api,autoTranslateTabs:false,language:'zh-Hans',requestConcurrency:2},'nc-auth':{session:{id:'fixture-session',token:'isolated-fixture',expiresAt:Date.now()+3600000,refreshAt:Date.now()+3500000,credential:{kind:'development'},user:{id:'fixture-reader',name:'Fixture',role:'reader'},apiOrigin:api}}});},api);
  if(selectedSite==='feedback') {
    const notice=async text=>(await cdp.send('Accessibility.getFullAXTree')).nodes.some(node=>node.role?.value==='StaticText'&&node.name?.value===text);
    const waitNotice=async(text,visible=true)=>{
      const until=Date.now()+10000;
      while(await notice(text)!==visible&&Date.now()<until)await page.waitForTimeout(25);
      assert.equal(await notice(text),visible,`notice ${text} visible=${visible}`);
    };
    const holdPreparation=()=>{preparationGate=new Promise(resolve=>{releasePreparation=resolve;});};
    const finishPreparation=()=>{releasePreparation();preparationGate=undefined;releasePreparation=undefined;};
    jobs.get('seed-1').status='no_text';
    await page.goto(site);await page.locator('#first').evaluate(image=>image.decode());
    const before=await geometry();holdPreparation();
    const started=Date.now();await activate();await waitNotice('准备翻译…');
    const feedbackMs=Date.now()-started;
    assert.equal(translations.size,0);assert.deepEqual(await geometry(),before);
    await page.screenshot({path:path.join(out,'preparing-translation.png')});
    check(`visible image gets preparation feedback before the held capabilities response (${feedbackMs} ms including activation and observation), without layout or scroll changes`);
    await button('暂停');await waitNotice('准备翻译…',false);
    await button('继续');await waitNotice('准备翻译…');
    await button('恢复原图');await waitNotice('准备翻译…',false);
    await button('显示译图');await waitNotice('准备翻译…');
    assert.equal(translations.size,0);
    check('pause and original view hide preparation feedback; resuming restores it without bypassing pending preparation');
    finishPreparation();await waitNotice('准备翻译…',false);
    assert.equal(await page.locator('#first').evaluate(image=>image.style.content),'');
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForTimeout(200);
    assert.equal(await notice('准备翻译…'),false);
    check('a no-text response clears preparation and rescanning does not resurrect it');
    await page.waitForFunction(()=>document.querySelector('#second').style.content.includes('blob:'),null,{timeout:15000});
    await page.locator('#second').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
    assert.equal(await notice('准备翻译…'),false);
    await page.locator('#third').scrollIntoViewIfNeeded();await waitNotice('翻译失败 · 重试');
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForTimeout(200);
    assert.equal(await notice('准备翻译…'),false);assert.equal(await notice('翻译失败 · 重试'),true);
    await page.screenshot({path:path.join(out,'preparation-replaced-by-error.png')});
    await page.locator('#first').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
    assert.equal(await notice('准备翻译…'),false);
    assert.equal((await geometry()).height,before.height);assert.equal(createdJobs,1);
    check('completed, failed and no-text images keep their actual states across scrolling; only the uncached second image creates a job');
    holdPreparation();
    await worker.evaluate(async()=>{
      const saved=(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings'];
      await chrome.storage.local.set({'nc-reader-settings':{...saved,language:'en'}});
    });
    await waitNotice('准备翻译…');
    await page.screenshot({path:path.join(out,'preparing-new-language.png')});
    check('changing translation language immediately restores preparation feedback while source reads are held, even with cached channel capabilities');
    await button('关闭');await waitNotice('准备翻译…',false);finishPreparation();
    await page.waitForTimeout(500);assert.equal(await notice('准备翻译…'),false);assert.equal(createdJobs,1);
    check('closing during preparation removes feedback and ignores the late response without submitting another job');
  }
  if(selectedSite==='prefetch'){
    complete=false;await page.goto(site+'/rolling?long');await page.locator('#rolling-1').evaluate(i=>i.decode());await activate();
    const hasJob=n=>[...jobs.values()].some(j=>j.image_sha256===sha(images.get(n)));
    const waitJob=async n=>{const until=Date.now()+15000;while(!hasJob(n)&&Date.now()<until)await page.waitForTimeout(25);assert(hasJob(n),'missing page '+n);};
    await waitJob(10);assert(!hasJob(11));
    for(const current of [1,2]){
      await page.locator('#rolling-'+current).evaluate(i=>window.scrollTo(0,i.offsetTop+i.clientHeight/3-4));
      await page.waitForTimeout(300);assert(!hasJob(current+10));
      const started=Date.now();await page.locator('#rolling-'+current).evaluate(i=>window.scrollTo(0,i.offsetTop+i.clientHeight/3+4));
      await waitJob(current+10);assert(Date.now()-started<1000);
      assert(await page.locator('#rolling-'+current).evaluate(i=>i.getBoundingClientRect().top<0&&i.getBoundingClientRect().bottom>innerHeight));
      await page.waitForTimeout(300);assert(!hasJob(current+11));
      await page.locator('#rolling-'+current).evaluate(i=>window.scrollTo(0,i.offsetTop+i.clientHeight/3-4));
      await page.waitForTimeout(100);
    }
    assert.equal(createdJobs,6);check('one-third scrolling admits exactly one extra page per current image in under one second, before any earlier job completes');
    await page.screenshot({path:path.join(out,'rolling-prefetch.png')});
    await page.goto(site+'/rolling?short');await page.locator('#rolling-1').evaluate(i=>i.decode());await activate();
    await waitJob(19);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>scrollY),0);assert(!hasJob(20));
    check('a short image fills its fifth slot without scrolling, and does not recursively expand the chapter');
    await button('暂停');await page.locator('#rolling-3').scrollIntoViewIfNeeded();await page.waitForTimeout(300);assert(!hasJob(20));
    await button('继续');await waitJob(20);assert(!hasJob(21));
    check('pause suppresses expansion; resume prioritizes the still-visible previous-page sliver within the bounded lookahead');
  }
  if(selectedSite==='window'){
    const hasJob=n=>[...jobs.values()].find(j=>j.image_sha256===sha(images.get(n)));
    const waitUntil=async(condition,message)=>{const until=Date.now()+20000;while(!condition()&&Date.now()<until)await page.waitForTimeout(25);assert(condition(),message);};
    const finish=job=>Object.assign(job,{status:'succeeded',updated_at:new Date().toISOString()});
    const shown=async(first,count)=>page.waitForFunction(({first,count})=>Array.from({length:count},(_,n)=>document.querySelector('#slice-'+(first+n))).every(i=>i.style.content.includes('blob:')),{first,count},{timeout:25000});
    const beforeWindowJobs=createdJobs;
    complete=false;await page.goto(site+'/sliced');await page.locator('#slice-22').evaluate(i=>i.decode());await activate();
    await waitUntil(()=>[22,23,25,26,27].every(n=>hasJob(n)?.status==='queued'),'first bounded slice batch was uploaded');
    assert(!hasJob(24),'sixth slice waits for a batch slot');
    for(const n of [22,23,26,27])finish(hasJob(n));
    await waitUntil(()=>hasJob(24)?.status==='queued','sixth visible slice fills a freed slot while its peer is still pending');finish(hasJob(24));
    await page.waitForFunction(()=>[22,23,24,26,27].every(n=>document.querySelector('#slice-'+n).style.content.includes('blob:')),null,{timeout:20000});
    assert.equal(hasJob(25).status,'queued');finish(hasJob(25));await shown(22,6);
    assert.equal(createdJobs-beforeWindowJobs,6,'only the visible slices were translated');
    await page.screenshot({path:path.join(out,'sliced-both-pages.png')});
    check('six interleaved visible slices display completely through five-image batches; a slow peer does not block the remaining slices');
    const original=await page.locator('#slice-22').evaluate(i=>({src:i.src,width:i.clientWidth,height:i.clientHeight}));
    await button('暂停');await page.locator('#forward').click();await page.waitForTimeout(400);
    assert.equal(createdJobs-beforeWindowJobs,6);complete=true;await button('继续');await shown(28,6);
    assert.equal(createdJobs-beforeWindowJobs,12);const downloads=resultRequests.length;
    await page.locator('#back').click();await shown(22,6);await page.waitForTimeout(300);
    assert.equal(createdJobs-beforeWindowJobs,12);assert.equal(resultRequests.length,downloads);
    assert.deepEqual(await page.locator('#slice-22').evaluate(i=>({src:i.src,width:i.clientWidth,height:i.clientHeight})),original);
    await page.screenshot({path:path.join(out,'sliced-reverse-restored.png')});
    check('pause, next spread and reverse DOM reordering preserve both pages, geometry and cached results without another job or image download');
    await button('恢复原图');assert.equal(await page.locator('#slice-22').evaluate(i=>i.style.content),'');
    await button('显示译图');await shown(22,6);assert.equal(createdJobs-beforeWindowJobs,12);assert.equal(resultRequests.length,downloads);
    await button('关闭');
    check('original/translation toggles restore all six slices without changing source attributes or re-translating');
    if(process.env.INLINE_LIVE_URL){
      // Public source rendering only. This isolated extension sends pixels to the local fixture, never a real provider.
      const visible=()=>[...document.querySelectorAll('img:not([data-nc-canvas-translation])')].filter(i=>{
        const r=i.getBoundingClientRect();return i.complete&&i.naturalWidth>=80&&i.naturalHeight>=80&&
          i.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>=240&&r.height>=180&&r.width*r.height>=100000&&r.width/r.height<=2.8&&
          r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight;
      }).map(i=>({source:i.currentSrc||i.src,translated:i.style.content.includes('blob:')}));
      const current=()=>page.evaluate(visible);
      const translated=async minimum=>{const until=Date.now()+45000;let values;
        do{values=await current();if(values.length>=minimum&&values.every(i=>i.translated))return;await page.waitForTimeout(100);}while(Date.now()<until);
        assert.fail(`live visible translations: ${values.filter(i=>i.translated).length}/${values.length}, expected at least ${minimum}`);
      };
      const turn=async key=>{const before=JSON.stringify((await current()).map(i=>i.source).sort());await page.keyboard.press(key);
        const until=Date.now()+15000;while(JSON.stringify((await current()).map(i=>i.source).sort())===before&&Date.now()<until)await page.waitForTimeout(100);
        assert.notEqual(JSON.stringify((await current()).map(i=>i.source).sort()),before,'visible sources changed after paging');
      };
      await page.goto(process.env.INLINE_LIVE_URL);await activate();await translated(3);
      await turn('ArrowLeft');await translated(6);await page.screenshot({path:path.join(out,'generic-live-forward-spread.png')});
      await turn('ArrowLeft');await translated(6);
      const liveJobs=createdJobs,liveDownloads=resultRequests.length;
      await turn('ArrowRight');await translated(6);assert.equal(createdJobs,liveJobs);assert.equal(resultRequests.length,liveDownloads);
      await page.screenshot({path:path.join(out,'generic-live-reverse-spread.png')});
      await button('恢复原图');assert((await current()).every(i=>!i.translated));
      await button('显示译图');await translated(6);assert.equal(createdJobs,liveJobs);assert.equal(resultRequests.length,liveDownloads);
      await button('关闭');liveWindowSource=true;
      check('live generic source displays all visible slices in both paging directions and reuses cached local-fixture results; no live provider used');
    }
  }
  if(!selectedSite) {
  await page.goto(site);await page.locator('#first').evaluate(i=>i.decode());await page.evaluate(()=>{window.fixtureClicks=0;document.querySelector('#site-button').addEventListener('click',()=>window.fixtureClicks++);});
  const before=await geometry();assert.equal(await page.locator('#first').evaluate(i=>i.style.content),'');
  const menus=await worker.evaluate(()=>fixtureMenus);assert(menus.some(m=>m.id==='nc-translate-page'&&m.title==='翻译当前页面'));check('build registers page menu and does not inject on its own');
  await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:20000});
  assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings'].autoTranslateTabs),false);
  check('manual menu activation uses installed host access with automatic tabs explicitly disabled');
  assert(sourceRequests.every(request=>request.referer===site+'/'));
  check('generic inline images pass cross-origin Referer checks without CORS response headers or a site adapter');
  assert.deepEqual(await geometry(),before);assert.equal(await page.locator('#thumb').evaluate(i=>i.style.content),'');assert.equal(await page.locator('#hidden').evaluate(i=>i.style.content),'');
  check('existing result replaces picture visually with unchanged geometry, src, srcset and scroll; thumbnail/hidden image excluded');
  const sharedIdentity=await worker.evaluate(async url=>{
    const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content-scripts/content.js']});
    const discovery=await chrome.tabs.sendMessage(tab.id,{type:'NC_NAVIGATION'},{frameId:0});
    const inline=await chrome.tabs.sendMessage(tab.id,{type:'NC_INLINE_IDENTITY'},{frameId:0});
    return discovery.navigationId===inline.navigationId;
  },page.url());
  assert(sharedIdentity);check('Discovery and inline bundles share the same document navigation and session');
  await page.locator('#site-button').click();assert.equal((await geometry()).clicks,1);check('original website button remains clickable');
  await page.screenshot({path:path.join(out,'translated-desktop.png')});
  await page.waitForFunction(()=>document.querySelector('#second').style.content.includes('blob:'),{},{timeout:15000});assert.equal(createdJobs,1);assert.equal(uploads.size,1);check('next page submits, uploads verified bytes and displays completion; failed page does not loop');
  await activate();await page.waitForTimeout(900);assert.equal(createdJobs,1);check('repeated page activation creates no duplicate submissions');
  const readsBeforeDenied=sourceRequests.length,jobsBeforeDenied=createdJobs;
  await worker.evaluate(origin=>{
    globalThis.fixturePermissionContains=chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains=permissions=>permissions.origins?.includes(origin+'/*')?Promise.resolve(false):globalThis.fixturePermissionContains(permissions);
  },api);
  await activate();
  await page.waitForFunction(()=>[...document.querySelectorAll('img.comic')].every(image=>!image.style.content));
  await page.waitForTimeout(800);
  assert.equal(sourceRequests.length,readsBeforeDenied);
  const permissionTree=await cdp.send('Accessibility.getFullAXTree');
  assert(permissionTree.nodes.some(node=>node.name?.value==='网站访问受限'));
  assert(permissionTree.nodes.some(node=>node.description?.value==='网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
  assert.equal(createdJobs,jobsBeforeDenied);assert.equal(await worker.evaluate(()=>globalThis.fixturePermissionRequests),0);
  await page.screenshot({path:path.join(out,'source-permission-required.png')});
  check('simulated revoked image access blocks downloads and new jobs, explains extension settings recovery and never requests permission');
  await worker.evaluate(()=>{chrome.permissions.contains=globalThis.fixturePermissionContains;delete globalThis.fixturePermissionContains;});
  await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),null,{timeout:15000});
  assert.equal(createdJobs,jobsBeforeDenied);assert.equal(await worker.evaluate(()=>globalThis.fixturePermissionRequests),0);
  check('restoring the simulated browser access check resumes the same page and translation without new jobs or permission requests');
  const displayed=await page.locator('#first').evaluate(i=>i.style.content);
  for(const style of ['opacity: 0.95', 'content: normal; aspect-ratio: auto; opacity: 0.95']){
    await page.locator('#first').evaluate((i,style)=>{i.setAttribute('style',style);i.classList.add('site-rendered');},style);
    await page.waitForFunction(expected=>document.querySelector('#first').style.content===expected,displayed);
    assert.equal(await page.locator('#first').evaluate(i=>i.style.opacity),'0.95');
    const repaired=await geometry();assert.equal(repaired.height,before.height);assert.equal(repaired.width,before.width);
  }
  await page.waitForTimeout(300);assert.equal(createdJobs,1);
  await page.screenshot({path:path.join(out,'site-style-repaired.png')});
  check('site style/class rewrites retain the decoded result, original geometry and site edits without new jobs');
  const accessesBeforeRestore=accessCount(),downloadsBeforeRestore=resultRequests.length;
  await button('恢复原图');await page.waitForFunction(()=>document.querySelector('#first').style.content==='normal');
  assert.equal(await page.locator('#first').evaluate(i=>i.style.aspectRatio),'auto');
  assert.equal(await page.locator('#first').evaluate(i=>i.style.opacity),'0.95');
  check('restoring originals preserves the latest site-authored content, aspect ratio and opacity');
  await page.locator('#first').evaluate(i=>i.removeAttribute('style'));
  await button('显示译图');await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'));
  assert.equal(accessCount(),accessesBeforeRestore);assert.equal(resultRequests.length,downloadsBeforeRestore);
  check('original/translation toggle uses persistent bytes with zero image access or download requests');
  // Seed a legacy large PNG cache entry. Padding isolates the transport boundary
  // from pixel dimensions; representative long-image encoding is tested separately.
  const firstId=[...translations].find(([,entry])=>entry.jobId==='seed-1')[0];
  const largeCache=await worker.evaluate(async requestId=>{
    const get=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const name=(await indexedDB.databases()).find(db=>db.name.endsWith('-translations')).name;
    const db=await get(indexedDB.open(name)),keys=await get(db.transaction('objects').objectStore('objects').getAllKeys());
    const key=keys.find(key=>key.includes(requestId));if(!key)throw Error('Missing selected result cache');
    const previous=await get(db.transaction('objects').objectStore('objects').get(key));
    const bitmap=await createImageBitmap(previous),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const blob=new Blob([await canvas.convertToBlob({type:'image/png'}),new Uint8Array(65*1024*1024)],{type:'image/png'});canvas.width=canvas.height=1;
    const tx=db.transaction(['objects','metadata','state'],'readwrite'),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    const metadata=await get(tx.objectStore('metadata').get(key)),usage=await get(tx.objectStore('state').get('usage'));
    usage.bytes+=blob.size-metadata.size;metadata.size=blob.size;tx.objectStore('objects').put(blob,key);tx.objectStore('metadata').put(metadata);tx.objectStore('state').put(usage);await done;db.close();
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return {size:blob.size,digest};
  },firstId);
  await button('恢复原图');await button('显示译图');
  await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),null,{timeout:30000});
  const delivered=await page.locator('#first').evaluate(async image=>{
    const url=image.style.content.match(/url\(["']?(.*?)["']?\)/)[1],blob=await(await fetch(url)).blob();
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return {size:blob.size,digest};
  });
  assert.deepEqual(delivered,largeCache);assert.equal(resultRequests.length,downloadsBeforeRestore);assert.equal(createdJobs,1);
  check('a legacy PNG cache over 65 MiB crosses real extension ports with identical bytes, zero downloads and no new translation');
  await button('恢复原图');await page.waitForFunction(()=>document.querySelector('#first').style.content==='');assert.equal(await page.locator('#first').getAttribute('width'),null);assert.equal(await page.locator('#first').getAttribute('height'),null);check('restore originals removes only extension-owned changes');
  await button('显示译图');await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'));
  await page.setViewportSize({width:1280,height:900});await page.locator('#third').scrollIntoViewIfNeeded();await page.waitForTimeout(700);await page.screenshot({path:path.join(out,'failed-page.png')});const thirdBefore=await page.locator('#third').evaluate(i=>({width:i.clientWidth,height:i.clientHeight}));await button('翻译失败 · 重试');await page.waitForFunction(()=>document.querySelector('#third').style.content.includes('blob:'),{},{timeout:18000});assert.equal(createdJobs,2);assert.deepEqual(await page.locator('#third').evaluate(i=>({width:i.clientWidth,height:i.clientHeight})),thirdBefore);check('individual failed image retries explicitly without blocking neighbours');
  await button('暂停');const count=createdJobs;await page.locator('#lazy').evaluate((i,url)=>i.src=url,api+'/source/4.png');await page.locator('#lazy').scrollIntoViewIfNeeded();await page.waitForTimeout(1200);assert.equal(createdJobs,count);await button('继续');await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:18000});check('pause stops new work; resuming discovers lazy-loaded images');
  // Hold the synthetic result until restoration is observed; a fast cached
  // decode must not let the polling assertion miss the intermediate state.
  complete=false;await page.locator('#lazy').evaluate((i,url)=>i.src=url,api+'/source/5.png');await page.waitForFunction(()=>document.querySelector('#lazy').style.content==='');complete=true;await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:18000});check('site-owned source change removes stale translation and translates the new image');
  complete=false;await page.locator('#lazy').evaluate((i,bytes)=>i.src=URL.createObjectURL(new Blob([new Uint8Array(bytes),new Uint8Array(65*1024*1024)],{type:'image/png'})),[...images.get(6)]);await page.waitForFunction(()=>document.querySelector('#lazy').style.content==='');complete=true;await page.waitForFunction(()=>document.querySelector('#lazy').style.content.includes('blob:'),{},{timeout:45000});check('page-owned Blob input over 65 MiB crosses bounded source ports, prepares a separate upload and displays without exposing credentials');
  const jobsBeforeReturn=createdJobs;
  const firstDownloadsBeforeReturn=resultRequests.filter(id=>id==='output-seed-1').length;
  assert(await page.locator('#first').evaluate(i=>i.style.content.includes('blob:')),'nearby decoded results remain retained');
  await page.locator('#first').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:15000});
  assert.equal(createdJobs,jobsBeforeReturn);assert.equal((await geometry()).height,before.height);
  assert.equal(resultRequests.filter(id=>id==='output-seed-1').length,firstDownloadsBeforeReturn);
  await page.screenshot({path:path.join(out,'scroll-return.png')});
  check('scrolling back reuses the retained translation without creating another translation job or changing geometry');
  await worker.evaluate(async()=>{await chrome.storage.local.set({'nc-auth':{session:null}});});await page.waitForFunction(()=>document.querySelector('#first').style.content==='');await page.waitForTimeout(800);assert.equal(await page.locator('#lazy').evaluate(i=>i.style.content),'');await page.screenshot({path:path.join(out,'logged-out.png')});check('logout immediately restores every image and stops authenticated work');
  await button('关闭');assert.equal(await page.locator('#lazy').evaluate(i=>i.style.content),'');
  await worker.evaluate(async api=>{await chrome.storage.local.set({'nc-auth':{session:{id:'fixture-session',token:'isolated-fixture',expiresAt:Date.now()+3600000,refreshAt:Date.now()+3500000,credential:{kind:'development'},user:{id:'fixture-reader',name:'Fixture',role:'reader'},apiOrigin:api}}});},api);
  await page.goto(site+'/strict');await activate();await page.waitForTimeout(6000);await page.screenshot({path:path.join(out,'strict-csp.png')});
  assert((await page.locator('#first').evaluate(i=>i.style.content)).includes('blob:'));check('strict-CSP page displays decoded translation with isolated controls');
  await page.goto(site);await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'));
  await page.evaluate(()=>{history.pushState({},'','/next-chapter');document.querySelector('#first').src+='?new';});
  await page.waitForFunction(()=>document.querySelector('#first').style.content==='');await activate();await page.waitForFunction(()=>document.querySelector('#first').style.content.includes('blob:'),{},{timeout:15000});check('same-document navigation stops the old session and can be activated again');
  const reader=await browser.newPage();reader.on('pageerror',e=>errors.push(e.message));await reader.goto(`chrome-extension://${extensionId}/reader.html#settings`);await reader.getByRole('combobox',{name:'默认目标语言'}).waitFor();
  assert.equal(await reader.getByRole('combobox',{name:'默认目标语言'}).getAttribute('data-value'),'zh-Hans');
  jobs.set('seed-en',{...jobs.get('seed-1'),id:'seed-en',target_language:'en'});
  const beforeLanguage=await page.locator('#first').evaluate(image=>image.style.content);
  await selectOption(reader.getByLabel('默认目标语言'),'en');await page.bringToFront();
  // Cached results can replace the restored original before the next Playwright poll.
  // Assert the durable new rendering instead of waiting for a transient empty style.
  await page.waitForFunction(previous=>{const content=document.querySelector('#first').style.content;return content.includes('blob:')&&content!==previous;},beforeLanguage,{timeout:15000});
  assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings'].language),'en');check('reader UI shares language and login settings with in-page translation');
  // Content scripts may not access the mirrored login session.
  const security=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url);return chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try{await chrome.storage.local.get('nc-auth');return false;}catch{return true;}}});},page.url());assert.equal(security[0].result,true);check('credential storage is restricted to trusted extension contexts');
  complete=false;await page.goto(site+'/rolling');await page.locator('#rolling-1').evaluate(i=>i.decode());await activate();
  const hasJob=n=>[...jobs.values()].some(j=>j.image_sha256===sha(images.get(n)));
  const waitJob=async n=>{const until=Date.now()+15000;while(!hasJob(n)&&Date.now()<until)await page.waitForTimeout(50);assert(hasJob(n),'missing rolling page '+(n-6));};
  await waitJob(11);assert(!hasJob(12));
  for(const current of [2,3]){
    await page.locator('#rolling-'+current).evaluate(i=>window.scrollTo(0,i.offsetTop));
    await waitJob(current+10);assert(!hasJob(current+11),'must not exceed four lookahead pages');
  }
  assert([...jobs.values()].filter(j=>[7,8,9,10,11,12].some(n=>j.image_sha256===sha(images.get(n)))).every(j=>j.status!=='succeeded'));
  await page.screenshot({path:path.join(out,'rolling-prefetch.png')});
  check('short pages prefetch the extra slot immediately and keep refilling while previous translations remain unfinished');
  const network=online=>worker.evaluate(async({url,online})=>{
    const tab=(await chrome.tabs.query({})).find(t=>t.url===url);
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:online=>{
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});window.dispatchEvent(new Event(online?'online':'offline'));
    },args:[online]});
  },{url:page.url(),online});
  await network(false);await page.waitForTimeout(300);assert.equal(eventStreams.size,0);
  const offlineRequests=requests.length;await page.waitForTimeout(500);assert.equal(requests.length,offlineRequests);
  await network(true);const onlineDeadline=Date.now()+5000;while(eventStreams.size!==1&&Date.now()<onlineDeadline)await page.waitForTimeout(50);
  assert.equal(eventStreams.size,1);check('simulated offline closes SSE with zero further HTTP requests; returning online opens one stream');
  // Complete the whole window together, holding one neighbour's bytes indefinitely.
  await page.locator('#rolling-1').evaluate(i=>window.scrollTo(0,i.offsetTop));
  const rollingJob=n=>[...jobs.values()].find(j=>j.image_sha256===sha(images.get(n+6)));
  heldResult='output-'+rollingJob(2).id;
  for(let n=1;n<=6;n++)Object.assign(rollingJob(n),{status:'succeeded',phase:'completed',result_available:true,output_asset_id:'output-'+rollingJob(n).id,updated_at:new Date().toISOString()});
  await page.waitForFunction(()=>document.querySelector('#rolling-1').style.content.includes('blob:')&&document.querySelector('#rolling-3').style.content.includes('blob:'),null,{timeout:15000});
  const heldUntil=Date.now()+5000;while(!releaseResult&&Date.now()<heldUntil)await page.waitForTimeout(25);
  assert(releaseResult,'the neighbour download must actually be in flight');
  assert.equal(await page.locator('#rolling-2').evaluate(i=>i.style.content),'');
  await page.screenshot({path:path.join(out,'independent-downloads.png')});
  heldResult=undefined;releaseResult();releaseResult=undefined;
  await page.waitForFunction(()=>[1,2,3,4,5].every(n=>document.querySelector('#rolling-'+n).style.content.includes('blob:')));
  check('current and other completed pages display while a neighbour download is still blocked');
  const cacheAccesses=accessCount(),cacheDownloads=resultRequests.length,cacheJobs=createdJobs;
  // Headless Chromium keeps tabs visible. Drive the real content-script visibility handler
  // in its isolated world; this is a synthetic visibility event, not a native tab-switch test.
  const visibility=hidden=>worker.evaluate(async({url,hidden})=>{
    const tab=(await chrome.tabs.query({})).find(t=>t.url===url);
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:hidden=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    },args:[hidden]});
  },{url:page.url(),hidden});
  await visibility(true);
  await page.waitForFunction(()=>!document.querySelector('#rolling-1').style.content);
  await visibility(false);
  await page.waitForFunction(()=>[1,2,3,4,5].every(n=>document.querySelector('#rolling-'+n).style.content.includes('blob:')));
  assert.equal(accessCount(),cacheAccesses);assert.equal(resultRequests.length,cacheDownloads);
  check('simulated hide/return releases decoded images but performs zero image HTTP requests');
  await page.reload();await activate();
  await page.waitForFunction(()=>document.querySelector('#rolling-1').style.content.includes('blob:'));
  assert.equal(resultRequests.length,cacheDownloads);assert.equal(createdJobs,cacheJobs);
  check('reloading a page restores translations from IndexedDB without downloading or translating again');
  // A changed original creates a new request. A failed result download only retries bytes.
  await page.locator('#rolling-1').evaluate((image,url)=>image.src=url,api+'/source/14.png');
  await waitJob(14);
  const failed=[...jobs.values()].find(job=>job.image_sha256===sha(images.get(14))),nextOutput='output-'+failed.id;
  failResult=nextOutput;
  Object.assign(failed,{status:'succeeded',output_asset_id:nextOutput,updated_at:new Date().toISOString()});
  const retryUntil=Date.now()+15000;while(!resultRequests.includes(nextOutput)&&Date.now()<retryUntil)await page.waitForTimeout(50);
  assert(resultRequests.includes(nextOutput));
  await page.waitForTimeout(300);
  const beforeReloadRetry=requests.length;
  await page.screenshot({path:path.join(out,'download-failure.png')});
  await button('加载失败 · 重试');
  await page.waitForFunction(()=>document.querySelector('#rolling-1').style.content.includes('blob:'));
  assert.equal(resultRequests.filter(id=>id===nextOutput).length,2);
  assert.equal(createdJobs,cacheJobs+1);
  assert.equal(requests.slice(beforeReloadRetry).filter(r=>r.method==='PUT'&&/^\/v1\/translations\/[^/]+$/.test(r.path)).length,0);
  check('download failure retry only reads the result and creates no translation');
  assert.equal(requests.filter(r=>/translation-plans|translation-operations|reading-sessions|translation-changes|\/v1\/uploads/.test(r.path)).length,0,'removed reading control endpoints must never be requested');
  assert.equal(accessCount(),0,'completed snapshots directly supply the authenticated artifact path');
  check('single-image requests and snapshots use no reading lease, plan, completion or separate result-access calls');
  // Match the real Comic PASH canvas structure with synthetic pixels and the same API fixture.
  complete=true;
  await browser.route('https://comicpash.jp/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><title>Canvas RTL fixture</title><style>body{margin:0}#xCVPages{display:flex;flex-direction:row-reverse;width:1200px}.-cv-page{width:600px;height:800px;flex:none}.-cv-page-canvas{position:relative;width:600px;height:800px}canvas{width:600px;height:800px}#xCVPages canvas{position:absolute;top:50%;left:0;transform:translateY(-50%)}</style><div id="comici-viewer" data-comici-viewer-id="fixture"><div id="xCVPages">${[1,2].map(n=>`<div class="-cv-page mode-rendered"><div class="-cv-page-canvas"><canvas id="canvas-${n}" width="600" height="800"></canvas></div></div>`).join('')}</div></div><canvas id="canvas-ad" width="600" height="800"></canvas><script>for(const [n,canvas] of [...document.querySelectorAll('canvas')].entries()){const ctx=canvas.getContext('2d');ctx.fillStyle=['#ffe0b0','#d0e0ff','#f00'][n];ctx.fillRect(0,0,600,800);ctx.fillStyle='#123';ctx.font='40px sans-serif';ctx.fillText('Original '+n,60,180);}document.querySelector('#canvas-1').onclick=()=>document.body.dataset.clicked='yes';</script>`}))
  await page.goto('https://comicpash.jp/episodes/fixture');
  const aligned=()=>page.waitForFunction(()=>[...document.querySelectorAll('[data-nc-canvas-translation]')].length>0&&[...document.querySelectorAll('[data-nc-canvas-translation]')].every(image=>{const a=image.getBoundingClientRect(),b=image.previousElementSibling.getBoundingClientRect();return ['x','y','width','height'].every(key=>Math.abs(a[key]-b[key])<=1);}));
  const canvasOriginal=await page.locator('#canvas-1').evaluate(c=>c.toDataURL());
  const canvasPixels=await page.locator('#canvas-1').screenshot();
  const canvasGeometry=await page.locator('#canvas-1').boundingBox(),canvasJobs=createdJobs;
  await activate();
  await page.waitForFunction(()=>[...document.querySelectorAll('#xCVPages canvas')].every(c=>c.nextElementSibling?.hasAttribute('data-nc-canvas-translation')),null,{timeout:20000});
  assert.equal(createdJobs,canvasJobs+2);assert.equal(await page.locator('#canvas-ad').evaluate(c=>c.style.content),'');
  assert.deepEqual(await page.locator('#canvas-1').boundingBox(),canvasGeometry);assert.equal(await page.locator('#canvas-1').evaluate(c=>c.toDataURL()),canvasOriginal);
  await page.locator('#canvas-1').click({position:{x:300,y:500}});assert.equal(await page.locator('body').getAttribute('data-clicked'),'yes');
  await aligned();
  assert.notDeepEqual(await page.locator('#canvas-1').screenshot(),canvasPixels,'translated pixels must actually be visible');
  await page.screenshot({path:path.join(out,'canvas-translated.png')});
  await button('恢复原图');await page.waitForFunction(()=>!document.querySelector('#canvas-1').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  assert.equal(await page.locator('#canvas-1').evaluate(c=>c.toDataURL()),canvasOriginal);assert.deepEqual(await page.locator('#canvas-1').boundingBox(),canvasGeometry);
  assert.deepEqual(await page.locator('#canvas-1').screenshot(),canvasPixels,'restoring the original must restore visible pixels');
  await page.screenshot({path:path.join(out,'canvas-restored.png')});
  await button('显示译图');await page.waitForFunction(()=>document.querySelector('#canvas-1').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  const replacedResult=await page.locator('#canvas-1').evaluate(c=>c.nextElementSibling.src);
  await page.locator('#canvas-1').evaluate(c=>{const next=c.cloneNode();next.removeAttribute('style');next.getContext('2d').fillRect(0,0,600,800);c.replaceWith(next);});
  await page.waitForFunction(previous=>{const overlay=document.querySelector('#canvas-1').nextElementSibling;return overlay?.hasAttribute('data-nc-canvas-translation')&&overlay.src!==previous;},replacedResult,{timeout:20000});
  assert.equal(createdJobs,canvasJobs+3);check('Comic PASH RTL canvases upload decoded pixels, translate both pages, preserve clicks/geometry/originals, exclude ads and refresh recycled canvases');
  if(process.env.RUN_LIVE_COMICPASH==='1'){
    // Only source rendering is live. Actual source pixels go solely to the local fixture API.
    await browser.unroute('https://comicpash.jp/**');
    await page.goto('https://comicpash.jp/episodes/60cfe4785e2af');
    await page.locator('#comici-viewer .mode-rendered canvas').first().waitFor({timeout:45000});
    const closeHint=page.getByText('閉じる',{exact:true});if(await closeHint.count())await closeHint.first().click();
    await activate();
    await page.locator('[data-nc-canvas-translation]').first().waitFor({timeout:20000});
    await aligned();
    await page.screenshot({path:path.join(out,'comicpash-live-translated.png')});
    const beforeTurn=await page.locator('#xCVPages').getAttribute('style');
    await page.locator('#xCVLeftNav').click();
    await page.waitForFunction(before=>document.querySelector('#xCVPages').getAttribute('style')!==before,beforeTurn);
    await page.waitForFunction(()=>document.querySelectorAll('#comici-viewer [data-nc-canvas-translation]').length>=2,null,{timeout:20000});
    await aligned();
    await page.screenshot({path:path.join(out,'comicpash-live-next-spread.png')});
    await button('恢复原图');await page.locator('[data-nc-canvas-translation]').first().waitFor({state:'detached'});
    await page.screenshot({path:path.join(out,'comicpash-live-restored.png')});
    check('Live Comic PASH source recognizes canvases, displays fixture translations, turns pages and restores originals; no live provider used');
  }
  }
  if(!selectedSite||selectedSite==='generic') {
    complete=true;
    await browser.route('https://canvas-fixture-cdn.test/image.png',route=>route.fulfill({contentType:'image/png',body:images.get(2)}));
    await page.goto(site+'/generic-canvas');
    const original=await page.locator('#ready').evaluate(c=>c.toDataURL()),box=await page.locator('#ready').boundingBox();
    const originalPixels=await page.locator('#ready').screenshot(),initialJobs=createdJobs;
    const metrics=()=>worker.evaluate(async url=>{
      const tab=(await chrome.tabs.query({})).find(t=>t.url===url);
      return (await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.fixtureCanvasMetrics}))[0].result;
    },page.url());
    const measureCanvases=()=>worker.evaluate(async url=>{
      const tab=(await chrome.tabs.query({})).find(t=>t.url===url);
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
        globalThis.fixtureCanvasMetrics={samples:0,sampleMs:0,drawMs:0,encodes:0};
        const get=OffscreenCanvasRenderingContext2D.prototype.getImageData;
        OffscreenCanvasRenderingContext2D.prototype.getImageData=function(...args){const start=performance.now();try{return get.apply(this,args);}finally{fixtureCanvasMetrics.samples++;fixtureCanvasMetrics.sampleMs+=performance.now()-start;}};
        const draw=OffscreenCanvasRenderingContext2D.prototype.drawImage;
        OffscreenCanvasRenderingContext2D.prototype.drawImage=function(...args){const start=performance.now();try{return draw.apply(this,args);}finally{fixtureCanvasMetrics.drawMs+=performance.now()-start;}};
        const encode=HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob=function(...args){fixtureCanvasMetrics.encodes++;return encode.apply(this,args);};
      }});
    },page.url());
    await measureCanvases();
    const hasOverlay=id=>page.waitForFunction(id=>document.getElementById(id)?.nextElementSibling?.hasAttribute('data-nc-canvas-translation'),id,{timeout:20000});
    const aligned=()=>page.waitForFunction(()=>[...document.querySelectorAll('[data-nc-canvas-translation]')].every(i=>{const a=i.getBoundingClientRect(),b=i.previousElementSibling.getBoundingClientRect();return ['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<=1);}));
    await activate();await hasOverlay('ready');await aligned();
    assert.equal(createdJobs,initialJobs+1);
    assert.deepEqual(await page.locator('#ready').boundingBox(),box);
    assert.equal(await page.locator('#ready').evaluate(c=>c.toDataURL()),original);
    assert.notDeepEqual(await page.locator('#ready').screenshot(),originalPixels);
    for(const id of ['lazy','tainted','small','offscreen'])assert.equal(await page.locator('#'+id).evaluate(c=>!!c.nextElementSibling?.hasAttribute('data-nc-canvas-translation')),false);
    await page.locator('#ready').click();assert.equal(await page.locator('body').getAttribute('data-clicked'),'yes');
    await page.waitForTimeout(1100);assert.equal(createdJobs,initialJobs+1,'overlays must not become new image targets');
    check('Generic canvases translate only stable visible pixels, skip blank/tainted/small/offscreen surfaces and preserve original pixels, clicks and geometry');
    const previous=await page.locator('#ready').evaluate(c=>c.nextElementSibling.src);
    await page.locator('#ready').evaluate(c=>window.drawFixture(c,1));
    await page.waitForFunction(previous=>{const i=document.querySelector('#ready').nextElementSibling;return i?.hasAttribute('data-nc-canvas-translation')&&i.src!==previous;},previous,{timeout:20000});
    assert.equal(createdJobs,initialJobs+2);
    await page.locator('#lazy').evaluate(c=>window.drawFixture(c,2));await hasOverlay('lazy');
    assert.equal(createdJobs,initialJobs+3);await aligned();
    await page.screenshot({path:path.join(out,'generic-canvas-translated.png')});
    const beforeRestore=await page.locator('#ready').evaluate(c=>c.toDataURL()),cachedJobs=createdJobs;
    await button('恢复原图');await page.waitForFunction(()=>!document.querySelector('[data-nc-canvas-translation]'));
    assert.equal(await page.locator('#ready').evaluate(c=>c.toDataURL()),beforeRestore);
    assert.deepEqual(await page.locator('#ready').boundingBox(),box);
    await button('显示译图');await hasOverlay('ready');await hasOverlay('lazy');assert.equal(createdJobs,cachedJobs);
    check('Generic same-element redraws and delayed canvas drawings refresh without DOM mutations; restoring and returning reuse cached translations');
    await writeFile(path.join(out,'generic-canvas-metrics.json'),JSON.stringify(await metrics(),null,2));
    if(process.env.RUN_LIVE_COMICWALKER==='1') {
      // Public source page is live; original pixels are sent only to this local API fixture.
      await page.goto('https://comic-walker.com/detail/KC_008597_S/episodes/KC_0085970000200011_E',{waitUntil:'domcontentloaded'});
      await page.locator('canvas').first().waitFor({timeout:45000});
      await page.waitForFunction(()=>{const c=document.querySelector('canvas');if(!c||c.width<80||c.height<80)return false;try{const p=new OffscreenCanvas(32,32),x=p.getContext('2d');x.drawImage(c,0,0,32,32);const d=x.getImageData(0,0,32,32).data;return d.some((v,i)=>v!==d[i%4]);}catch{return false;}},null,{timeout:45000});
      await measureCanvases();
      const sourcePixels=await page.locator('canvas').first().evaluate(c=>c.toDataURL());
      const sourceBox=await page.locator('canvas').first().boundingBox();
      await page.screenshot({path:path.join(out,'comicwalker-live-original.png')});
      await activate();
      await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0&&c.nextElementSibling?.hasAttribute('data-nc-canvas-translation');}),null,{timeout:30000});
      await aligned();
      assert.equal(await page.locator('canvas').first().evaluate(c=>c.toDataURL()),sourcePixels);
      assert.deepEqual(await page.locator('canvas').first().boundingBox(),sourceBox);
      await page.screenshot({path:path.join(out,'comicwalker-live-translated.png')});
      await page.getByRole('slider').press('ArrowLeft');
      await page.waitForFunction(()=>document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')==='2');
      await page.waitForFunction(()=>{const visible=[...document.querySelectorAll('canvas')].filter(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;});return visible.length===2&&visible.every(c=>c.nextElementSibling?.hasAttribute('data-nc-canvas-translation'));},null,{timeout:30000});
      await aligned();await page.screenshot({path:path.join(out,'comicwalker-live-next-spread.png')});
      await button('恢复原图');await page.waitForFunction(()=>!document.querySelector('[data-nc-canvas-translation]'));
      assert.equal(await page.locator('canvas').first().evaluate(c=>c.toDataURL()),sourcePixels);
      await page.screenshot({path:path.join(out,'comicwalker-live-restored.png')});
      await page.getByRole('button',{name:/タテ読み|縦読み|竖向阅读/}).click();
      await button('显示译图');
      await page.waitForFunction(()=>[...document.querySelectorAll('canvas[mode="vertical"]')].some(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0&&c.nextElementSibling?.hasAttribute('data-nc-canvas-translation');}),null,{timeout:30000});
      await aligned();await page.screenshot({path:path.join(out,'comicwalker-live-vertical.png')});
      await button('恢复原图');await page.waitForFunction(()=>!document.querySelector('[data-nc-canvas-translation]'));
      await writeFile(path.join(out,'comicwalker-canvas-metrics.json'),JSON.stringify(await metrics(),null,2));
      check('Live Comic Walker generic canvases display local fixture results in horizontal and vertical readers, translate both next-spread pages and restore original pixels/geometry; no live provider used');
    }
  }
  complete=true;
  let liveSource=liveWindowSource||(process.env.RUN_LIVE_COMICPASH==='1'&&!selectedSite)||(process.env.RUN_LIVE_COMICWALKER==='1'&&(!selectedSite||selectedSite==='generic'));
  for(const site of siteChecks.filter(site=>!selectedSite||site.id===selectedSite)) {
    const {verifyInline}=await import(site.url);
    const result=await verifyInline({browser,page,activate,button,source:images.get(2),out,check});
    liveSource ||= !!result?.liveSource;
  }
  assert.equal(permissionRequests,0);assert.equal(await worker.evaluate(()=>globalThis.fixturePermissionRequests),0);
  check('inline activation and image reads never request host access at runtime');
  const transfers=await worker.evaluate(()=>fixtureTransfers);
  assert(transfers.maxMessageBytes<710000);if(!selectedSite){assert(transfers.resultChunks>130);assert(transfers.sourceChunks>130);}
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,transfers,newTranslationJobs:createdJobs,translationRequests:translations.size,queueRequests:0,uploads:uploads.size,imageAccesses:accessCount(),imageDownloads:resultRequests.length,liveSource,liveProvider:false,nativeMenuDialog:false,extensionId},null,2));
  console.log('Artifacts: '+out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,requests,resultRequests,accessibility:await cdp.send('Accessibility.getFullAXTree').then(v=>v.nodes.filter(n=>n.role?.value==='button').map(n=>({name:n.name?.value,description:n.description?.value}))).catch(()=>[])},null,2));await page.screenshot({path:path.join(out,'failure.png'),timeout:5000}).catch(()=>{});console.error('Artifacts: '+out);throw error;}
finally{releasePreparation?.();releaseResult?.();await browser.close();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>web.close(resolve));}
