/** Single-source reader acceptance: fresh profile, generated comics, no external account or API. */
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=createRequire(path.join(root,'apps/extension/package.json'))('@zip.js/zip.js');
const label=process.env.TEST_BROWSER_NAME||'chromium-extension';
const output=path.join(root,'artifacts/simple-reading',label);await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'profile-')),extension=path.join(root,'apps/extension/.output/chrome-mv3');
const options={headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]};
const sample=await readFile(path.join(root,'artifacts/import-validation/1.png')),writer=new ZipWriter(new Uint8ArrayWriter());
for(let n=0;n<120;n++)await writer.add(`${String(n).padStart(3,'0')}.png`,new Uint8ArrayReader(sample),{level:0});
const archive=Buffer.from(await writer.close());
let context=await chromium.launchPersistentContext(profile,options),page;
const errors=[],checks=[];
async function boot(){
 await context.route(/^https?:\/\//,r=>r.fulfill({status:503,contentType:'application/json',body:'{}'}));
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`chrome-extension://${new URL(worker.url()).host}/reader.html`);
 await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await page.reload();
 await page.locator('input[type=file]').waitFor({state:'attached'});
}
async function state(){return page.evaluate(async()=>{
 const open=name=>new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const all=(db,name)=>new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const db=await open('node-comics-reading-v1-catalog'),bytes=await open('node-comics-reading-v1-container-bytes');
 const [comics,entries,pages,materials,positions,objects,chunks]=await Promise.all([all(db,'comics'),all(db,'entries'),all(db,'pageDescriptors'),all(db,'materializations'),all(db,'positions'),all(bytes,'objects'),all(bytes,'chunks')]);
 const stores=[...db.objectStoreNames];db.close();bytes.close();return {comics,entries,pages,materials,positions,objects,stores,chunkBytes:chunks.reduce((n,c)=>n+c.bytes.byteLength,0)};
});}
async function rendered(index){await page.waitForFunction(index=>{const image=document.querySelector((index===undefined?'':`[data-page-index="${index}"] `)+'img.nc-page-image');return image?.complete&&image.naturalWidth>0;},index,{timeout:60000});}
async function shelf(){await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.locator('.nc-library').waitFor();}
async function importFile(name,buffer){await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/octet-stream',buffer});}
async function closeResult(){const dock=page.locator('.nc-import-dock');if(await dock.isVisible())await dock.getByRole('button').click();const panel=page.locator('.nc-local-import-modal');if(await panel.isVisible())await panel.getByRole('button',{name:'完成',exact:true}).click();}
async function jump(n){const box=page.getByRole('spinbutton',{name:'跳转页码'});await box.fill(String(n));await box.press('Enter');}
async function screenshot(name){await page.screenshot({path:path.join(output,name+'.png')});}
try{
 await boot();await screenshot('empty');
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'导入漫画',exact:true}).click();await chooser;
 assert.equal(await page.getByRole('dialog').count(),0);assert(!/image\//.test(await page.locator('input[type=file]').getAttribute('accept')));checks.push('导入按钮直接打开文件选择器，只接受漫画文件，无来源和归属确认');
 await importFile('长篇漫画.cbz',archive);await rendered(0);assert.equal(await page.getByRole('dialog').count(),0);
 let value=await state();assert.equal(value.comics.length,1);assert.equal(value.entries.length,1);assert.equal(value.pages.length,120);assert.equal(value.objects.length,1);assert.equal(value.chunkBytes,archive.length);assert(value.materials.length<12);assert(!value.stores.some(s=>['works','units','documents','revisions','sourceBindings'].includes(s)));
 checks.push('单本自动开始阅读，新库只有单来源漫画与只读条目，120 页仅完整容器和索引');await screenshot('reading');
 await jump(100);await rendered(99);assert(await page.locator('.nc-manga-page').count()<=11);await screenshot('page-100');await shelf();
 await page.waitForFunction(()=>document.querySelector('.nc-cover-reading')?.textContent.includes('100'));value=await state();assert.equal(value.positions[0].pageId,value.pages.find(p=>p.ordinal===99).pageId);assert(value.materials.length<20);checks.push('跳第 100 页、有限图片窗口，书架显示保存的页码');
 await closeResult();await context.close();context=await chromium.launchPersistentContext(profile,options);await boot();await page.getByRole('button',{name:'继续阅读',exact:true}).click();await rendered(99);checks.push('真实关闭并重启浏览器，直接恢复第 100 页');await screenshot('resumed');await shelf();
 await importFile('另一个名字.cbz',archive);await rendered(99);assert.equal((await state()).comics.length,1);checks.push('相同文件改名重导入复用同一本，保留进度');await shelf();await closeResult();
 await page.locator('input[type=file]').setInputFiles([{name:'散图.png',mimeType:'image/png',buffer:sample},{name:'第二张.jpg',mimeType:'image/jpeg',buffer:sample},{name:'第二本.cbz',mimeType:'application/zip',buffer:await readFile(path.join(root,'artifacts/import-validation/pages.cbz'))}]);
 const panel=page.locator('.nc-local-import-modal');await panel.locator('.nc-import-item.failed').first().waitFor({timeout:60000});await panel.locator('.nc-import-item.created').waitFor();assert.equal(await panel.locator('.nc-import-item.failed').count(),2);assert.equal((await state()).comics.length,2);assert.equal(await page.locator('.nc-reader').count(),0);checks.push('混合批量自动导入：两张散图分别拒绝，合法漫画独立入库，失败不阻塞');await screenshot('batch');await closeResult();
 for(const file of ['pages.pdf','pages.mobi','rar4.cbr','rar5.rar']){
  await importFile(file,await readFile(path.join(root,'artifacts/import-validation',file)));await rendered(0);checks.push(file+' 真实格式解析与图片解码');await screenshot(file);await shelf();await closeResult();
 }
 for(const file of ['locked.pdf','corrupt.pdf']){
  const before=(await state()).comics.length;await importFile(file,await readFile(path.join(root,'artifacts/import-validation',file)));await panel.locator('.nc-import-item.failed').waitFor({timeout:60000});assert.equal((await state()).comics.length,before);assert((await panel.locator('[role=alert]').innerText()).length>0);checks.push(file+' 明确失败，不生成空漫画');await screenshot(file);await closeResult();
 }
 await importFile('broken-image.cbz',await readFile(path.join(root,'artifacts/import-validation/broken-image.cbz')));await rendered(0);await jump(2);await page.locator('[data-page-index="1"] .nc-image-failure').waitFor();await screenshot('failed-page');
 value=await state();assert.equal(value.entries.find(e=>e.title==='broken-image')?.readAt,undefined);await jump(1);await rendered(0);checks.push('损坏图片有重试入口，其他页仍可读，失败不误记已读');await shelf();await closeResult();
 const card=page.locator('.nc-book').filter({has:page.getByRole('button',{name:'长篇漫画',exact:true})});await card.getByRole('button',{name:'更多操作 · 长篇漫画',exact:true}).click();
 assert.equal(await page.getByRole('menuitem',{name:/编辑|版本|归属|添加来源/}).count(),0);await screenshot('comic-menu');await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await screenshot('narrow-shelf');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await card.getByRole('button',{name:'继续阅读',exact:true}).click();await rendered(99);await screenshot('narrow-reader');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('卡片直读和简短操作菜单，390px 书架与阅读器无横向溢出');
 await shelf();await card.getByRole('button',{name:'更多操作 · 长篇漫画',exact:true}).click();await page.getByRole('menuitem',{name:'移除漫画',exact:true}).click();await page.getByRole('dialog',{name:'移除漫画'}).getByRole('button',{name:'移除漫画',exact:true}).click();await card.waitFor({state:'detached'});value=await state();assert(!value.comics.some(c=>c.title==='长篇漫画'));checks.push('移除漫画同时移除其本地阅读记录');
 assert.deepEqual(errors,[]);
 const report={browser:label,version:context.browser()?.version(),extension:true,checks,errors};await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page)await screenshot('failure').catch(()=>{});console.error('Page errors:',errors);throw error;}finally{await context.close();}
