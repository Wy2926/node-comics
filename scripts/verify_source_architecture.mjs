/** New source baseline acceptance. Uses only a fresh browser profile and generated public images. */
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=createRequire(path.join(root,'apps/extension/package.json'))('@zip.js/zip.js');
const browserLabel=process.env.TEST_BROWSER_NAME||'chromium-web';
const output=path.join(root,'artifacts/source-architecture',browserLabel);await mkdir(output,{recursive:true});
const writer=new ZipWriter(new Uint8ArrayWriter()),sample=await readFile(path.join(root,'artifacts/import-validation/1.png'));
for(let n=0;n<120;n++)await writer.add(`${String(n).padStart(3,'0')}.png`,new Uint8ArrayReader(sample),{level:0});
const archive=await writer.close();await writeFile(path.join(output,'long.cbz'),archive);
const profile=await mkdtemp(path.join(output,'profile-'));
const extension=process.env.TEST_EXTENSION==='1',extensionDir=path.join(root,'apps/extension/.output/chrome-mv3');
const options={headless:true,viewport:{width:1440,height:1000},executablePath:process.env.TEST_CHROMIUM,args:extension?['--disable-extensions-except='+extensionDir,'--load-extension='+extensionDir]:[]};
let context=await chromium.launchPersistentContext(profile,options);
const errors=[],checks=[];
async function boot(){
 await context.route('https://**.nodelane.net/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{}'}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let url=process.env.TEST_READER_URL||'http://127.0.0.1:5175/';
 if(extension){const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');url=`chrome-extension://${new URL(worker.url()).host}/reader.html`;}
 await page.goto(url);await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await page.reload();
 await page.locator('input[type=file]').waitFor({state:'attached'});return page;
}
async function records(page){return page.evaluate(async()=>{
 const open=name=>new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const all=(db,name)=>new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const db=await open('node-comics-sources-v1-catalog'),bytes=await open('node-comics-sources-v1-container-bytes');
 const docs=await all(db,'documents'),pages=await all(db,'pageDescriptors'),materials=await all(db,'materializations'),positions=await all(db,'positions'),objects=await all(bytes,'objects'),chunks=await all(bytes,'chunks');db.close();bytes.close();
 return {docs,pages,materials,positions,objects,chunkBytes:chunks.reduce((n,c)=>n+c.bytes.byteLength,0)};
 });}
let page;
try{
 page=await boot();await page.screenshot({path:path.join(output,'empty.png')});
 assert.equal(await page.getByRole('button',{name:'网站来源',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Google Drive',exact:true}).count(),0);await page.getByRole('button',{name:'导入漫画',exact:true}).click();const choices=page.getByRole('dialog',{name:'导入漫画',exact:true});await choices.getByRole('button',{name:'本地文件',exact:true}).waitFor();assert.equal(await choices.getByRole('button',{name:'网站来源',exact:true}).count(),0);await page.screenshot({path:path.join(output,'source-picker.png')});await choices.getByRole('button',{name:'关闭弹窗',exact:true}).click();checks.push('书架只提供导入漫画按钮，来源在弹框选择，网站入口保留在网页');
 await page.locator('input[type=file]').setInputFiles({name:'原文件按需阅读.cbz',mimeType:'application/zip',buffer:Buffer.from(archive)});
 const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.getByRole('button',{name:/^开始导入/}).click();
 await panel.locator('.nc-import-item.created').waitFor({timeout:120000});
 const saved=await records(page);assert.equal(saved.docs.length,1);assert.equal(saved.pages.length,120);assert.equal(saved.objects.length,1);assert.equal(saved.chunkBytes,archive.length);assert(saved.materials.length<=1);assert(!saved.pages.some(p=>'blobKey' in p||'jobs' in p));
 checks.push('120页导入仅完整容器+索引，最多封面一次物化');await page.screenshot({path:path.join(output,'imported.png')});
 await panel.getByRole('button',{name:'开始阅读',exact:true}).click();await page.locator('.nc-page-image').first().waitFor({timeout:60000});
 const jump=page.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('100');await jump.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-page-index="99"] img.nc-page-image'));
 assert(await page.locator('.nc-manga-page').count()<=11);await page.screenshot({path:path.join(output,'page-100.png')});
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.nc-reader'));
 await page.waitForTimeout(400);const after=await records(page);assert.equal(after.positions[0].pageId,after.pages.find(p=>p.ordinal===99).pageId);assert(after.materials.length<12);
 checks.push('跳第100页按需物化，DOM有界，pageId位置持久化');
 await page.close();await context.close();context=await chromium.launchPersistentContext(profile,options);page=await boot();
 await page.getByRole('button',{name:'继续阅读',exact:true}).click();await page.locator('[data-page-index="99"] img.nc-page-image').waitFor({timeout:60000});
 const restarted=await records(page);assert.equal(restarted.objects.length,1);assert.equal(restarted.chunkBytes,archive.length);checks.push('关闭浏览器并重启相同新profile，无需重新选源文件直接读第100页');
 await page.screenshot({path:path.join(output,'restarted.png')});
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByText('本机资料与独立缓存',{exact:true}).waitFor();
 for(const label of ['原图页缓存','源文件分段','译图缓存','缩略图'])await page.locator('.setting-row').filter({has:page.getByText(label,{exact:true})}).getByRole('button',{name:'清理',exact:true}).click();
 const cleared=await records(page);assert.deepEqual(cleared.docs.map(d=>d.revisionId),restarted.docs.map(d=>d.revisionId));assert.deepEqual(cleared.positions.map(({updatedAt,...p})=>p),restarted.positions.map(({updatedAt,...p})=>p));assert.equal(cleared.chunkBytes,archive.length);checks.push('独立清理4类缓存，源容器/修订/阅读位置不变');
 await page.screenshot({path:path.join(output,'storage.png')});
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>location.hash='library');await page.waitForTimeout(500);await page.screenshot({path:path.join(output,'mobile.png')});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert(await page.locator('.nc-page-heading .button').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height<90)));checks.push('390px窄屏无横向溢出，导入按钮保持横排文字');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:browserLabel,version:context.browser()?.version(),extension,checks,errors},null,2));await writeFile(path.join(output,extension?'extension-results.json':'web-results.json'),JSON.stringify({browser:browserLabel,version:context.browser()?.version(),extension,checks,errors},null,2));
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error('Browser errors',errors);throw error;}finally{await context.close();}
