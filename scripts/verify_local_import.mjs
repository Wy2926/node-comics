/** Real local-file import UI on an isolated origin/profile. No account or provider calls.
 * npm run dev -- --port 5176 (apps/extension); then node scripts/verify_local_import.mjs.
 * Set PLAYWRIGHT_MODULE / TEST_CHROMIUM for a bundled runtime. TEST_EXTENSION=1 uses the built MV3 extension.
 * Generate the public fixtures with scripts/generate_import_fixtures.py first.
 */
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.join(root,'artifacts/local-import');await mkdir(output,{recursive:true});
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=createRequire(path.join(root,'apps/extension/package.json'))('@zip.js/zip.js');
const longWriter=new ZipWriter(new Uint8ArrayWriter()),sample=await readFile(path.join(root,'artifacts/import-validation/1.png'));
for(let n=0;n<120;n++)await longWriter.add(String(n).padStart(3,'0')+'.png',new Uint8ArrayReader(sample),{level:0});
await writeFile(path.join(output,'long.cbz'),await longWriter.close());
const extension=path.join(root,'apps/extension/.output/chrome-mv3'),isExtension=process.env.TEST_EXTENSION==='1';
const options={headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{}),viewport:{width:1440,height:1050}};
const browser=isExtension?null:await chromium.launch(options);
const context=isExtension?await chromium.launchPersistentContext(await mkdtemp(path.join(output,'profile-')),{...options,args:['--disable-extensions-except='+extension,'--load-extension='+extension]}):await browser.newContext(options);
const page=await context.newPage(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
let target=process.env.TEST_READER_URL||'http://127.0.0.1:5176';
if(isExtension){const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');target=`chrome-extension://${new URL(worker.url()).host}/reader.html`;}
await context.route('http://127.0.0.1:18088/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"隔离导入验收，不连接后端"}'}));
const panel=page.getByRole('dialog',{name:'导入本地漫画'});
const fixture=async(name,filename=name)=>({name:filename,mimeType:'application/octet-stream',buffer:await readFile(path.join(root,'artifacts/import-validation',name))});
const rows=panel.locator('.nc-import-item');
async function choose(files){await page.locator('input[type=file]').setInputFiles(files);await panel.waitFor();await page.waitForFunction(()=>!document.querySelector('.nc-import-item.checking'));}
async function start(){await panel.getByRole('button',{name:/^(开始导入|导入其余所选)/}).click();}
async function finished(){await panel.locator('.nc-import-steps li:nth-child(3)[aria-current=step]').waitFor({timeout:120000});}
async function screenshot(name){await page.screenshot({path:path.join(output,(isExtension?'extension-':'web-')+name+'.png')});}
async function copies(){return page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('node-comics-library',1);open.onsuccess=()=>{const db=open.result,r=db.transaction('copies').objectStore('copies').getAll();r.onsuccess=()=>{db.close();resolve(r.result);};r.onerror=()=>reject(r.error);};open.onerror=()=>reject(open.error);}));}
async function finishPanel(){await panel.getByRole('button',{name:'完成',exact:true}).click();await panel.waitFor({state:'hidden'});}
try{
 await page.goto(target);
 await choose([await fixture('pages.cbz','已收藏.cbz')]);await start();await finished();assert.equal((await copies()).length,1);await finishPanel();
 // Renamed duplicate is identified before any decoding, even when batched with new/broken files.
 await page.evaluate(()=>{window.__decoded=0;const decode=window.createImageBitmap;window.createImageBitmap=(...args)=>{if(args.length===1)window.__decoded++;return decode(...args);};});
 const long={name:'02-星光书店-长篇.cbz',mimeType:'application/octet-stream',buffer:await readFile(path.join(output,'long.cbz'))};
 await choose([await fixture('pages.cbz','01-重复但改名.cbz'),long,await fixture('broken-image.cbz','03-损坏章节.cbz'),await fixture('pages.pdf','04-新卷册.pdf'),await fixture('repacked.cbz','05-可移除.cbz'),{name:'06-说明.txt',mimeType:'text/plain',buffer:Buffer.from('unsupported')}]);
 assert.equal(await rows.count(),6);assert.equal(await rows.filter({hasText:'已存在 · 跳过'}).count(),1);assert.equal(await page.evaluate(()=>window.__decoded),0);
 await panel.getByRole('button',{name:'从导入清单移除 05-可移除.cbz'}).click();await panel.getByRole('button',{name:'从导入清单移除 06-说明.txt'}).click();
 await panel.getByLabel('作品名称',{exact:true}).fill('新章节批量验收');await selectOption(panel.getByLabel('内容归属',{exact:true}),'chapter');await screenshot('preflight');
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await start();await panel.locator('.nc-import-item.importing progress').waitFor();
 await panel.getByRole('button',{name:'完成当前后暂停'}).click();await screenshot('progress');
 await panel.getByRole('button',{name:'收起，继续浏览'}).click();await panel.waitFor({state:'hidden'});await page.getByRole('complementary',{name:'本地导入进度'}).waitFor();
 assert.equal(await page.locator('dialog[open]').count(),0);await screenshot('minimized');
 await page.getByRole('button',{name:/导入已暂停/}).waitFor({timeout:120000});await page.getByRole('button',{name:/导入已暂停/}).click();
 assert.equal(await panel.locator('.nc-import-item.queued').count(),2);assert.equal((await copies()).length,2);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await panel.getByRole('button',{name:'继续导入',exact:true}).click();await finished();
 assert.equal(await panel.locator('.nc-import-item.created').count(),2);assert.equal(await panel.locator('.nc-import-item.failed').count(),1);assert.equal((await copies()).length,3);await screenshot('results');
 await panel.getByRole('button',{name:'重试失败项（1）'}).click();await finished();assert.equal((await copies()).length,3);assert.equal(await panel.locator('.nc-import-item.failed').count(),1);
 checks.push({mixedBatch:true,preflightWithoutDecode:true,pauseResume:true,nonBlockingDock:true,perFileFailure:true,retryNoDuplicates:true});await finishPanel();
 // PDF and archive exact duplicates both skip without page rendering/decoding.
 await page.evaluate(()=>{window.__decoded=0;});await choose([await fixture('pages.pdf','改名PDF.pdf'),await fixture('pages.cbz','改名ZIP.zip')]);
 assert.equal(await panel.locator('.nc-import-item.duplicate').count(),2);assert.equal(await page.evaluate(()=>window.__decoded),0);assert.equal(await panel.getByRole('button',{name:/开始导入/}).count(),0);
 await screenshot('all-duplicates');checks.push({pdfEarlyDuplicate:true,archiveEarlyDuplicate:true,noZeroImportedMessage:!((await panel.innerText()).includes('导入 0 份'))});await finishPanel();
 // Restore one copy's missing blob; its page ID, translations and saved reading position remain stable.
 const original=(await copies()).find(copy=>copy.title==='已收藏');assert(original);
 await page.evaluate(copy=>new Promise((resolve,reject)=>{localStorage.setItem(`nc-copy-position:${copy.id}:1`,JSON.stringify({pageId:copy.pages[1].id,relativeOffset:.37}));const open=indexedDB.open('node-comics-library',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction(['blobs'],'readwrite');for(const item of copy.pages)if(item.blobKey)tx.objectStore('blobs').delete(item.blobKey);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),original);
 await choose([await fixture('pages.cbz')]);assert.equal(await panel.locator('.nc-import-item.restore').count(),1);await start();await finished();assert.equal(await panel.locator('.nc-import-item.restored').count(),1);
 const restored=(await copies()).find(copy=>copy.id===original.id);assert.deepEqual(restored.pages.map(p=>p.id),original.pages.map(p=>p.id));assert(restored.pages.every(p=>p.blobKey));
 assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem(`nc-copy-position:${id}:1`)).relativeOffset,original.id),.37);checks.push({restoreOriginals:true,pageIdsAndPositionPreserved:true});await finishPanel();
 // Mobile: same controls, no horizontal overflow, and an explicit unsupported-file explanation.
 await page.setViewportSize({width:390,height:844});await choose([await fixture('pages.cbz'),await fixture('repacked.cbz'),{name:'不支持.txt',mimeType:'text/plain',buffer:Buffer.from('unsupported')}]);
 await screenshot('mobile');assert(await page.evaluate(()=>{const dialog=document.querySelector('dialog[open]');return dialog.scrollWidth<=dialog.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth;}));
 await panel.getByRole('button',{name:/^失败\s*1$/}).click();assert.equal(await rows.count(),1);await panel.getByRole('button',{name:'从导入清单移除 不支持.txt'}).click();
 checks.push({mobileNoOverflow:true,statusFilters:true});
 assert.deepEqual(errors,[]);await writeFile(path.join(output,(isExtension?'extension':'web')+'-results.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{await context.close();await browser?.close();}
