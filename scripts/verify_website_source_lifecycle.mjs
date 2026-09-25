// Isolated MV3 browser acceptance: actual embedded site button, trusted background,
// managed discovery tabs, on-demand page reads and explicit retained downloads.
// Build apps/extension first. All website/API requests below use local synthetic responses.
// The isolated TLS fixture needs Python with cryptography installed.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import path from 'node:path';
import assert from 'node:assert/strict';
import {catalogKeyScript,catalogResponse} from '../apps/extension/src/sources/sites/mangacopy/tests/http-fixture.mjs';
const root=process.cwd(),out=path.join(root,'artifacts/source-architecture/website');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let reader,imagesOffline=false,extensionImageReads=0;const checks=[],errors=[],imageRequests=[];
const chapter='724f819b-5306-11ea-b7ea-024352452ce0';
function png(){const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};const chunk=(type,data)=>{const name=Buffer.from(type),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return out;};const header=Buffer.alloc(13);header.writeUInt32BE(800);header.writeUInt32BE(1200,4);header[8]=8;header[9]=2;const rows=Buffer.alloc(2401*1200);for(let y=0;y<1200;y++)for(let x=0;x<800;x++){const at=y*2401+1+x*3,panel=x>45&&x<755&&y%380>30&&y%380<345;rows[at]=panel?60+Math.floor(y/380)*40:235;rows[at+1]=panel?120+Math.floor(x/20):242;rows[at+2]=panel?210:250;}return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
const original=png();
const images=createHttpServer((request,response)=>{extensionImageReads++;imageRequests.push(request.url);response.writeHead(imagesOffline?503:200,{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'});response.end(imagesOffline?'Source offline':original);});await new Promise(resolve=>images.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+images.address().port;
execFileSync(process.env.PYTHON||'python',['-c',`import sys,datetime,pathlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
p=pathlib.Path(sys.argv[1]); key=rsa.generate_private_key(public_exponent=65537,key_size=2048); name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'www.mangacopy.com')]); now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('www.mangacopy.com')]),False).sign(key,hashes.SHA256())
(p/'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())); (p/'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))`,profile]);
const html=url=>{
 const slug=url.pathname.split('/')[2],title=slug==='navigation'?'只读分类验收':slug==='retained'?'网站离线验收':'网站按需验收';
 return url.pathname.includes('/chapter/')
  ?`<title>${title} 第1话</title><span class="comicCount">2</span><ul class="comicContent-list"><li><img data-src="${origin}/${slug}/1.png"></li><li><img data-src="${origin}/${slug}/2.png"></li></ul>`
  :`<title>${title}</title><div class="comicParticulars-title-right"><h6>${title}</h6></div>`;
};
const responseFor=url=>{
 const slug=url.pathname.split('/')[2];
 if(url.pathname.startsWith('/comicdetail/'))return catalogResponse(slug,slug==='navigation'
  ?[{id:'custom',title:'站点自定义分类',chapters:[{id:chapter,title:'内容 A',type:'特别企划'},{id:'724f819b-5306-11ea-b7ea-024352452ce1',title:'内容 B',type:'其他'}]}]
  :[{id:'default',title:'默认',chapters:[{id:chapter,title:'第1话'}]}]);
 return (url.pathname.includes('/chapter/')?'':catalogKeyScript)+html(url);
};
const site=createHttpsServer({key:await readFile(path.join(profile,'fixture-key.pem')),cert:await readFile(path.join(profile,'fixture-cert.pem'))},(request,response)=>{response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(responseFor(new URL(request.url,'https://www.mangacopy.com')));});await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const options={headless:true,executablePath:process.env.TEST_CHROMIUM,locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP www.mangacopy.com 127.0.0.1:'+site.address().port+', MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']};
let context=await chromium.launchPersistentContext(profile,options);
async function routes(){
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
}
async function state(){return reader.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('node-comics-reading-v2-catalog');open.onerror=()=>reject(open.error);open.onsuccess=()=>{try{const db=open.result,tx=db.transaction(['entries','pageDescriptors','tasks'],'readonly'),documents=tx.objectStore('entries').getAll(),pages=tx.objectStore('pageDescriptors').getAll(),tasks=tx.objectStore('tasks').getAll();tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{resolve({documents:documents.result,pages:pages.result,tasks:tasks.result});db.close();};}catch(error){reject(error);}};}));}
async function imports(slug,offline){
  const source=await context.newPage();await source.goto('https://www.mangacopy.com/comic/'+slug);
  const button=source.getByRole('button',{name:'NodeLane Comics · 导入/管理漫画',exact:true});await button.waitFor();
  await source.screenshot({path:path.join(out,slug+'-embedded.png')});
  const created=context.waitForEvent('page');await button.click();reader=await created;await reader.waitForURL(/reader\.html\?catalog=/);
  await rendered();
  if(offline){await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.getByRole('button',{name:'下载原图',exact:true}).click();await reader.getByRole('button',{name:'关闭面板',exact:true}).click();}
  await source.close();checks.push('适配网站按钮直接阅读，自动登记唯一来源'+(offline?'，显式保存原图':''));
}
async function waitDocument(predicate){for(let n=0;n<100;n++){const value=await state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Document state timed out: '+JSON.stringify(await state()));}
async function noManagedTabs(){return reader.evaluate(async()=>{const managed=await chrome.storage.session.get(null);return Object.keys(managed).filter(key=>key.startsWith('nc-managed:'));});}
async function cacheCount(name){return reader.evaluate(name=>new Promise((resolve,reject)=>{const open=indexedDB.open('node-comics-reading-v2-'+name);open.onerror=()=>reject(open.error);open.onsuccess=()=>{try{const db=open.result,count=db.transaction('metadata').objectStore('metadata').count();count.onsuccess=()=>{resolve(count.result);db.close();};count.onerror=()=>reject(count.error);}catch(error){reject(error);}};}),name);}
async function rendered(){await reader.waitForFunction(()=>{const image=document.querySelector('img.nc-page-image');return image?.complete&&image.naturalWidth===800&&image.naturalHeight===1200;},{},{timeout:30000});}
try{
  await routes();let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  for(let attempt=0;attempt<50&&!await worker.evaluate(()=>!!globalThis.chrome?.storage?.local);attempt++)await new Promise(resolve=>setTimeout(resolve,100));
  await worker.evaluate(()=>chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN'}}));
  const warm=await context.newPage();await warm.goto(new URL('reader.html',worker.url()).href);await warm.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await warm.close();
  const navigationSource=await context.newPage();await navigationSource.goto('https://www.mangacopy.com/comic/navigation');
  const opened=context.waitForEvent('page');await navigationSource.getByRole('button',{name:'NodeLane Comics · 导入/管理漫画',exact:true}).click();reader=await opened;
  const navigation=reader.getByRole('region',{name:'选择开始阅读的位置'});await navigation.waitFor();assert.equal(await reader.getByRole('dialog').count(),0);assert.equal((await state()).pages.length,0);
  await navigation.locator('summary').filter({hasText:'站点自定义分类'}).click();assert.equal(await navigation.getByRole('button',{name:/编辑|归属|版本/}).count(),0);await navigation.getByText('特别企划',{exact:true}).waitFor();
  await navigation.getByRole('button',{name:'正序 ↑',exact:true}).click();assert((await navigation.locator('.nc-chapter-entry').first().innerText()).includes('内容 B'));
  await reader.screenshot({path:path.join(out,'readonly-directory.png')});assert(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await navigation.getByRole('button',{name:/内容 A/}).click();await rendered();assert.equal((await state()).documents.length,2);await navigationSource.close();await reader.close();checks.push('无默认入口时显示只读自定义目录，标签和倒序可用，选择直接阅读，无全本预抓取');
  await imports('ondemand',false);let value=await state();assert.equal(value.tasks.length,0);
  value=await waitDocument(value=>value.documents.some(doc=>doc.discoveryComplete&&doc.pageCount===2));assert.equal(value.tasks.length,0);assert.deepEqual(await noManagedTabs(),[]);
  const pageLocator=value.pages[0].locator;assert(pageLocator.manifestId);const trusted=await reader.evaluate(async locator=>chrome.runtime.sendMessage({type:'NC_SOURCE_IMAGE',manifestId:locator.manifestId,pageId:locator.sourceId}),pageLocator);assert.equal(trusted.ok,true);assert.equal(trusted.data.url,pageLocator.url);
  assert(extensionImageReads>0);await reader.screenshot({path:path.join(out,'read-after-managed-tab-close.png')});checks.push('Discovery closes managed tab; registered HTTP pages still render without creating a download task');
  await reader.close();await imports('retained',true);value=await waitDocument(value=>value.tasks.some(task=>task.status==='complete'&&task.completed===2));assert.deepEqual(await noManagedTabs(),[]);
  const retainedId=value.tasks.find(task=>task.status==='complete').entryId;checks.push('Explicit download discovers and retains both pages after the managed source tab closes');
  await reader.screenshot({path:path.join(out,'retained-download.png')});
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.getByRole('button',{name:'外观与设置',exact:true}).click();
  await reader.locator('.setting-row').filter({has:reader.getByText('原图页缓存',{exact:true})}).getByRole('button',{name:'清理',exact:true}).click();
  await reader.locator('.setting-row').filter({has:reader.getByText('缩略图',{exact:true})}).getByRole('button',{name:'清理',exact:true}).click();
  assert.equal(await cacheCount('source-pages'),0);assert.equal(await cacheCount('downloads'),2);checks.push('Clearing automatic source pages and thumbnails preserves both explicit downloads');
  await context.close();imagesOffline=true;context=await chromium.launchPersistentContext(profile,options);await routes();worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');reader=await context.newPage();await reader.goto(new URL('reader.html',worker.url()).href);
  const beforeReads=imageRequests.filter(url=>url.startsWith('/retained/')).length;const card=reader.locator('article.nc-book').filter({has:reader.getByRole('button',{name:'打开漫画 网站离线验收',exact:true})});await card.getByRole('button',{name:'继续阅读',exact:true}).click();await rendered();
  assert.equal(imageRequests.filter(url=>url.startsWith('/retained/')).length,beforeReads);assert((await state()).tasks.some(task=>task.entryId===retainedId&&task.status==='complete'));await reader.screenshot({path:path.join(out,'retained-offline-after-restart.png')});checks.push('Browser restart reads retained pages while source responses fail, without another retained-source fetch');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,extensionImageReads,originalBytes:original.length,liveSites:false,browser:context.browser()?.version()},null,2));console.log(JSON.stringify({checks,errors,extensionImageReads},null,2));
}catch(error){if(reader&&!reader.isClosed()){await reader.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await reader.locator('body').innerText());await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors,state:await state().catch(String),runtime:await reader.evaluate(async()=>({session:await chrome.storage.session.get(null),tabs:await chrome.tabs.query({}),manifests:Object.keys(await chrome.storage.local.get(null)).filter(key=>key.startsWith('manifest:'))})),pages:await Promise.all(context.pages().map(async page=>({url:page.url(),body:await page.locator('body').innerText().catch(String)})))},null,2));}throw error;}finally{await context.close();await Promise.all([new Promise(resolve=>site.close(resolve)),new Promise(resolve=>images.close(resolve))]);}
