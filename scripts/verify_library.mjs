/** New-model browser acceptance. No accounts or translation providers are used.
 * First generate original fixtures and start Vite at TEST_READER_URL (default :5174).
 * PLAYWRIGHT_MODULE and TEST_CHROMIUM select an installed browser runtime.
 */
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.join(root,'artifacts/library-validation');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'})});
const checks=[];
try{
 for(const name of ['pages.cbz','pages.zip','rar4.cbr','rar5.rar','pages.pdf']){
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://127.0.0.1:18088/**',r=>r.fulfill({status:503,body:'No backend used in this test'}));
  await page.goto(process.env.TEST_READER_URL||'http://127.0.0.1:5174');
  await page.locator('input[type=file]').setInputFiles(path.join(root,'artifacts/import-validation',name));
  await page.getByLabel('内容归属',{exact:true}).selectOption('publication');await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-shelf-detail').click();await page.getByRole('tab',{name:'卷册',exact:true}).click();
  await page.getByRole('button',{name:'阅读',exact:true}).click();await page.getByLabel('跳转页码').waitFor();await page.locator('.nc-page-image').first().waitFor();
  const jump=page.getByLabel('跳转页码');await jump.fill('2');await jump.press('Enter');await jump.blur();
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles(path.join(root,'artifacts/import-validation',name));await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('.nc-book').count(),1);await page.getByRole('button',{name:'继续阅读',exact:true}).click();assert.equal(await page.getByLabel('跳转页码').inputValue(),'2');
  await page.screenshot({path:path.join(output,name+'.png')});
  const data=await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('node-comics-library');r.onsuccess=()=>{const tx=r.result.transaction(['library','copies'],'readonly'),s=tx.objectStore('library').get('library'),c=tx.objectStore('copies').getAll();tx.oncomplete=()=>resolve({works:s.result.works.length,chapters:s.result.chapters.length,books:s.result.publications.length,pages:c.result[0].pages.length,ids:c.result[0].pages.map(p=>p.id)});};}));
  assert.equal(data.works,1);assert.equal(data.books,1);assert.equal(data.chapters,0);assert.equal(data.pages,3);assert.equal(new Set(data.ids).size,3);assert.deepEqual(errors,[]);checks.push({name,...data,positionRestored:true});await context.close();
 }
 for(const name of ['broken-image.cbz','locked.pdf','corrupt.pdf']){
  const context=await browser.newContext(),page=await context.newPage();await page.goto(process.env.TEST_READER_URL||'http://127.0.0.1:5174');await page.locator('input[type=file]').setInputFiles(path.join(root,'artifacts/import-validation',name));await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.getByRole('alert').filter({hasText:'导入未完成'}).waitFor();assert.equal(await page.locator('.nc-book').count(),0);checks.push({name,errorVisible:true});await context.close();
 }
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();await page.goto(process.env.TEST_READER_URL||'http://127.0.0.1:5174');
 const raw=await readFile(path.join(root,'apps/extension/tests/fixtures/mangacopy-catalog.html'),'utf8');
 const parsed=await page.evaluate(async html=>{const {discoverMangaCopyCatalog}=await import('/src/sources/mangacopy.ts');const doc=new DOMParser().parseFromString('<h6>来自深渊</h6>'+html,'text/html');return discoverMangaCopyCatalog(doc,'https://www.mangacopy.com/comic/laizishenyuan');},raw);
 assert(parsed.complete);assert.equal(parsed.entries.length,100);assert.equal(parsed.groups[0].entryIds.length,82);
 const manifests=await page.evaluate(async()=>{const {discoverDocument}=await import('/src/sources/adapters.ts');const parse=html=>discoverDocument(new DOMParser().parseFromString(html,'text/html'),'https://www.mangacopy.com/comic/sample/chapter/00000000-0000-0000-0000-000000000000');return [parse('<span class="comicCount">3</span><ul class="comicContent-list comic-size-3"><li><img data-src="https://images.example/1" src="https://images.example/placeholder"></li><li><img data-src="https://images.example/1" src="https://images.example/placeholder"></li><li><img data-src="https://images.example/3" src="https://images.example/placeholder"></li></ul><img src="https://ads.example/ad">'),parse('<span class="comicCount">3</span><ul class="comicContent-list"><li><img src="https://images.example/placeholder"></li></ul>')];});
 assert.equal(manifests[0].items.length,3);assert(manifests[0].discoveryComplete);assert.equal(manifests[0].items[0].url,manifests[0].items[1].url);assert.notEqual(manifests[0].items[0].id,manifests[0].items[1].id);assert.equal(manifests[1].items.length,0);assert.equal(manifests[1].discoveryComplete,false);checks.push({sourceDom:true,duplicateSlots:true,missingDataSrc:true});
 await page.evaluate(async()=>{
  const {editLibrary}=await import('/src/library/store.ts'),{makeCopy,attachCopy}=await import('/src/library/model.ts');
  await editLibrary((state,copies)=>{
   const first=makeCopy('普通版第 1 卷',[],'隔离验收'),workId=attachCopy(state,first,{title:'出版关系验收',kind:'publication'});copies.push(first);
   const evidence={status:'user',source:'隔离验收'};state.series.push({id:'regular',title:'普通版',workIds:[workId],evidence},{id:'omnibus',title:'合订版',workIds:[workId],evidence});state.publications[0].seriesId='regular';
   for(const [title,seriesId] of [['普通版第 2 卷','regular'],['合订版第 1 册','omnibus']]){const copy=makeCopy(title,[],'隔离验收');attachCopy(state,copy,{workId,title,kind:'publication',seriesId});copies.push(copy);}
  });
 });
 await page.reload();await page.locator('.nc-shelf-detail').click();await page.getByRole('tab',{name:'卷册',exact:true}).click();
 const omnibus=page.locator('.nc-content-card').filter({has:page.getByRole('heading',{name:'合订版第 1 册',exact:true})});await omnibus.getByRole('button',{name:'查看详情',exact:true}).click();
 let dialog=page.getByRole('dialog');await dialog.locator('summary').filter({hasText:'收录与卷册关联'}).click();await dialog.getByRole('button',{name:'编辑卷册关联',exact:true}).click();
 dialog=page.getByRole('dialog');await dialog.getByRole('group',{name:'合订收录',exact:true}).getByRole('button').nth(0).click();await dialog.getByRole('group',{name:'合订收录',exact:true}).getByRole('button').nth(1).click();await dialog.getByRole('button',{name:'保存修改',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await omnibus.getByRole('button',{name:'查看详情',exact:true}).click();dialog=page.getByRole('dialog');await dialog.locator('summary').filter({hasText:'收录与卷册关联'}).click();assert.equal(await dialog.getByText(/合订收录：普通版第/).count(),2);await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
 await page.locator('.nc-content-card').filter({has:page.getByRole('heading',{name:'普通版第 1 卷',exact:true})}).getByRole('button',{name:'查看详情',exact:true}).click();dialog=page.getByRole('dialog');await dialog.locator('summary').filter({hasText:'收录与卷册关联'}).click();await dialog.getByRole('button',{name:'编辑卷册关联',exact:true}).click();
 dialog=page.getByRole('dialog');await dialog.getByRole('group',{name:'再版来源',exact:true}).getByRole('button',{name:/合订版第 1 册/}).click();await dialog.getByRole('button',{name:'保存修改',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'不能形成循环'}).waitFor();
 const relationState=await page.evaluate(async()=>{const {readLibrary}=await import('/src/library/store.ts');const s=await readLibrary();return {series:s.series.length,books:s.publications.length,relations:s.publicationRelations.length};});assert.deepEqual(relationState,{series:2,books:3,relations:2});checks.push({publicationManagement:true,omnibusRelations:2,cycleRejected:true});await page.screenshot({path:path.join(output,'publication-cycle.png')});await context.close();
}finally{await browser.close();}
await writeFile(path.join(output,'results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks},null,2));console.log('Passed '+checks.length+' library browser scenarios.');
