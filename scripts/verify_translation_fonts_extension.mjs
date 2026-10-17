// Production MV3 assets in a fresh Chromium profile, with all non-loopback network traffic disabled.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const catalog=JSON.parse(await readFile(new URL('../backend/shared/translation-fonts.json',import.meta.url),'utf8'));
const out=path.resolve('artifacts/translation-fonts-mv3',randomUUID()),extension=path.join(out,'extension');
await mkdir(out,{recursive:true});await cp(process.env.TEST_EXTENSION_DIR||'apps/extension/.output/chrome-mv3',extension,{recursive:true});
await writeFile(path.join(extension,'font-probe.html'),'<!doctype html><meta charset="utf-8"><title>Isolated MV3 font verification</title><main id="samples"></main>');
const checks=[],check=message=>{checks.push(message);console.log('PASS '+message);};
const controlFont=await readFile(path.join(extension,'fonts/translation/'+catalog.fonts[0].id+'.woff2'));
const server=createServer((request,response)=>{
  if(request.url==='/font.woff2'){response.writeHead(200,{'Content-Type':'font/woff2'});response.end(controlFont);return;}
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...(request.url==='/restricted'?{'Content-Security-Policy':"font-src 'none'"}:{})});
  response.end('<!doctype html><meta charset="utf-8"><title>Font host fixture</title><main id="samples"></main>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context;
try{
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  assert(manifest.web_accessible_resources.some(group=>group.resources.includes('fonts/translation/*.woff2')));
  context=await chromium.launchPersistentContext(path.join(out,'profile'),{
    headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,viewport:{width:1000,height:900},
    args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname,probe=await context.newPage();
  await probe.goto(`chrome-extension://${id}/font-probe.html`);
  const fonts=await Promise.all(catalog.fonts.map(async font=>{
    const file='fonts/translation/'+font.id+'.woff2',bytes=await readFile(path.join(extension,file));
    assert.deepEqual(bytes,await readFile(path.resolve('apps/extension/public',file)),`${font.id} build must contain current preview bytes`);
    return {...font,language:font.languages[0],sample:font.names[font.languages[0]],sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,file};
  }));
  const sources=await probe.evaluate(fonts=>fonts.map(font=>({...font,url:chrome.runtime.getURL(font.file)})),fonts);
  async function loadFonts(page){return page.evaluate(async fonts=>{
    const results=[];document.body.style.cssText='font:16px system-ui;padding:24px;background:#f8fafc;color:#172237';
    for(const font of fonts){
      const bytes=await(await fetch(font.url)).arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
      const face=await new FontFace('Probe '+font.id,`url(${JSON.stringify(font.url)})`).load();document.fonts.add(face);
      const section=document.createElement('section'),title=document.createElement('h2'),sample=document.createElement('p');
      title.textContent=font.id;title.style.cssText='font:14px system-ui;margin:0;color:#5a667a';
      sample.textContent=font.sample;sample.lang=font.language;sample.dir=font.language==='ar'?'rtl':'ltr';
      sample.style.cssText=`font-family:"Probe ${font.id}";font-size:26px;font-weight:400;font-synthesis:none;margin:10px 0`;
      section.style.cssText='border:1px solid #d4dce8;border-radius:12px;background:#fff;padding:16px;margin-bottom:12px';section.append(title,sample);document.querySelector('#samples').append(section);
      results.push({id:font.id,hash,status:face.status});
    }return results;
  },sources);}
  const own=await loadFonts(probe);for(const result of own){assert.equal(result.hash,fonts.find(font=>font.id===result.id).sha256);assert.equal(result.status,'loaded');}
  check(`all ${fonts.length} production WOFF2 assets match the source hashes and load at the extension origin`);
  const host=await context.newPage(),base=`http://127.0.0.1:${server.address().port}`;
  await host.goto(base);const hosted=await loadFonts(host);
  for(const result of hosted){assert.equal(result.hash,fonts.find(font=>font.id===result.id).sha256);assert.equal(result.status,'loaded');}
  check('the restricted web-accessible resource rule permits all preview fonts on a real HTTP host page');
  await host.screenshot({path:path.join(out,'host-preview.png'),fullPage:true});
  const privateUrl=`chrome-extension://${id}/fonts/translation/sources.json`;
  assert.equal(await probe.evaluate(async url=>(await fetch(url)).ok,privateUrl),true,'negative control must exist in the built extension');
  const hidden=await host.evaluate(async url=>{try{return(await fetch(url)).ok;}catch{return false;}},privateUrl);
  assert.equal(hidden,false);check('non-font files in the resource directory remain unavailable to host pages');
  await host.goto(base+'/restricted');
  const blocked=await host.evaluate(async url=>{try{await new FontFace('Blocked preview',`url(${JSON.stringify(url)})`).load();return false;}catch{return true;}},base+'/font.woff2');
  assert.equal(blocked,true);
  // Chromium can exempt extension resources from host CSP. Record actual FontFace state,
  // rather than treating that browser-specific exception as a loading failure.
  const extensionCsp=await host.evaluate(async url=>{try{return(await new FontFace('Extension CSP preview',`url(${JSON.stringify(url)})`).load()).status;}catch{return 'blocked';}},sources[0].url);
  assert(['loaded','blocked'].includes(extensionCsp));check(`host font-src negative control is blocked; extension-font outcome is ${extensionCsp}`);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,fontCount:fonts.length,sourceBytes:fonts.reduce((total,font)=>total+font.byteSize,0),extensionCsp,liveProvider:false},null,2));
  console.log('Evidence '+out);
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
