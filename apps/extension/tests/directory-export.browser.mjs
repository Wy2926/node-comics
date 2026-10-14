import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {ZipReader,Uint8ArrayReader,TextWriter}=require('@zip.js/zip.js'),{PDFDocument}=require('pdf-lib');
const origin='http://127.0.0.1:5181',output=fileURLToPath(new URL('../../../artifacts/directory-export/',import.meta.url));
let browser,page,errors;
before(async()=>{await mkdir(output,{recursive:true});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});});
after(async()=>{await browser?.close();});
beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
  errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
});
afterEach(async()=>{await page.close();assert.deepEqual(errors,[]);});
const dialog=()=>page.getByRole('dialog');
const action=()=>dialog().getByRole('button',{name:'导出整个章节目录',exact:true});
async function load(query='') {await page.goto(`${origin}/tests/directory-export-fixture.html${query}`);await page.locator('#open-export').click();await dialog().getByRole('combobox',{name:'导出范围',exact:true}).waitFor();}
async function select(label,value){await dialog().getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();}
async function whole(){await select('导出范围','整个章节目录');}
async function screenshot(name){await page.screenshot({path:output+name+'.png'});}
async function fits(){
  const issues=await dialog().evaluate(element=>[element,...element.querySelectorAll('.nc-modal-body,.nc-modal-actions,.nc-dialog-subject,.nc-dialog-notice,.form-grid,.nc-export-progress')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.className));
  assert.deepEqual(issues,[]);
  const bounds=await dialog().boundingBox(),footer=await dialog().locator('.nc-modal-actions').boundingBox();assert(bounds.y>=0&&bounds.y+bounds.height<=page.viewportSize().height+1);assert(footer.y>=bounds.y&&footer.y+footer.height<=bounds.y+bounds.height+1);
}
async function download(){const pending=page.waitForEvent('download');await action().click();const item=await pending;assert.equal(await item.failure(),null);await dialog().locator('[data-tone=success]').waitFor();return {name:item.suggestedFilename(),bytes:await readFile(await item.path())};}

test('exports real CBZ, ZIP and PDF across unvisited chapters, keeps progress and one image at a time',async()=>{
  await load();const before=await page.evaluate(()=>window.directoryFixture.reading());
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.stats.indexes),[]);await whole();await fits();await screenshot('directory-light');
  for(const [format,label] of [['cbz','CBZ 漫画包'],['zip','ZIP 图片包'],['pdf','PDF 文档']]){
    await select('文件格式',label);const result=await download();assert(result.name.endsWith('.'+format));await writeFile(output+'chapters.'+format,result.bytes);
    if(format==='pdf')assert.equal((await PDFDocument.load(result.bytes)).getPageCount(),6);
    else{const reader=new ZipReader(new Uint8ArrayReader(result.bytes));try{
      const files=await reader.getEntries(),images=files.filter(file=>file.filename.endsWith('.png'));assert.equal(images.length,6);
      assert.deepEqual(images.map(file=>file.filename.split('/')[0]),[1,1,2,2,3,3].map(i=>`000${i}-第 ${i} 话 · 星海漫游`));
      const manifest=JSON.parse(await files.find(file=>file.filename==='export-manifest.json').getData(new TextWriter()));assert.equal(manifest.complete,true);assert.equal(manifest.chapters.length,3);assert.equal(manifest.pages.length,6);
    }finally{await reader.close();}}
  }
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
  const stats=await page.evaluate(()=>window.directoryFixture.stats);assert.deepEqual(stats.indexes,['chapter-1','chapter-2','chapter-3']);assert.equal(stats.maximum,1);assert(!stats.reads.includes('alternate'));
  await screenshot('directory-success');await page.keyboard.press('Escape');assert(await page.locator('#open-export').evaluate(node=>node===document.activeElement));
});

test('chapter read failure produces no download and retry succeeds',async()=>{
  await load('?fail');await whole();let downloads=0;page.on('download',()=>downloads++);
  await action().click();await dialog().getByRole('alert').waitFor();assert.equal(downloads,0);assert(await action().isEnabled());await screenshot('directory-failure');
  await download();assert.equal(downloads,1);
});

test('cancellation, close and repeated clicks stop discovery without moving reading position',async()=>{
  await load('?slow');await whole();const before=await page.evaluate(()=>window.directoryFixture.reading());let downloads=0;page.on('download',()=>downloads++);
  await action().dblclick();await dialog().getByRole('button',{name:'取消导出',exact:true}).click();await action().waitFor();
  assert.equal(downloads,0);assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
  await action().click();await dialog().locator('.nc-export-progress').waitFor();await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);
  await page.waitForFunction(()=>window.directoryFixture.stats.active===0);assert.equal(downloads,0);
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
});

test('320px dark large-text dialog keeps selection, close and footer within the viewport in 16 locales',async()=>{
  await page.setViewportSize({width:320,height:640});
  for(const locale of ['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id']){
    await page.goto(`${origin}/tests/directory-export-fixture.html?theme=dark&scale=1.25&locale=${locale}`);await page.locator('#open-export').click();
    const selector=dialog().getByRole('combobox').first();await selector.waitFor();await selector.click();await page.getByRole('option').nth(1).click();await fits();
    const footer=await dialog().locator('.nc-modal-actions').boundingBox();await dialog().locator('.nc-modal-body').evaluate(node=>{node.scrollTop=node.scrollHeight;});assert.deepEqual(await dialog().locator('.nc-modal-actions').boundingBox(),footer);
    assert(!/\{\d+\}/.test(await dialog().innerText()));if(['zh-CN','de','en'].includes(locale))await screenshot('directory-320-'+locale);await page.keyboard.press('Escape');
  }
});
