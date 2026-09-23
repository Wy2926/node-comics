/** Built extension, fresh profile, generated originals; no live API or translation. */
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),out=path.join(root,'artifacts/source-architecture/export');await mkdir(out,{recursive:true});
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const appRequire=createRequire(path.join(root,'apps/extension/package.json')),{ZipReader,Uint8ArrayReader,TextWriter}=appRequire('@zip.js/zip.js'),{PDFDocument}=appRequire('pdf-lib');
const extension=path.join(root,'apps/extension/.output/chrome-mv3'),errors=[],checks=[];
const context=await chromium.launchPersistentContext(await mkdtemp(path.join(out,'profile-')),{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},acceptDownloads:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
async function download(button){const pending=page.waitForEvent('download');await button.click();const item=await pending;assert.equal(await item.failure(),null);return readFile(await item.path());}
try{
 await page.goto(`chrome-extension://${new URL(worker.url()).host}/reader.html`);await page.locator('input[type=file]').waitFor({state:'attached'});
 await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN'})));await page.reload();
 const original=await readFile(path.join(root,'artifacts/import-validation/pages.cbz'));
 await page.locator('input[type=file]').setInputFiles({name:'导出验收.cbz',mimeType:'application/zip',buffer:original});
 await page.locator('.nc-page-image').first().waitFor({timeout:60000});await page.getByRole('button',{name:'阅读设置',exact:true}).click();await page.getByRole('button',{name:'导出漫画',exact:true}).click();const panel=page.getByRole('dialog',{name:'导出漫画'});
 const source=await download(panel.getByRole('button',{name:'保存完整源文件',exact:true}));assert.deepEqual(source,original);checks.push('保存完整源文件逐字节相等');
 const zipped=await download(panel.getByRole('button',{name:'导出全部页面',exact:true}));const reader=new ZipReader(new Uint8ArrayReader(zipped));
 const entries=await reader.getEntries();assert.equal(entries.filter(e=>/\.png$/.test(e.filename)).length,3);const manifest=JSON.parse(await entries.find(e=>e.filename==='export-manifest.json').getData(new TextWriter()));assert(manifest);await reader.close();checks.push('CBZ主动物化全部3页，附导出清单');
 await panel.getByRole('combobox').first().click();await page.getByRole('option',{name:'PDF 文档',exact:true}).click();const pdf=await download(panel.getByRole('button',{name:'导出全部页面',exact:true}));assert.equal((await PDFDocument.load(pdf)).getPageCount(),3);checks.push('PDF导出3页可重新解析');
 await page.screenshot({path:path.join(out,'complete.png')});assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'results.json'),JSON.stringify({browser:context.browser()?.version(),checks,errors,liveProvider:false},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await context.close();}
