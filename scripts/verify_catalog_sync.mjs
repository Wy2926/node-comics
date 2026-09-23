// Automatic directory updates: isolated MV3, local synthetic site, real adapter and alarms.
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
const root=process.cwd(),out=path.join(root,'artifacts/catalog-sync');await mkdir(out,{recursive:true});
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
const counts={first:2,second:2,choose:2},failures=new Set(),catalogRequests=[];
const title=slug=>slug==='first'?'星光书店 · 自动更新':slug==='second'?'云端列车 · 自动更新':'自定义目录 · 无默认入口';
const chapterId=n=>chapter.slice(0,-1)+n;
const html=url=>{
 const slug=url.pathname.split('/')[2];
 if(url.pathname.includes('/chapter/'))return `<title>${title(slug)} 第1话</title><span class="comicCount">2</span><ul class="comicContent-list"><li><img data-src="${origin}/${slug}/1.png"></li><li><img data-src="${origin}/${slug}/2.png"></li></ul>`;
 catalogRequests.push(slug);if(failures.has(slug))return '<title>暂不可用</title><div class="upLoop"><p class="wargin">目录尚未载入</p></div>';
 const links=Array.from({length:counts[slug]},(_,n)=>`<a href="/comic/${slug}/chapter/${chapterId(n)}">第${n+1}话</a>`);
 const group=(id,label,items,type='话')=>`<span>${label}</span><div class="table-default"><div class="tab-pane" id="${id}全部">${items}</div><div class="tab-pane" id="${id}${type}">${items}</div></div>`;
 const categories=[['default','默認'],['custom_translation','其它汉化版'],['arbitrary_fanwork','同人漫画'],['another_series','其他系列'],['new_category_2026','新分类 · 彩色短篇']];
 const directory=slug==='first'?group('default','默认',links.join('')):links.map((link,n)=>group(slug==='choose'?'choice_'+n:categories[n][0],slug==='choose'?'自由分类 '+(n+1):categories[n][1],link,n===4?'彩色短篇':'话')).join('');
 return `<title>${title(slug)}</title><div class="comicParticulars-title-right"><h6>${title(slug)}</h6></div><div class="upLoop">${directory}</div>`;
};
const site=createHttpsServer({key:await readFile(path.join(profile,'fixture-key.pem')),cert:await readFile(path.join(profile,'fixture-cert.pem'))},(request,response)=>{response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(html(new URL(request.url,'https://www.mangacopy.com')));});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP www.mangacopy.com 127.0.0.1:'+site.address().port+', MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(20000);context.setDefaultNavigationTimeout(20000);
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const readerUrl=new URL('reader.html',worker.url()).href;
async function state(){return worker.evaluate(()=>new Promise((resolve,reject)=>{
 const open=indexedDB.open('node-comics-reading-v1-catalog');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
 const db=open.result,tx=db.transaction(['comics','entries','positions','pageDescriptors']),comics=tx.objectStore('comics').getAll(),entries=tx.objectStore('entries').getAll(),positions=tx.objectStore('positions').getAll(),pages=tx.objectStore('pageDescriptors').getAll();
 tx.oncomplete=()=>{resolve({comics:comics.result,entries:entries.result,positions:positions.result,pages:pages.result});db.close();};tx.onerror=()=>reject(tx.error);
 };}));}

// Only isolated fixture records are advanced; the production UI exposes no force-refresh command.
async function makeDue(){await worker.evaluate(()=>new Promise((resolve,reject)=>{
 const r=indexedDB.open('node-comics-reading-v1-catalog');r.onerror=()=>reject(r.error);r.onsuccess=()=>{
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
 const created=context.waitForEvent('page',{predicate:async page=>{try{await page.waitForURL(/reader\.html\?catalog=/,{timeout:10000});return true;}catch{return false;}}});await source.getByRole('button',{name:'NodeLane Comics · 开始阅读',exact:true}).click();reader=await created;if(slug==='choose')await reader.getByRole('region',{name:'选择开始阅读的位置'}).waitFor();else await rendered();await source.close();
}
try{
 console.log('Importing two adapted comics in an isolated profile');
 await worker.evaluate(()=>chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN'}}));
 console.log('Preparing reader preferences');await openReader();await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await reader.close();
 await importComic('first');const jump=reader.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('2');await jump.press('Enter');await rendered(1);await shelf();
 const baseline=await waitFor(value=>value.positions.some(position=>value.pages.find(page=>page.pageId===position.pageId)?.ordinal===1));
 const first=baseline.comics.find(comic=>comic.title===title('first')),position=baseline.positions.find(position=>position.comicId===first.id);
 assert.equal(await reader.locator('.nc-card-update').count(),0);await reader.close();
 await importComic('second');await shelf();await reader.close();
 counts.first=3;counts.second=3;await makeDue();const imageCount=extensionImageReads,requestCount=catalogRequests.length;
 await openReader();await waitFor(value=>value.comics.length===2&&value.comics.every(comic=>comic.catalogUpdates?.count===1));
 await card('first').locator('.nc-card-update').waitFor();await card('second').locator('.nc-card-update').waitFor();
 assert.equal(extensionImageReads,imageCount);assert.equal(catalogRequests.length-requestCount,2);
 assert.deepEqual((await state()).positions.find(value=>value.comicId===first.id),position);
 const placement=await card('first').evaluate(element=>{const badge=element.querySelector('.nc-card-update').getBoundingClientRect(),cover=element.querySelector('.nc-book-cover').getBoundingClientRect(),time=element.querySelector('.nc-card-reading-time').getBoundingClientRect(),source=element.querySelector('.nc-card-source').getBoundingClientRect();return badge.top<cover.top&&badge.right>cover.right&&source.top<cover.top+20&&source.left<cover.left+20&&time.bottom>cover.bottom-20&&time.left<cover.left+20&&getComputedStyle(element).overflow==='visible';});assert(placement);assert.equal(await reader.locator('.nc-cover-reading').count(),0);
 await reader.screenshot({path:path.join(out,'updated-covers.png')});checks.push('到达12小时间隔后检查全部支持漫画，新增内容显示封面提示，仅同步目录且保留第2页位置');
 console.log('Verified cover badges and automatic updates for both comics');
 await card('first').click({button:'right'});assert.equal(await reader.getByRole('menuitem',{name:'目录',exact:true}).count(),0);await reader.screenshot({path:path.join(out,'card-context-menu.png')});await reader.keyboard.press('Escape');
 await card('first').getByRole('button',{name:'更多操作 · '+title('first'),exact:true}).click();assert.equal(await reader.getByRole('menuitem',{name:'目录',exact:true}).count(),0);await reader.keyboard.press('Escape');
 assert.equal(await reader.getByRole('dialog').count(),0);assert.equal(await card('first').locator('.nc-card-update').count(),1);checks.push('卡片右键及更多菜单均无目录项，不弹出目录弹框');
 await card('first').getByRole('button',{name:'继续阅读',exact:true}).click();await rendered(1);
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();await reader.getByText('第3话',{exact:true}).waitFor();await reader.screenshot({path:path.join(out,'synced-directory.png')});await reader.getByRole('button',{name:'关闭面板',exact:true}).click();
 await shelf();await card('first').locator('.nc-card-update').waitFor({state:'detached'});
 assert.equal(await card('second').locator('.nc-card-update').count(),1);checks.push('成功续读恢复第2页后清除该漫画提示，其余漫画提示保留');
 failures.add('first');counts.first=4;counts.second=4;await makeDue();await reader.reload();
 await waitFor(value=>{const sync=value.comics.find(comic=>comic.id===first.id).catalogSync;return value.entries.filter(entry=>entry.comicId!==first.id).length===4&&!sync.lease&&sync.nextCheckAt>Date.now()+719*60_000&&sync.nextCheckAt<Date.now()+721*60_000;});
 assert.equal((await state()).entries.filter(entry=>entry.comicId===first.id).length,3);await reader.screenshot({path:path.join(out,'failed-check-preserves-directory.png')});
 checks.push('来源目录不完整时保留旧目录，保持12小时检查间隔；其他漫画继续同步');
 console.log('Verified reading acknowledgement, position recovery and failed checks');
 failures.clear();await makeDue();await reader.reload();await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===4);
 await card('first').locator('.nc-card-update').waitFor();await reader.close();counts.first=5;
 await worker.evaluate(async()=>{
   const alarms=await chrome.alarms.get('nc-catalog-sync');if(alarms.periodInMinutes!==720)throw Error('Expected a 12-hour alarm');
   await new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-reading-v1-catalog');r.onsuccess=()=>{const db=r.result,tx=db.transaction('comics','readwrite'),request=tx.objectStore('comics').getAll();request.onsuccess=()=>{for(const comic of request.result)tx.objectStore('comics').put({...comic,catalogSync:{...comic.catalogSync,nextCheckAt:0}});};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
   await chrome.alarms.create('nc-catalog-sync-continue',{when:Date.now()+500});
 });
 await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===5);checks.push('关闭阅读器后仍由真实扩展 alarm 自动同步；周期参数为720分钟');
 const beforeOpen=catalogRequests.length;await openReader();await reader.evaluate(()=>chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}));await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(catalogRequests.length,beforeOpen);checks.push('再次打开插件与重复唤醒不触发未到12小时的来源请求');await card('first').locator('.nc-card-update').waitFor();await reader.screenshot({path:path.join(out,'background-update.png')});
 const managed=await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).filter(key=>key.startsWith('nc-catalog-tab:')));assert.deepEqual(managed,[]);
 await card('first').getByRole('button',{name:'继续阅读',exact:true}).click();await rendered(1);counts.first=6;
 await makeDue();await reader.evaluate(()=>chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}));await waitFor(value=>value.entries.filter(entry=>entry.comicId===first.id).length===6);await rendered(1);
 assert.equal(await reader.getByRole('spinbutton',{name:'跳转页码'}).inputValue(),'2');
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();await reader.getByText('第6话',{exact:true}).waitFor();await reader.screenshot({path:path.join(out,'live-directory-preserves-position.png')});
 await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await shelf();await card('first').locator('.nc-card-update').waitFor();checks.push('阅读中同步新增目录立即可见，停留在第2页，新到达提示不会被旧阅读确认清除');
 await card('second').getByRole('button',{name:'继续阅读',exact:true}).click();await rendered();
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();
 const readerDirectory=reader.getByRole('complementary',{name:'漫画目录'});
 const fanEntry=(await state()).entries.find(entry=>entry.comicId!==first.id&&entry.title==='第3话');
 await readerDirectory.locator('summary').filter({hasText:'同人漫画'}).click();await readerDirectory.getByRole('button',{name:/第3话/}).click();await reader.locator(`[data-copy-id="${fanEntry.id}"]`).waitFor();await rendered();
 await reader.getByRole('button',{name:'打开目录',exact:true}).click();await readerDirectory.getByRole('button',{name:/第3话/}).waitFor();await reader.screenshot({path:path.join(out,'dynamic-categories.png')});
 counts.second=5;await makeDue();await reader.evaluate(()=>chrome.runtime.sendMessage({type:'NC_CHECK_DUE_CATALOGS'}));await waitFor(value=>value.entries.filter(entry=>entry.comicId!==first.id).length===5);
 await readerDirectory.locator('summary').filter({hasText:'新分类 · 彩色短篇'}).waitFor();checks.push('任意分类ID和名称原样显示，同人漫画可点击阅读，新增自定义分类自动同步');
 await readerDirectory.locator('summary').filter({hasText:'其他系列'}).click();imagesOffline=true;
 await readerDirectory.getByRole('button',{name:/第4话/}).click();await reader.getByText('图片暂不可用',{exact:true}).first().waitFor();await reader.screenshot({path:path.join(out,'failed-reading.png')});
 await shelf();await card('second').locator('.nc-card-update').waitFor();imagesOffline=false;checks.push('新条目图片读取失败时保留更新提示');
 await reader.getByRole('button',{name:'批量管理',exact:true}).click();
 const selection=reader.getByRole('checkbox',{name:'选择漫画 '+title('second'),exact:true});await selection.check();assert(await selection.isChecked());
 await reader.screenshot({path:path.join(out,'badge-selection.png')});await reader.getByRole('button',{name:'完成管理',exact:true}).click();checks.push('伸出封面的SVG徽章不遮挡批量选择，来源左上、阅读时间左下，无页数标签');
 await reader.close();await importComic('choose');assert.equal(await reader.getByRole('dialog').count(),0);
 const start=reader.getByRole('region',{name:'选择开始阅读的位置'});await start.locator('summary').first().click();await reader.screenshot({path:path.join(out,'choose-reading-start.png')});await start.getByRole('button',{name:/第1话/}).click();await rendered();await shelf();
 checks.push('无可靠默认入口时在页面内选择开始位置，选择后正常阅读，无目录弹框');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,browser:context.browser()?.version(),liveSites:false,catalogRequests,extensionImageReads},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){if(reader&&!reader.isClosed()){await reader.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await reader.locator('body').innerText());}await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors,state:await state().catch(String),catalogRequests},null,2));throw error;}
finally{await context.close();await Promise.all([new Promise(resolve=>site.close(resolve)),new Promise(resolve=>images.close(resolve))]);}
