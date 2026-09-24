// Research only: disposable MV3 extension, local synthetic images and isolated browser profile.
// No product build, user browser, external site, credentials, or translation service is used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const probeDebugger=process.env.PROBE_DEBUGGER==='1';
const probePageCapture=process.env.PROBE_PAGE_CAPTURE==='1';
const probeRequestContext=process.env.PROBE_REQUEST_CONTEXT==='1';
const out=path.resolve('artifacts/page-image-access',randomUUID());
const extension=path.join(out,'extension');await mkdir(extension,{recursive:true});
const checks=[],requests=[];
function crc32(data){let crc=0xffffffff;for(const b of data){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32,0);ihdr.writeUInt32BE(24,4);ihdr[8]=8;ihdr[9]=2;
const pixels=Buffer.alloc((32*3+1)*24);for(let y=0;y<24;y++)for(let x=0;x<32;x++){const i=y*97+1+x*3;pixels[i]=x*7;pixels[i+1]=y*9;pixels[i+2]=180;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('tEXt',Buffer.from('Comment\0Synthetic image access research')),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const sourceHash=createHash('sha256').update(png).digest('hex');
let site,cdn;
function handler(name){return (req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname.endsWith('.png')){
    requests.push({server:name,path:url.pathname,origin:req.headers.origin??null,referer:req.headers.referer??null,destination:req.headers['sec-fetch-dest']??null});
    if(url.pathname==='/referer-required.png'&&req.headers.referer!==site+'/'){
      res.writeHead(403,{'Cache-Control':'no-store'});res.end();return;
    }
    const cors=url.pathname.includes('cors')||url.pathname.includes('headers-only');
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length,'Cache-Control':url.pathname.includes('no-store')?'no-store':'public, max-age=3600',...(cors?{'Access-Control-Allow-Origin':'*'}:{})});res.end(png);return;
  }
  if(url.pathname==='/fixture'){
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end(`<!doctype html><title>Page image access research</title><style>body{font:16px sans-serif;padding:24px}img,canvas{width:128px;height:96px;margin:8px;image-rendering:pixelated}</style><h1>Isolated image permission research</h1>
      <img id="same" src="${site}/same.png"><img id="cross" src="${cdn}/plain.png">
      <img id="headersOnly" src="${cdn}/headers-only.png"><img id="cors" crossorigin="anonymous" src="${cdn}/cors.png">
      <img id="data" src="data:image/png;base64,${png.toString('base64')}"><img id="blob">
      <canvas id="clean" width="32" height="24"></canvas><canvas id="tainted" width="32" height="24"></canvas>
      <script>window.ready=(async()=>{const bytes=Uint8Array.from(atob('${png.toString('base64')}'),c=>c.charCodeAt(0));document.querySelector('#blob').src=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));await Promise.all([...document.images].map(i=>i.decode()));document.querySelector('#clean').getContext('2d').drawImage(document.querySelector('#same'),0,0);document.querySelector('#tainted').getContext('2d').drawImage(document.querySelector('#cross'),0,0);return true;})();</script>`);return;
  }
  res.writeHead(404);res.end();
};}
const web=createServer(handler('page')),images=createServer(handler('cdn'));
await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));site=`http://127.0.0.1:${web.address().port}`;
await new Promise(resolve=>images.listen(0,'127.0.0.1',resolve));cdn=`http://127.0.0.1:${images.address().port}`;
await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Local image access probe',version:'1.0',permissions:['scripting',...(probeDebugger?['debugger']:[]),...(probePageCapture?['pageCapture']:[]),...(probeRequestContext?['declarativeNetRequestWithHostAccess']:[])],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'background.js'}}));
await writeFile(path.join(extension,'background.js'),"chrome.runtime.onInstalled.addListener(()=>{});\n");
let browser;

// This function runs through chrome.scripting.executeScript in each world, not page.evaluate.
async function pixelsFromDom(){
  const rows=[];
  for(const element of document.querySelectorAll('img,canvas')){
    const row={id:element.id,kind:element.tagName};
    try{
      const canvas=document.createElement('canvas');canvas.width=element.naturalWidth??element.width;canvas.height=element.naturalHeight??element.height;
      canvas.getContext('2d').drawImage(element,0,0);canvas.getContext('2d').getImageData(0,0,1,1);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      row.size=blob.size;row.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');row.ok=true;
    }catch(error){row.ok=false;row.error=error.name;}
    rows.push(row);
  }
  const element=document.querySelector('#cross');
  for(const method of ['bitmap','offscreen']){
    try{
      const bitmap=await createImageBitmap(element),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
      canvas.getContext('2d').drawImage(method==='bitmap'?bitmap:element,0,0);bitmap.close();
      await canvas.convertToBlob();rows.push({id:method,ok:true});
    }catch(error){rows.push({id:method,ok:false,error:error.name});}
  }
  return rows;
}
async function fetchBytes({url,cache='default',mode='cors',credentials='same-origin'}){
  try{const response=await fetch(url,{cache,mode,credentials});const blob=await response.blob();return {ok:response.ok,type:response.type,status:response.status,size:blob.size,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('')};}
  catch(error){return {ok:false,error:error.name};}
}
const report={sourceHash,sourceBytes:png.length,probeDebugger,probePageCapture,probeRequestContext,checks,steps:[]};
try{
  browser=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,viewport:{width:1100,height:800},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=browser.serviceWorkers()[0]??await browser.waitForEvent('serviceworker',{timeout:15000});
  const page=await browser.newPage();await page.goto(site+'/fixture');await page.evaluate(()=>window.ready);
  report.browser=await page.evaluate(()=>navigator.userAgent);
  report.granted=await worker.evaluate(()=>chrome.permissions.contains({origins:['http://127.0.0.1/*']}));assert(report.granted);
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
  const execute=async(world,func,args=[])=>worker.evaluate(async({tabId,world,source,args})=>{
    // Only trusted script text from this file is evaluated inside the isolated test worker.
    return (await chrome.scripting.executeScript({target:{tabId},world,func:eval('('+source+')'),args}))[0].result;
  },{tabId,world,source:func.toString(),args});
  const measure=async(name,run)=>{const before=requests.length,value=await run();const result={name,value,networkRequests:requests.slice(before)};report.steps.push(result);console.log(JSON.stringify(result));return result;};
  report.initialRequests=[...requests];
  for(const world of ['MAIN','ISOLATED'])await measure('draw loaded DOM images: '+world,()=>execute(world,pixelsFromDom));
  for(const id of ['same','cross','cors','blob','data']){
    const url=await page.locator('#'+id).getAttribute('src');
    await measure('content fetch force-cache: '+id,()=>execute('ISOLATED',fetchBytes,[{url,cache:'force-cache'}]));
  }
  await measure('content no-cors fetch cross image',()=>execute('ISOLATED',fetchBytes,[{url:cdn+'/plain.png',cache:'force-cache',mode:'no-cors'}]));
  await measure('content only-if-cached same image',()=>execute('ISOLATED',fetchBytes,[{url:site+'/same.png',cache:'only-if-cached',mode:'same-origin'}]));
  await measure('content only-if-cached cross image with same-origin mode',()=>execute('ISOLATED',fetchBytes,[{url:cdn+'/plain.png',cache:'only-if-cached',mode:'same-origin'}]));
  await measure('content only-if-cached cross image with cors mode',()=>execute('ISOLATED',fetchBytes,[{url:cdn+'/plain.png',cache:'only-if-cached',mode:'cors'}]));
  // New resources are warmed only by <img>; do not prime the extension's partition first.
  const warm=async(url,cors=false)=>execute('MAIN',async(url,cors)=>{const image=new Image();if(cors)image.crossOrigin='anonymous';image.src=url;await image.decode();document.body.append(image);return true;},[url,cors]);
  const backgroundFetch=input=>worker.evaluate(fetchBytes,input);
  const cacheProbeUrl=cdn+'/only-page-cache.png';await warm(cacheProbeUrl);
  await measure('background only-if-cached after page img before own fetch',()=>backgroundFetch({url:cacheProbeUrl,cache:'only-if-cached',mode:'same-origin'}));
  for(const [name,url,cors] of [['plain',cdn+'/background-plain.png',false],['cors',cdn+'/background-cors.png',true],['same',site+'/background-same.png',false]]){
    await warm(url,cors);
    await measure('background force-cache after page img: '+name,()=>backgroundFetch({url,cache:'force-cache'}));
    await measure('background force-cache repeated: '+name,()=>backgroundFetch({url,cache:'force-cache'}));
  }
  await measure('background only-if-cached remote same-origin mode',()=>backgroundFetch({url:cdn+'/background-plain.png',cache:'only-if-cached',mode:'same-origin'}));
  await measure('background no-store after own cached fetch',()=>backgroundFetch({url:cdn+'/background-plain.png',cache:'no-store'}));
  await warm(cdn+'/cors-no-store.png',true);
  await measure('content force-cache cannot reuse no-store image',()=>execute('ISOLATED',fetchBytes,[{url:cdn+'/cors-no-store.png',cache:'force-cache'}]));
  const main=report.steps[0],isolated=report.steps[1];
  for(const step of [main,isolated]){
    assert.equal(step.networkRequests.length,0);
    for(const id of ['same','cors','blob','data','clean'])assert.equal(step.value.find(row=>row.id===id).ok,true);
    for(const id of ['cross','headersOnly','tainted','bitmap','offscreen'])assert.equal(step.value.find(row=>row.id===id).error,'SecurityError');
  }
  checks.push('Host permission is granted; MAIN and ISOLATED pixel export obey the same origin-clean restrictions with zero network requests');
  assert(report.steps[0].value.find(row=>row.id==='same').sha256!==sourceHash);
  checks.push('Canvas exports re-encoded pixels rather than the original PNG bytes');
  const opaque=report.steps.find(step=>step.name==='content no-cors fetch cross image');assert.equal(opaque.value.type,'opaque');assert.equal(opaque.value.size,0);
  checks.push('no-cors does not expose a cross-origin image response body');
  if(probeRequestContext){
    const url=cdn+'/referer-required.png';await warm(url);
    const missing=await measure('background request without page Referer',()=>backgroundFetch({url,cache:'no-store'}));
    assert.equal(missing.value.status,403);
    await worker.evaluate(async({url,referer})=>{
      await chrome.declarativeNetRequest.updateSessionRules({addRules:[{
        id:1,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:referer}]},
        condition:{initiatorDomains:[new URL(chrome.runtime.getURL('')).hostname],regexFilter:'^'+url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$',isUrlFilterCaseSensitive:true,resourceTypes:['xmlhttprequest']},
      }]});
    },{url,referer:site+'/'});
    try{
      const fixed=await measure('background request with generic page Referer rule',()=>backgroundFetch({url,cache:'no-store'}));
      assert.equal(fixed.value.ok,true);assert.equal(fixed.value.sha256,sourceHash);
    }finally{await worker.evaluate(()=>chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1]}));}
    const cleared=await measure('background request after Referer rule removal',()=>backgroundFetch({url,cache:'no-store'}));
    assert.equal(cleared.value.status,403);
    checks.push('A page-derived Referer with an exact extension-only request rule handles a hotlink check independently of CORS or site adapters');
  }
  if(probeDebugger){
    // Attach only after the page finished loading. All targets contain synthetic localhost data.
    const resourceUrls=[cdn+'/debugger-plain.png',cdn+'/debugger-no-store.png'];
    for(const url of resourceUrls)await warm(url);
    const step=await measure('debugger resource content after image load',()=>worker.evaluate(async({tabId,urls})=>{
      const target={tabId};await chrome.debugger.attach(target,'1.3');
      try{
        await chrome.debugger.sendCommand(target,'Page.enable');
        const {frameTree}=await chrome.debugger.sendCommand(target,'Page.getResourceTree');
        const rows=[];
        for(const url of urls){
          try{
            const {content,base64Encoded}=await chrome.debugger.sendCommand(target,'Page.getResourceContent',{frameId:frameTree.frame.id,url});
            const bytes=base64Encoded?Uint8Array.from(atob(content),c=>c.charCodeAt(0)):new TextEncoder().encode(content);
            rows.push({url,ok:true,base64Encoded,size:bytes.length,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')});
          }catch(error){rows.push({url,ok:false,error:error.message});}
        }
        return rows;
      }finally{await chrome.debugger.detach(target);}
    },{tabId,urls:resourceUrls}));
    assert.equal(step.networkRequests.length,0);
    for(const row of step.value){assert.equal(row.ok,true);assert.equal(row.sha256,sourceHash);}
    checks.push('Explicit debugger permission reads loaded cross-origin resource bytes without refetching in this fixture, including no-store');
  }
  if(probePageCapture){
    const urls=[cdn+'/capture-plain.png',cdn+'/capture-no-store.png'];
    for(const url of urls)await warm(url);
    const step=await measure('pageCapture MHTML after image load',async()=>{
      const mhtml=await worker.evaluate(async tabId=>{const blob=await chrome.pageCapture.saveAsMHTML({tabId});return blob?.text();},tabId);
      assert.equal(typeof mhtml,'string');await writeFile(path.join(out,'synthetic-page.mhtml'),mhtml);
      // Minimal parser for this controlled fixture, not a production MIME parser.
      const boundary=mhtml.match(/boundary="([^"]+)"/i)?.[1];assert(boundary);
      const parts=mhtml.split('--'+boundary);
      return urls.map(url=>{
        const part=parts.find(part=>part.includes('Content-Location: '+url+'\r\n'));
        if(!part)return {url,ok:false,error:'Not included in MHTML'};
        const divider=part.indexOf('\r\n\r\n'),headers=part.slice(0,divider);assert(/Content-Transfer-Encoding: base64/i.test(headers));
        const bytes=Buffer.from(part.slice(divider+4).replace(/\s/g,''),'base64');
        return {url,ok:true,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      });
    });
    assert.equal(step.networkRequests.length,0);
    for(const row of step.value)if(row.ok)assert.equal(row.sha256,sourceHash);
    assert.equal(step.value[0].ok,true);
    checks.push('Explicit pageCapture permission includes the loaded cacheable cross-origin image bytes in MHTML without refetching in this fixture');
  }
  await page.screenshot({path:path.join(out,'fixture.png')});
  await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
  console.log('Artifacts: '+out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({...report,error:error.stack},null,2));throw error;}
finally{await browser?.close();web.closeAllConnections();images.closeAllConnections();await Promise.all([new Promise(resolve=>web.close(resolve)),new Promise(resolve=>images.close(resolve))]);}
