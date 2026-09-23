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
 await boot();await screenshot('empty');assert.equal(await page.getByText('网站下载资料',{exact:true}).count(),0);
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
 const time=card.locator('time');assert.equal(Date.parse(await time.getAttribute('datetime')),(await state()).comics.find(c=>c.title==='长篇漫画').lastReadAt);assert(!(await time.innerText()).includes('最近阅读'));
 const placement=await card.evaluate(card=>{const cover=card.querySelector('.nc-book-cover').getBoundingClientRect(),tag=card.querySelector('.nc-card-reading-time').getBoundingClientRect();return {inside:tag.top>=cover.top&&tag.left>=cover.left&&tag.right<=cover.right&&tag.bottom<=cover.bottom,topGap:cover.top-card.getBoundingClientRect().top};});assert(placement.inside);assert(placement.topGap<=3);
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await screenshot('desktop-shelf');await screenshot('desktop-shelf-top');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await card.getByRole('button',{name:'继续阅读',exact:true}).click();await rendered(99);await screenshot('desktop-reader');checks.push('桌面卡片显示真实最近阅读时间，直接续读恢复位置，书架无顶部下载区块');
 await shelf();await card.getByRole('button',{name:'更多操作 · 长篇漫画',exact:true}).click();await page.getByRole('menuitem',{name:'移除漫画',exact:true}).click();await page.getByRole('dialog',{name:'移除漫画'}).getByRole('button',{name:'移除漫画',exact:true}).click();await card.waitFor({state:'detached'});value=await state();assert(!value.comics.some(c=>c.title==='长篇漫画'));checks.push('移除漫画同时移除其本地阅读记录');
 // Actual extension UI, isolated catalog fixtures; no real account or cloud requests.
 await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-reading-v1-catalog');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const tx=db.transaction(['comics','connections'],'readwrite'),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  const now=Date.now();
  for(let n=0;n<42;n++)tx.objectStore('comics').put({id:'batch-fixture-'+n,sourceKey:'batch-fixture-'+n,title:'批量测试 '+String(n).padStart(2,'0'),sourceName:'本地文件',source:{connectionId:'local',providerItemId:'batch-fixture-'+n,locator:{},generation:1,status:'active'},createdAt:now,updatedAt:now});
  tx.objectStore('connections').put({id:'drive:fixture-account',provider:'google-drive',accountId:'fixture-account',displayName:'隔离账户',accountMetadata:{emailAddress:'reader@example.test'},status:'connected',generation:1,createdAt:now,updatedAt:now});
  await done;db.close();
  await chrome.storage.session.set({'nc-drive-token:fixture-account':{account:{id:'fixture-account',displayName:'隔离账户',emailAddress:'reader@example.test'},generation:'fixture-generation',accessToken:'synthetic-fixture-token',expiresAt:Date.now()+3600000}});
 });
 await page.reload();await page.locator('.nc-library').waitFor();
 await page.getByRole('button',{name:'批量管理',exact:true}).click();
 const toolbar=page.getByRole('region',{name:'批量管理'}),search=page.getByRole('searchbox',{name:'搜索漫画'});
 assert(await toolbar.getByRole('button',{name:'移除漫画'}).isDisabled());
 await search.fill('批量测试');await page.getByRole('button',{name:'全选 42 部',exact:true}).click();
 await page.getByRole('status').filter({hasText:'已选 42 部作品'}).waitFor();assert(await page.locator('.nc-book').count()<42);assert.equal(await page.locator('.nc-book time').count(),0);
 await search.fill('批量测试 00');await page.getByRole('checkbox',{name:'选择漫画 批量测试 00',exact:true}).uncheck();
 await page.getByRole('status').filter({hasText:'已选 41 部作品'}).waitFor();assert.equal(await page.locator('.nc-reader').count(),0);
 await toolbar.getByRole('button',{name:'移除漫画'}).click();const confirmation=page.getByRole('dialog',{name:'移除漫画'});
 assert((await confirmation.innerText()).includes('41'));await confirmation.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await state()).comics.filter(c=>c.id.startsWith('batch-fixture-')).length,42);
 await search.fill('批量测试');await screenshot('batch-management');await toolbar.getByRole('button',{name:'移除漫画'}).click();
 await confirmation.getByRole('button',{name:'移除漫画',exact:true}).click();await confirmation.waitFor({state:'hidden'});
 value=await state();assert.deepEqual(value.comics.filter(c=>c.id.startsWith('batch-fixture-')).map(c=>c.id),['batch-fixture-0']);assert(value.comics.some(c=>c.title==='第二本'));checks.push('全选 42 本跨虚拟列表，搜索保留选择，取消确认保留资料，移除 41 本不影响未选漫画');
 await toolbar.getByRole('button',{name:'全选 1 部',exact:true}).click();await page.getByRole('button',{name:'完成管理',exact:true}).click();
 await page.getByRole('button',{name:'批量管理',exact:true}).click();await page.getByRole('status').filter({hasText:'已选 0 部作品'}).waitFor();await page.getByRole('button',{name:'完成管理',exact:true}).click();
 await page.getByRole('button',{name:'外观与设置'}).click();
 const storage=page.locator('.settings-card').filter({has:page.getByRole('heading',{name:'本机资料与独立缓存',exact:true})});
 await page.getByText('reader@example.test',{exact:true}).waitFor();
 assert.equal(await storage.getByRole('link').count(),0);assert.equal(await page.getByText('管理漫画',{exact:true}).count(),0);assert.equal(await page.getByText('管理下载',{exact:true}).count(),0);
 const boxes=await page.locator('.nc-preferences>.settings-card').evaluateAll(cards=>cards.map(card=>{const r=card.getBoundingClientRect();return {x:r.x,width:r.width};}));assert.equal(boxes.length,5);assert(boxes.every(box=>box.x===boxes[0].x&&box.width===boxes[0].width));
 assert((await page.locator('.nc-source-account').innerText()).includes('fixture-account'));assert((await page.locator('.nc-source-account').innerText()).includes('已连接'));
 assert((await page.locator('.nc-source-account').boundingBox()).height<110,'Cloud account should use a compact horizontal row');
 await storage.scrollIntoViewIfNeeded();await screenshot('settings-storage-accounts');
 await page.locator('.nc-source-accounts').scrollIntoViewIfNeeded();await screenshot('source-account');
 await storage.getByRole('button',{name:'清理',exact:true}).first().click();await page.waitForFunction(()=>![...document.querySelectorAll('.settings-card button')].some(button=>button.textContent==='清理'&&button.disabled));
 assert.equal((await state()).comics.length,value.comics.length);checks.push('五个设置卡片宽度与左边缘一致，管理快捷按钮移除，账户显示来源/名称/邮箱/标识/状态，清缓存保留漫画');
 // An external source lifecycle change must update the account without reopening settings.
 assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'NC_DRIVE_DISCONNECT',accountId:'fixture-account'}))).ok,true);
 await page.getByText('已断开连接',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'断开连接',exact:true}).count(),0);checks.push('账户在其他上下文断开后，设置自动更新状态并保留只读资料');
 assert.deepEqual(errors,[]);
 const report={browser:label,version:context.browser()?.version(),extension:true,checks,errors};await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page)await screenshot('failure').catch(()=>{});console.error('Page errors:',errors);throw error;}finally{await context.close();}
