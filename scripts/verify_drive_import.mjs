// Compiled MV3 acceptance with a fresh profile and local TLS/DNS fixtures only.
// Build with VITE_DRIVE_CONNECT_URL first. Requires Playwright and Python cryptography.
// Google account, GIS, Picker, metadata and bytes are synthetic; no real OAuth or Drive.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts/source-architecture/drive');await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-')),extension=path.join(run,'extension'),profile=path.join(run,'profile');
await mkdir(profile);await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const nativeMode=process.env.TEST_DRIVE_AUTH_MODE==='chrome';
const manifestPath=path.join(extension,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
if(nativeMode) assert(manifest.oauth2?.client_id,'Chrome mode needs a configured Chrome OAuth build.');
else {delete manifest.oauth2;await writeFile(manifestPath,JSON.stringify(manifest));}
const background=await readFile(path.join(extension,'background.js'),'utf8');
const configured=process.env.TEST_DRIVE_CONNECT_URL??background.match(/https:\/\/[^"'`\s<>]+\/drive-connect\/index\.html/)?.[0];
assert(configured&&background.includes(configured),'Build the extension with a configured HTTPS Drive connect URL.');
const bridge=new URL(configured);assert.equal(bridge.protocol,'https:');assert.equal(bridge.port,'');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const format=process.env.TEST_DRIVE_FORMAT??'cbz';assert(['cbz','mobi'].includes(format),'TEST_DRIVE_FORMAT must be cbz or mobi');
const original=await readFile(path.join(root,`artifacts/import-validation/pages.${format}`));
const protectedMobi=Buffer.from(original);
if(format==='mobi')protectedMobi.writeUInt16BE(1,original.readUInt32BE(78)+12);
const mimeType=format==='mobi'?'application/octet-stream':'application/zip';
const sample=await readFile(path.join(root,'artifacts/import-validation/1.png')),dimensions=[sample.readUInt32BE(16),sample.readUInt32BE(20)];
const fileChecks=new Map();
const hosts=[bridge.hostname,'accounts.google.com','apis.google.com','www.googleapis.com'];
const stats={authorizations:0,pickers:0,accountChecks:0,metadataChecks:0,rangeReads:0,browserAccountProbes:0,unauthorized:0,unsupported:0,nativeGrants:0,nativeInteractiveCalls:0,nativeSilentCalls:0};
const checks=[],pageErrors=[],unsupportedRoutes=[],networkFailures=[];let chosenFile='fixture-page',cancelPicker=false,failMetadataFor,phase='bootstrap';
const token=randomBytes(32).toString('hex');
execFileSync(process.env.PYTHON||'python',['-c',`import sys,datetime,pathlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
p=pathlib.Path(sys.argv[1]); hosts=sys.argv[2:]; key=rsa.generate_private_key(public_exponent=65537,key_size=2048); name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,hosts[0])]); now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName(h) for h in hosts]),False).sign(key,hashes.SHA256())
(p/'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())); (p/'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))`,profile,...hosts]);
const gis=`globalThis.google??={};google.accounts={oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:options=>({requestAccessToken:()=>fetch('https://accounts.google.com/fixture-authorize',{method:'POST'}).then(()=>options.callback({access_token:${JSON.stringify(token)},expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'}))})}};`;
const picker=`globalThis.google??={};globalThis.gapi={load:(_module,options)=>options.callback()};google.picker={ViewId:{DOCS:'docs'},Feature:{MULTISELECT_ENABLED:'multi'},Action:{CANCEL:'cancel',PICKED:'picked'},Response:{DOCUMENTS:'docs'},Document:{ID:'id'},DocsView:class{setMimeTypes(){throw Error("Picker must show unknown MIME types")}setIncludeFolders(value){this.includeFolders=value;return this}setSelectFolderEnabled(value){this.selectFolders=value;return this}},PickerBuilder:class{setDeveloperKey(){return this}setAppId(){return this}setOAuthToken(token){if(token!==${JSON.stringify(token)})throw Error('Unexpected fixture credential');return this}setOrigin(){return this}enableFeature(){return this}addView(view){if(view.includeFolders!==true||view.selectFolders!==false)throw Error("Folders must be browsable but not importable");return this}setCallback(callback){this.callback=callback;return this}build(){const callback=this.callback;return {dispose(){},setVisible(visible){if(visible)fetch('https://www.googleapis.com/fixture-picker',{method:'POST'}).then(response=>response.json()).then(value=>callback({action:value.cancel?'cancel':'picked',docs:value.fileId?[{id:value.fileId}]:[]}))}}}}};`;
const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});response.end(JSON.stringify(value));};
const server=createServer({key:await readFile(path.join(profile,'fixture-key.pem')),cert:await readFile(path.join(profile,'fixture-cert.pem'))},(request,response)=>{
  void(async()=>{
    const host=request.headers.host?.split(':')[0],url=new URL(request.url,'https://'+host);
    if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Range','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});response.end();return;}
    if(host===bridge.hostname){
      const sharedAssets={'/design-tokens.css':'text/css','/icon-128.png':'image/png','/favicon.ico':'image/x-icon'};
      if(Object.hasOwn(sharedAssets,url.pathname)){response.writeHead(200,{'Content-Type':sharedAssets[url.pathname]});response.end(await readFile(path.join(root,'backend/website/public',url.pathname.slice(1))));return;}
      const base=new URL('.',bridge).pathname,name=url.pathname===bridge.pathname?'index.html':url.pathname.startsWith(base)?url.pathname.slice(base.length):'';
      if(name==='config.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end('globalThis.NODE_COMICS_DRIVE_CONFIG={clientId:"fixture-client",apiKey:"fixture-public-key",appId:"123456"};');return;}
      if(['index.html','connect.js','style.css'].includes(name)){response.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html;charset=utf-8':name.endsWith('.js')?'text/javascript':'text/css'});response.end(await readFile(path.join(root,'apps/drive-connect',name)));return;}
      response.writeHead(404);response.end();return;
    }
    if(host==='accounts.google.com'&&url.pathname==='/gsi/client'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(gis);return;}
    if(host==='apis.google.com'&&url.pathname==='/js/api.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(picker);return;}
    if(host==='accounts.google.com'&&url.pathname==='/fixture-authorize'){stats.authorizations++;json(response,{});return;}
    if(host==='accounts.google.com'&&url.pathname==='/ListAccounts'){stats.browserAccountProbes++;json(response,{},503);return;}
    if(host==='www.googleapis.com'&&url.pathname==='/fixture-picker'){stats.pickers++;json(response,{fileId:chosenFile,cancel:cancelPicker});return;}
    if(host==='www.googleapis.com'&&url.pathname==='/fixture-native-token'){
      assert(nativeMode);let body='';for await(const chunk of request)body+=chunk;
      const {interactive}=JSON.parse(body);if(interactive)stats.nativeInteractiveCalls++;else stats.nativeSilentCalls++;
      if(!stats.nativeGrants){if(!interactive){json(response,{},401);return;}stats.nativeGrants++;}
      json(response,{token,grantedScopes:['https://www.googleapis.com/auth/drive.file']});return;
    }
    if(host==='www.googleapis.com'&&url.pathname.startsWith('/drive/v3/')){
      if(request.headers.authorization!=='Bearer '+token){stats.unauthorized++;json(response,{},401);return;}
      if(url.pathname==='/drive/v3/about'){stats.accountChecks++;json(response,{user:{permissionId:'fixture-account',displayName:'隔离测试 Drive',emailAddress:'reader@example.test'}});return;}
      const fileId=url.pathname.split('/').at(-1);
      if(!['fixture-page','fixture-error','fixture-drm'].includes(fileId)){stats.unsupported++;unsupportedRoutes.push({method:request.method,route:'drive-file-unknown'});json(response,{},404);return;}
      const fileBytes=fileId==='fixture-drm'?protectedMobi:original;
      if(url.searchParams.get('alt')!=='media'){
        stats.metadataChecks++;fileChecks.set(fileId,(fileChecks.get(fileId)||0)+1);if(fileId===failMetadataFor&&fileChecks.get(fileId)>1){json(response,{},503);return;}
        json(response,{id:fileId,name:`Drive ${fileId==='fixture-page'?'隔离漫画':fileId==='fixture-drm'?'受保护漫画':'隔离错误'}.${format}`,mimeType,size:String(fileBytes.length),version:'1',capabilities:{canDownload:true},trashed:false});return;
      }
      stats.rangeReads++;const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.range??'');
      if(!range){json(response,{},416);return;}const begin=Number(range[1]),end=Number(range[2]);
      if(begin<0||end>=fileBytes.length||end<begin){json(response,{},416);return;}
      const bytes=fileBytes.subarray(begin,end+1);response.writeHead(206,{'Content-Type':mimeType,'Content-Length':bytes.length,'Content-Range':`bytes ${begin}-${end}/${fileBytes.length}`,'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Content-Range,Content-Length'});response.end(bytes);return;
    }
    stats.unsupported++;unsupportedRoutes.push({method:request.method,route:url.pathname});json(response,{},404);
  })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const resolver=hosts.map(host=>`MAP ${host} 127.0.0.1:${server.address().port}`).join(', ')+', MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
let context,reader;
const installNativeFixture=async worker=>{
  if(!nativeMode)return;
  await worker.evaluate(()=>{
    chrome.identity.getAuthToken=async details=>{
      const response=await fetch('https://www.googleapis.com/fixture-native-token',{method:'POST',body:JSON.stringify({interactive:details.interactive})});
      if(!response.ok)throw Error('Fixture needs explicit connection');
      return response.json();
    };
    chrome.identity.removeCachedAuthToken=async()=>{};
  });
};
const noReaderError=async()=>assert.equal(await reader.getByRole('alert').count(),0,'Reader must keep waiting for Drive selection instead of accepting a competing message response.');
try{
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM||chromium.executablePath(),locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1400,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules='+resolver]});
  context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.name)));
  context.on('requestfailed',request=>{if(new URL(request.url()).hostname==='www.googleapis.com')networkFailures.push({kind:new URL(request.url()).searchParams.get('alt')==='media'?'media':'metadata',error:request.failure()?.errorText});});
  await context.route('https://**.nodelane.net/**',route=>new URL(route.request().url()).hostname===bridge.hostname?route.continue():route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  for(let n=0;n<50&&!await worker.evaluate(()=>!!globalThis.chrome?.storage?.local);n++)await new Promise(resolve=>setTimeout(resolve,100));
  await worker.evaluate(()=>chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN'}}));
  await installNativeFixture(worker);
  reader=await context.newPage();await reader.goto(new URL('reader.html',worker.url()).href);
  await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await reader.reload();
  const sourceReply=await reader.evaluate(()=>chrome.runtime.sendMessage({type:'NC_SOURCE_IMAGE',manifestId:'fixture-missing-manifest',pageId:'missing'}));
  assert.equal(sourceReply?.ok,false);
  checks.push('The compiled website-source listener is active alongside the Drive listener');
  const catalogCounts=()=>reader.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-reading-v2-catalog');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const counts=await Promise.all(['connections','comics'].map(name=>new Promise((resolve,reject)=>{const request=db.transaction(name).objectStore(name).count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);})));db.close();return counts;
  });
  const checkAccount=async name=>{
    const before={...stats},records=await catalogCounts();
    await reader.getByRole('button',{name:'外观与设置'}).click();
    const accounts=reader.locator('.nc-source-accounts');await accounts.getByText('reader@example.test',{exact:true}).waitFor();
    await accounts.getByText('已连接',{exact:true}).waitFor();assert.equal(await accounts.getByText(/暂无云盘账户/).count(),0);
    assert((await accounts.locator('.nc-source-account').boundingBox()).height<110);
    await accounts.screenshot({path:path.join(run,name+'.png')});
    assert.deepEqual(stats,before,'Account display must not initiate authorization, probe browser accounts or load comic bytes');
    assert.deepEqual(await catalogCounts(),records,'Reading account information must not register comic access');
    await reader.getByRole('button',{name:'我的漫画',exact:true}).click();
  };
  const select=async()=>{
    phase='open authorization';
    const readerWindow=await reader.evaluate(()=>chrome.windows.getCurrent({populate:true}));
    assert.equal(await reader.getByRole('button',{name:'Google Drive',exact:true}).count(),0,'The bookshelf should expose one generic import entry.');
    await reader.getByRole('button',{name:'云盘',exact:true}).click();
    const opened=context.waitForEvent('page');await reader.getByRole('menuitem',{name:'Google Drive',exact:true}).click();const auth=await opened;
    await auth.waitForURL(url=>url.origin===bridge.origin&&url.pathname===bridge.pathname);
    const windows=await worker.evaluate(()=>chrome.windows.getAll({populate:true}));
    const popup=windows.find(window=>window.type==='popup');
    assert(popup,'Drive selection must open a popup window');
    assert.notEqual(popup.id,readerWindow.id);
    assert.equal(popup.tabs.length,1);
    assert.deepEqual(windows.find(window=>window.id===readerWindow.id).tabs.map(tab=>tab.id),readerWindow.tabs.map(tab=>tab.id),'Opening Drive must not add a tab to the reader window');
    // Playwright's fixed viewport overrides window bounds; inspect the page at
    // the popup's actual content size as well as checking its native window type.
    await auth.setViewportSize({width:1000,height:720});
    phase='authorization ready';
    // A reused or Chrome-managed connection opens Picker automatically. Only a fresh
    // web authorization needs the button that launches GIS from a user gesture.
    if(!nativeMode&&stats.authorizations===0){
      await auth.waitForFunction(()=>!document.getElementById('connect')?.disabled,{},{timeout:15000});await noReaderError();
      phase='pick and deliver';await auth.locator('#connect').click();
    }
    if(!cancelPicker&&chosenFile){
      if(!auth.isClosed())await auth.waitForEvent('close');
      const remaining=await worker.evaluate(()=>chrome.windows.getAll());
      assert(!remaining.some(window=>window.id===popup.id),'Successful file selection must close its popup');
      assert(remaining.some(window=>window.id===readerWindow.id),'The reader window must remain open');
    }else{
      await auth.getByRole('status').filter({hasText:cancelPicker?'已取消选择':'连接已完成'}).waitFor();
      assert(await auth.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Popup content must fit without horizontal scrolling');
      await auth.screenshot({path:path.join(run,cancelPicker?'drive-popup-cancelled.png':'drive-popup.png'),fullPage:true});
      assert(!auth.isClosed(),'Cancellation and account-only connections must leave the popup open');
      if(cancelPicker)assert(await auth.locator('#connect').isEnabled(),'Cancellation must allow another selection');
      await worker.evaluate(id=>chrome.windows.remove(id),popup.id);
    }
  };
  if(nativeMode){
    cancelPicker=true;await select();await reader.getByRole('alert').waitFor();cancelPicker=false;
    assert.deepEqual(await catalogCounts(),[0,0]);await checkAccount('account-without-import');
    checks.push('Chrome connection followed by Picker cancellation appears in settings with no catalog account or comic, without extra authorization or database writes');
  }
  chosenFile=undefined;await select();await reader.getByRole('status').filter({hasText:'Google Drive 已连接'}).waitFor();
  assert.deepEqual(await catalogCounts(),[1,0]);await checkAccount('account-only-connection');
  checks.push('An account-only selection saves its verified name and email even with zero imported files');
  if(!nativeMode){
    cancelPicker=true;await select();await reader.getByRole('alert').waitFor();cancelPicker=false;
    assert.deepEqual(await catalogCounts(),[1,0]);
  }
  checks.push('Cancelling Picker keeps its popup open with file selection enabled and imports no files');
  chosenFile='fixture-page';const initialPickers=stats.pickers;
  await select();assert.equal(stats.authorizations,nativeMode?0:1);assert.equal(stats.pickers,initialPickers+1);
  checks.push('Drive opens in a separate popup without adding a tab to the reader window');
  checks.push('Successful file selection automatically closes the popup while keeping the reader open');
  checks.push('云盘选择完成后直接导入，无资料、归属或登记确认');
  phase='decode original';await reader.waitForFunction(([width,height])=>{const image=document.querySelector('img.nc-page-image');return image?.complete&&image.naturalWidth===width&&image.naturalHeight===height;},dimensions,{timeout:15000});
  await noReaderError();assert(stats.rangeReads>0);await reader.screenshot({path:path.join(run,'reader.png')});checks.push('Confirmed Drive reference is registered and the real reader decodes the synthetic original through authenticated Range reads');
  phase='restore reading position';
  const pageNumber=reader.getByRole('spinbutton',{name:'跳转页码'});await pageNumber.fill('2');await pageNumber.press('Enter');
  await reader.waitForFunction(()=>{const image=document.querySelector('[data-page-index="1"] img.nc-page-image');return image?.complete&&image.naturalWidth>0;});
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await reader.getByRole('button',{name:'继续阅读',exact:true}).click();
  await reader.waitForFunction(()=>{const image=document.querySelector('[data-page-index="1"] img.nc-page-image');return image?.complete&&image.naturalWidth>0;});
  assert.equal(await pageNumber.inputValue(),'2');
  await noReaderError();await reader.screenshot({path:path.join(run,'restored-page.png')});checks.push(`${format.toUpperCase()} resumes page 2 after returning to the shelf and reopening`);
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();chosenFile='fixture-error';failMetadataFor='fixture-error';
  const firstChecks=stats.accountChecks;await select();assert.equal(stats.authorizations,nativeMode?0:1);assert.equal(stats.pickers,initialPickers+2);assert(stats.accountChecks>firstChecks);
  checks.push('A second selection reuses the unexpired token without another GIS authorization and still verifies account/file access');
  phase='show import failure';await reader.getByRole('alert').waitFor();assert((await reader.getByRole('alert').innerText()).trim());await reader.screenshot({path:path.join(run,'import-error.png')});checks.push('云盘索引失败在书架显示可操作原因，不建立空漫画');
  if(format==='mobi'){
    chosenFile='fixture-drm';phase='reject protected MOBI';await select();
    await reader.getByRole('alert').filter({hasText:'DRM'}).waitFor();
    assert.deepEqual(await catalogCounts(),[1,1]);await reader.screenshot({path:path.join(run,'mobi-drm-error.png')});
    checks.push('The shared MOBI Worker rejects DRM with a visible cause and no empty comic');
  }
  if(nativeMode){
    phase='restart browser';await context.close();
    context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM||chromium.executablePath(),locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1400,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules='+resolver]});
    await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
    const restarted=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    await installNativeFixture(restarted);
    const before=stats.nativeSilentCalls;
    const state=await restarted.evaluate(async()=>({hasSession:!!(await chrome.storage.session.get('nc-drive-token:fixture-account'))['nc-drive-token:fixture-account'],
      hasConnection:!!(await chrome.storage.local.get('nc-drive-chrome-connection:fixture-account'))['nc-drive-chrome-connection:fixture-account']}));
    assert.deepEqual(state,{hasSession:false,hasConnection:true});
    reader=await context.newPage();await reader.goto(new URL('reader.html',restarted.url()).href);
    const restored=await reader.evaluate(async()=>{const reply=await chrome.runtime.sendMessage({type:'NC_DRIVE_TOKEN',accountId:'fixture-account'});return {ok:reply.ok,managed:reply.provider==='chrome',hasToken:typeof reply.accessToken==='string'};});
    assert.deepEqual(restored,{ok:true,managed:true,hasToken:true});assert(stats.nativeSilentCalls>before);assert.equal(stats.nativeGrants,1);assert.equal(stats.authorizations,0);
    checks.push('After a real isolated browser restart clears session storage, the saved connection restores through the mocked noninteractive Chrome API without another grant or GIS popup');
    const disconnected=await reader.evaluate(async()=>{await chrome.runtime.sendMessage({type:'NC_DRIVE_DISCONNECT',accountId:'fixture-account'});const reply=await chrome.runtime.sendMessage({type:'NC_DRIVE_TOKEN',accountId:'fixture-account'});return {ok:reply.ok,code:reply.code};});
    assert.deepEqual(disconnected,{ok:false,code:'reconnect-required'});
    checks.push('An explicit disconnect prevents automatic credential restoration');
  }
  assert.deepEqual(pageErrors,[]);assert.equal(stats.unauthorized,0);assert.equal(stats.unsupported,0);
  const result={checks,stats,pageErrors,dimensions,format,authMode:nativeMode?'mocked-chrome-identity':'mocked-gis',liveGoogle:false,liveAccounts:false,browser:context.browser()?.version()};await writeFile(path.join(run,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
  if(reader&&!reader.isClosed())await reader.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});
  // Never record authorization URLs, page HTML, token storage or raw network diagnostics.
  const failure={checks,stats,pageErrors,unsupportedRoutes,networkFailures,phase,errorType:error.name,liveGoogle:false,liveAccounts:false};await writeFile(path.join(run,'failure.json'),JSON.stringify(failure,null,2));console.error(JSON.stringify(failure,null,2));process.exitCode=1;
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
