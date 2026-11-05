import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
// Opt-in, per-book directory checks: isolated MV3, local synthetic site, real adapter and UI.
// Build apps/extension first. All website/API requests below use local synthetic responses.
// The isolated TLS fixture needs Python with cryptography installed.
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import path from 'node:path';
import assert from 'node:assert/strict';
import {catalogKeyScript,catalogResponse} from '../apps/extension/src/sources/sites/mangacopy/tests/http-fixture.mjs';
const root=process.cwd(),out=path.join(root,'output/playwright/catalog-sync');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=path.join(root,'apps/extension/.output/chrome-mv3'),profile=await mkdtemp(path.join(out,'profile-'));
let reader,extensionImageReads=0;const checks=[],errors=[];
const chapter='724f819b-5306-11ea-b7ea-024352452ce0';
function png(){const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};const chunk=(type,data)=>{const name=Buffer.from(type),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return out;};const header=Buffer.alloc(13);header.writeUInt32BE(800);header.writeUInt32BE(1200,4);header[8]=8;header[9]=2;const rows=Buffer.alloc(2401*1200);for(let y=0;y<1200;y++)for(let x=0;x<800;x++){const at=y*2401+1+x*3,panel=x>45&&x<755&&y%380>30&&y%380<345;rows[at]=panel?60+Math.floor(y/380)*40:235;rows[at+1]=panel?120+Math.floor(x/20):242;rows[at+2]=panel?210:250;}return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
const original=png();
const images=createHttpServer((_request,response)=>{extensionImageReads++;response.writeHead(200,{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'});response.end(original);});await new Promise(resolve=>images.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+images.address().port;
execFileSync(process.env.PYTHON||'python',['-c',`import sys,datetime,pathlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
p=pathlib.Path(sys.argv[1]); key=rsa.generate_private_key(public_exponent=65537,key_size=2048); name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'www.mangacopy.com')]); now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('www.mangacopy.com')]),False).sign(key,hashes.SHA256())
(p/'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())); (p/'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))`,profile]);
const counts={first:2,second:2},failures=new Set(),catalogRequests=[];
const title=slug=>slug==='first'?'星光书店 · 自动更新':'云端列车 · 自动更新';
const chapterId=n=>chapter.slice(0,-1)+n;
const html=url=>{
 const slug=url.pathname.split('/')[2];
 if(url.pathname.includes('/chapter/'))return `<title>${title(slug)} 第1话</title><span class="comicCount">2</span><ul class="comicContent-list"><li><img data-src="${origin}/${slug}/1.png"></li><li><img data-src="${origin}/${slug}/2.png"></li></ul>`;
 if(!url.pathname.startsWith('/comicdetail/'))catalogRequests.push(slug);if(failures.has(slug))return '<title>暂不可用</title><div class="upLoop"><p class="wargin">目录尚未载入</p></div>';
 if(url.pathname.startsWith('/comicdetail/')){
  const chapters=Array.from({length:counts[slug]},(_,n)=>({id:chapterId(n),title:'第'+(n+1)+'话',type:'话'}));
  return catalogResponse(slug,[{id:'default',title:'默认',chapters}]);
 }
 return `${catalogKeyScript}<title>${title(slug)}</title><div class="comicParticulars-title-right"><h6>${title(slug)}</h6></div>`;
};
let holdCatalog=false;const heldResponses=[];
const releaseCatalog=()=>{holdCatalog=false;for(const release of heldResponses.splice(0))release();};
const site=createHttpsServer({key:await readFile(path.join(profile,'fixture-key.pem')),cert:await readFile(path.join(profile,'fixture-cert.pem'))},(request,response)=>{
 const url=new URL(request.url,'https://www.mangacopy.com'),body=html(url),send=()=>{response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(body);};
 if(holdCatalog&&!url.pathname.includes('/chapter/'))heldResponses.push(send);else send();
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP www.mangacopy.com 127.0.0.1:'+site.address().port+', MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(20000);context.setDefaultNavigationTimeout(20000);
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const readerUrl=new URL('reader.html',worker.url()).href;
const probe=await context.newPage();await probe.goto(readerUrl);
async function state(){return probe.evaluate(()=>new Promise((resolve,reject)=>{
 const open=indexedDB.open('node-comics-reading-v2-catalog');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
 const db=open.result,tx=db.transaction(['comics','entries','positions','pageDescriptors']),comics=tx.objectStore('comics').getAll(),entries=tx.objectStore('entries').getAll(),positions=tx.objectStore('positions').getAll(),pages=tx.objectStore('pageDescriptors').getAll();
 tx.oncomplete=()=>{resolve({comics:comics.result,entries:entries.result,positions:positions.result,pages:pages.result});db.close();};tx.onerror=()=>reject(tx.error);
 };}));}

// Advance only isolated fixture records to exercise the twelve-hour automatic gate.
async function makeDue(){await probe.evaluate(()=>new Promise((resolve,reject)=>{
 const r=indexedDB.open('node-comics-reading-v2-catalog');r.onerror=()=>reject(r.error);r.onsuccess=()=>{
 const db=r.result,tx=db.transaction('comics','readwrite'),request=tx.objectStore('comics').getAll();request.onsuccess=()=>{for(const comic of request.result)tx.objectStore('comics').put({...comic,catalogSync:{...comic.catalogSync,nextCheckAt:0}});};
 tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
 };}));}

async function waitFor(check,timeout=45000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await state();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('State timed out: '+JSON.stringify(await state()));}
async function rendered(index=0){await reader.waitForFunction(n=>{const image=document.querySelector(`[data-page-index="${n}"] img.nc-page-image`);return image?.complete&&image.naturalWidth===800;},index);}
const card=slug=>reader.locator('.nc-book').filter({has:reader.getByRole('button',{name:'打开漫画 '+title(slug),exact:true})});
async function shelf(){await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await reader.locator('.nc-library').waitFor();}
async function openReader(){reader=await context.newPage();await reader.goto(readerUrl);await reader.locator('.nc-library').waitFor();}
async function importComic(slug){
 console.log('Import '+slug);
 const source=await context.newPage();await source.goto('https://www.mangacopy.com/comic/'+slug);
 const button=source.getByRole('button',{name:'NodeLane Comics · 导入/管理漫画',exact:true});await button.waitFor();
 const created=context.waitForEvent('page',{predicate:async page=>{try{await page.waitForURL(/reader\.html\?catalog=/,{timeout:10000});return true;}catch{return false;}}});await button.click();reader=await created;await rendered();await source.close();
}
try{
 console.log('Preparing two adapted comics with default-off settings');
 await probe.evaluate(()=>chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN',layout:'single',readerImmersive:false}}));
 await openReader();await reader.goto(readerUrl+'#settings');
 const toggle=()=>reader.getByRole('switch',{name:'自动检查漫画更新',exact:true});
 assert.equal(await toggle().getAttribute('aria-checked'),'false');
 await reader.screenshot({path:path.join(out,'settings-default-off.png')});await reader.close();
 await importComic('first');await setReaderProgress(reader.getByRole('slider',{name:'阅读进度'}),'2');await rendered(1);await shelf();
 const baseline=await waitFor(value=>value.positions.some(position=>value.pages.find(page=>page.pageId===position.pageId)?.ordinal===1));
 const first=baseline.comics.find(comic=>comic.title===title('first')),position=baseline.positions.find(value=>value.comicId===first.id);
 await reader.close();await importComic('second');await shelf();await reader.close();
 counts.first=3;counts.second=3;await makeDue();
 const before=catalogRequests.length;await openReader();await reader.waitForTimeout(2300);
 assert.equal(catalogRequests.length,before,'Opening the shelf must not check any comic');
 await card('first').getByRole('button',{name:/^打开漫画 /}).click();await rendered(1);await reader.waitForTimeout(2300);
 assert.equal(catalogRequests.length,before,'Default-off also applies to an overdue opened comic');
 checks.push('新用户和旧设置默认关闭，打开书架或已到期漫画均不自动请求');
 await shelf();await reader.goto(readerUrl+'#settings');await toggle().click();
 assert.equal(await toggle().getAttribute('aria-checked'),'true');await reader.screenshot({path:path.join(out,'settings-enabled.png')});
 for(let attempt=0;attempt<100;attempt++){if(await probe.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']?.autoCheckComicUpdates===true))break;await reader.waitForTimeout(50);}
 assert(await probe.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']?.autoCheckComicUpdates===true),'The toggle must persist to shared extension settings');
 await reader.reload();assert.equal(await toggle().getAttribute('aria-checked'),'true');await reader.goto(readerUrl);
 holdCatalog=true;
 await card('first').getByRole('button',{name:/^打开漫画 /}).click();await rendered(1);
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();
 await reader.getByRole('button',{name:'正在检查更新…',exact:true}).waitFor();
 assert(await reader.getByRole('button',{name:'正在检查更新…',exact:true}).isDisabled());
 const until=Date.now()+10000;while(!heldResponses.length&&Date.now()<until)await reader.waitForTimeout(50);
 assert(heldResponses.length,'The catalog response is deliberately held');
 const started=performance.now();await setReaderProgress(reader.getByRole('slider',{name:'阅读进度'}),'1');await rendered(0);
 await setReaderProgress(reader.getByRole('slider',{name:'阅读进度'}),'2');await rendered(1);
 const navigationMs=Math.round(performance.now()-started);
 assert(heldResponses.length,'Reading navigation completed before the catalog response');
 await reader.screenshot({path:path.join(out,'checking-while-reading.png')});
 releaseCatalog();await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===3);
 assert.equal((await state()).entries.filter(entry=>entry.comicId!==first.id).length,2);
 assert.equal(await reader.getByRole('slider',{name:'阅读进度'}).inputValue(),'2');
 assert.equal((await state()).positions.find(value=>value.comicId===first.id).pageId,position.pageId);
 await reader.getByText('第3话',{exact:true}).waitFor();await reader.screenshot({path:path.join(out,'updated-directory.png')});
 checks.push({openedOnly:true,readingContinuesWithPendingCatalog:true,twoPageTurnsMs:navigationMs,unopenedBookChecked:false});
 await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await shelf();
 const repeated=catalogRequests.length;await card('first').getByRole('button',{name:/^打开漫画 /}).click();await rendered(1);await reader.waitForTimeout(2300);
 assert.equal(catalogRequests.length,repeated);checks.push('12小时内重复打开不请求，当前页与阅读进度保留');
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();
 const check=()=>reader.getByRole('button',{name:'检查更新',exact:true});
 counts.first=4;await check().click();await reader.getByText('发现新章节，已更新目录。',{exact:true}).waitFor();
 await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===4);
 assert.equal(await reader.getByRole('slider',{name:'阅读进度'}).inputValue(),'2');
 await check().click();await reader.getByText('已检查，暂无新章节。',{exact:true}).waitFor();
 failures.add('first');counts.first=5;await check().click();await reader.getByText('检查更新失败，已保留原目录，请稍后重试。',{exact:true}).waitFor();
 assert.equal((await state()).entries.filter(entry=>entry.comicId===first.id).length,4);
 assert.equal(await reader.getByRole('slider',{name:'阅读进度'}).inputValue(),'2');
 await reader.screenshot({path:path.join(out,'failure-keeps-reading.png')});
 failures.clear();await check().click();await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===5);
 checks.push('手动检查绕过间隔，新增／无更新／失败有轻提示，失败立即重试且保留当前第2页');
 await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await shelf();
 await card('second').click({button:'right'});await reader.getByRole('menuitem',{name:'检查更新',exact:true}).waitFor();
 await reader.screenshot({path:path.join(out,'shelf-check-action.png')});
 await reader.getByRole('menuitem',{name:'检查更新',exact:true}).click();
 await waitFor(value=>value.entries.filter(entry=>entry.comicId!==first.id).length===3);checks.push('书架菜单可单独手动检查未打开漫画');
 counts.first=6;await makeDue();holdCatalog=true;
 await card('first').getByRole('button',{name:/^打开漫画 /}).click();await rendered(1);
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();await reader.getByRole('button',{name:'正在检查更新…',exact:true}).waitFor();
 await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await shelf();releaseCatalog();
 await reader.waitForTimeout(500);assert.equal((await state()).entries.filter(entry=>entry.comicId===first.id).length,5);
 await reader.goto(readerUrl+'#settings');await toggle().click();assert.equal(await toggle().getAttribute('aria-checked'),'false');
 for(let attempt=0;attempt<100;attempt++){if(await probe.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']?.autoCheckComicUpdates===false))break;await reader.waitForTimeout(50);}
 await reader.goto(readerUrl);await makeDue();const disabled=catalogRequests.length;
 await card('first').getByRole('button',{name:/^打开漫画 /}).click();await rendered(1);await reader.waitForTimeout(2300);
 assert.equal(catalogRequests.length,disabled);await reader.getByRole('button',{name:'打开目录',exact:true}).click();
 await check().click();await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===6);
 assert.equal(await reader.getByRole('slider',{name:'阅读进度'}).inputValue(),'2');
 checks.push('离开阅读器取消自动检查，迟到响应不写入；关闭开关仍可手动检查');
 const alarms=await probe.evaluate(()=>chrome.alarms.getAll());
 assert(!alarms.some(alarm=>['nc-catalog-sync','nc-catalog-sync-continue'].includes(alarm.name)));
 await reader.close();await makeDue();const closed=catalogRequests.length;await new Promise(resolve=>setTimeout(resolve,2300));assert.equal(catalogRequests.length,closed);
 checks.push('不再创建目录更新定时器，关闭阅读器不扫描书架');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,browser:context.browser()?.version(),liveSites:false,catalogRequests,extensionImageReads},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){if(reader&&!reader.isClosed()){await reader.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await reader.locator('body').innerText());}await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors,state:await state().catch(String),catalogRequests},null,2));throw error;}
finally{releaseCatalog();await context.close();await Promise.all([new Promise(resolve=>site.close(resolve)),new Promise(resolve=>images.close(resolve))]);}
