import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.join(root,'artifacts/source-architecture/formats');await mkdir(output,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=path.join(root,'apps/extension/.output/chrome-mv3');
const context=await chromium.launchPersistentContext(await mkdtemp(path.join(output,'profile-')),{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
try{
 await page.goto(`chrome-extension://${new URL(worker.url()).host}/reader.html`);await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await page.reload();
 for(const file of ['pages.pdf','pages.mobi','rar4.cbr','rar5.rar']){
  await page.locator('input[type=file]').setInputFiles({name:file,mimeType:'application/octet-stream',buffer:await readFile(path.join(root,'artifacts/import-validation',file))});
  const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.getByRole('button',{name:/^开始导入/}).click();await panel.locator('.nc-import-item.created,.nc-import-item.failed').waitFor({timeout:90000});
  assert.equal(await panel.locator('.nc-import-item.failed').count(),0,await panel.innerText());
  await panel.getByRole('button',{name:'开始阅读',exact:true}).click();await page.locator('img.nc-page-image').first().waitFor({timeout:60000});
  await page.screenshot({path:path.join(output,file+'.png')});checks.push({file,rendered:true,pageCount:await page.locator('.nc-reading-viewport').getAttribute('data-page-count')});
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.getByRole('button',{name:/导入结果/}).click();await panel.getByRole('button',{name:'完成',exact:true}).click();
 }
 for(const file of ['locked.pdf','corrupt.pdf']){
  await page.locator('input[type=file]').setInputFiles({name:file,mimeType:'application/pdf',buffer:await readFile(path.join(root,'artifacts/import-validation',file))});
  const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.getByRole('button',{name:/^开始导入/}).click();await panel.locator('.nc-import-item.failed').waitFor({timeout:90000});
  const failure=await panel.locator('[role=alert]').innerText();assert(failure.length>0);checks.push({file,rejected:true,reason:failure});await page.screenshot({path:path.join(output,file+'.png')});await panel.getByRole('button',{name:'完成',exact:true}).click();
 }
 await page.locator('input[type=file]').setInputFiles({name:'broken-image.cbz',mimeType:'application/zip',buffer:await readFile(path.join(root,'artifacts/import-validation/broken-image.cbz'))});
 const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.getByRole('button',{name:/^开始导入/}).click();await panel.locator('.nc-import-item.created').waitFor({timeout:60000});await panel.getByRole('button',{name:'开始阅读',exact:true}).click();await page.locator('img.nc-page-image').first().waitFor();
 const jump=page.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('2');await jump.press('Enter');await page.locator('[data-page-index="1"] .nc-image-failure').waitFor();await page.screenshot({path:path.join(output,'broken-page.png')});await jump.fill('1');await jump.press('Enter');await page.locator('[data-page-index="0"] img.nc-page-image').waitFor();checks.push({file:'broken-image.cbz',firstPageReadable:true,secondPageFailsIndependently:true});
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'results.json'),JSON.stringify({browser:context.browser()?.version(),extension:true,checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});console.error(errors);throw error;}finally{await context.close();}
