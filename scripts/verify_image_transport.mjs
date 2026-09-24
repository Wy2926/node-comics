// Built extension, real HTTP servers and production transport; isolated synthetic data only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const out=path.resolve('artifacts/image-transport',randomUUID()),extension=path.join(out,'extension');
await mkdir(out,{recursive:true});await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const entry=path.join(out,'probe.ts'),source=path.resolve('apps/extension/src').replaceAll('\\','/');
await writeFile(entry,`export {fetchSourceImage} from '${source}/sources/runtime/image-fetch';export {readInlineSourceImage} from '${source}/sources/runtime/source-image';`);
const {build}=createRequire(path.resolve('apps/extension/package.json'))('vite');
await build({configFile:false,root:path.resolve('apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry,formats:['es'],fileName:()=> 'transport-probe.js'}}});
await writeFile(path.join(extension,'transport-probe.html'),'<!doctype html><meta charset="utf-8"><title>Image transport verification</title><h1>公共跨域取图验证</h1><pre id="report"></pre>');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
let png,first,second,context,page;const requests=[],checks=[],errors=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const serve=name=>async(req,res)=>{
  const url=new URL(req.url,'http://fixture');requests.push({server:name,path:url.pathname,referer:req.headers.referer??null,marker:req.headers['x-fixture-marker']??null,cookie:req.headers.cookie??null});
  if(url.pathname==='/redirect'){res.writeHead(302,{Location:second+'/protected.png','Cache-Control':'no-store'});res.end();return;}
  if(url.pathname==='/ungranted'){res.writeHead(302,{Location:first.replace('127.0.0.1','localhost')+'/never.png','Cache-Control':'no-store'});res.end();return;}
  if(url.pathname==='/loop'){res.writeHead(302,{Location:'/loop','Cache-Control':'no-store'});res.end();return;}
  if(url.pathname==='/slow.png')await new Promise(resolve=>setTimeout(resolve,500));
  if(url.pathname==='/protected.png'&&req.headers.referer!==first+'/'){
    res.writeHead(403,{'Cache-Control':'no-store'});res.end('Missing page context');return;
  }
  if(url.pathname==='/cookie.png'&&!req.headers.cookie?.includes('image_fixture=allowed')){
    res.writeHead(403,{'Cache-Control':'no-store'});res.end();return;
  }
  res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);
};
const a=createServer(serve('first')),b=createServer(serve('second'));
await new Promise(resolve=>a.listen(0,'127.0.0.1',resolve));first=`http://127.0.0.1:${a.address().port}`;
await new Promise(resolve=>b.listen(0,'127.0.0.1',resolve));second=`http://127.0.0.1:${b.address().port}`;
const check=label=>{checks.push(label);console.log('PASS '+label);};
try{
  context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,viewport:{width:1200,height:900},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('transport-probe.html',worker.url()).href);
  png=Buffer.from(await page.evaluate(async()=>{
    const canvas=new OffscreenCanvas(800,1200),ctx=canvas.getContext('2d');ctx.fillStyle='#eef2ff';ctx.fillRect(0,0,800,1200);ctx.fillStyle='#365';ctx.font='35px sans-serif';ctx.fillText('Generic cross-origin image',40,100);
    return [...new Uint8Array(await(await canvas.convertToBlob()).arrayBuffer())];
  }));
  const read=input=>page.evaluate(async input=>{
    const {fetchSourceImage,readInlineSourceImage}=await import(chrome.runtime.getURL('transport-probe.js'));
    try{
      const blob=input.inline?await readInlineSourceImage(input.url,input.pageUrl,undefined,input.policy):(await fetchSourceImage(input.url,undefined,input.headers,input.pageUrl?{pageUrl:input.pageUrl,referrerPolicy:input.policy}:undefined)).blob;
      return {ok:true,size:blob.size,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('')};
    }catch(error){return {ok:false,error:error.message,origins:error.origins};}
  },input);
  assert.equal((await read({url:second+'/protected.png'})).ok,false);
  assert.equal((await read({url:second+'/protected.png',pageUrl:first+'/chapter/1',inline:true})).hash,hash(png));
  check('Unknown website uses the production inline transport: no CORS headers, missing Referer fails, generic page context succeeds');
  assert.equal((await read({url:first+'/redirect',pageUrl:first+'/chapter/1',headers:{'X-Fixture-Marker':'first-origin-only'}})).hash,hash(png));
  assert.equal(requests.at(-2).marker,'first-origin-only');assert.equal(requests.at(-1).marker,null);assert.equal(requests.at(-1).referer,first+'/');
  check('Real manual redirect reads Location through webRequest, checks the next origin and recomputes headers without forwarding site overrides');
  const denied=await read({url:first+'/ungranted',pageUrl:first+'/chapter/1'});
  assert.deepEqual(denied.origins,[first.replace('127.0.0.1','localhost')+'/*']);assert(!requests.some(r=>r.path==='/never.png'));
  check('Unpermitted redirect destination is reported before any request reaches it');
  const start=requests.length;assert.equal((await read({url:first+'/loop',pageUrl:first+'/chapter/1'})).ok,false);assert.equal(requests.length,start+1);
  check('Redirect loop stops after one request');
  await read({url:second+'/plain.png',pageUrl:first+'/chapter/1',policy:'no-referrer'});assert.equal(requests.at(-1).referer,null);
  await read({url:second+'/plain.png',pageUrl:first+'/chapter/1?fixture=yes#hidden',policy:'unsafe-url'});assert.equal(requests.at(-1).referer,first+'/chapter/1?fixture=yes');
  check('Explicit no-referrer and full-URL policies are honored; fragments are omitted');
  await context.addCookies([{name:'image_fixture',value:'allowed',url:first,sameSite:'Lax'}]);
  assert.equal((await read({url:first+'/cookie.png',pageUrl:first+'/chapter/1'})).hash,hash(png));
  check('Source browser cookies remain local and can satisfy an authorized image request');
  const count=requests.length;
  await Promise.all([read({url:first+'/slow.png',pageUrl:first+'/chapter/a'}),read({url:first+'/slow.png',pageUrl:first+'/chapter/b'})]);
  assert.deepEqual(requests.slice(count).map(r=>r.referer).sort(),[first+'/chapter/a',first+'/chapter/b']);
  check('Concurrent reads of the same URL keep independent page contexts');
  const aborted=await page.evaluate(async url=>{
    const {fetchSourceImage}=await import(chrome.runtime.getURL('transport-probe.js'));const controller=new AbortController();setTimeout(()=>controller.abort(),50);
    try{await fetchSourceImage(url,controller.signal,undefined,{pageUrl:url});return false;}catch(error){return error.name==='AbortError';}
  },first+'/slow.png');assert(aborted);
  const rules=await page.evaluate(()=>chrome.declarativeNetRequest.getSessionRules());assert.equal(rules.filter(r=>r.id>=800000&&r.id<900000).length,0);
  check('Aborted and completed requests leave no image header rules');
  assert.deepEqual(errors,[]);
  const report={checks,errors,requests,browser:context.browser()?.version(),liveSites:false};
  await page.locator('#report').evaluate((element,value)=>{element.textContent=value;},checks.join('\n'));
  await page.screenshot({path:path.join(out,'verified.png')});await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log('Artifacts: '+out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,requests,errors,error:error.stack},null,2));throw error;}
finally{await context?.close();a.closeAllConnections();b.closeAllConnections();await Promise.all([new Promise(resolve=>a.close(resolve)),new Promise(resolve=>b.close(resolve))]);}
