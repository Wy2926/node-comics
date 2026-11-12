import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),engines=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.EXPORT_BROWSER||'chromium';
const {ZipReader,Uint8ArrayReader,TextWriter}=require('@zip.js/zip.js'),{PDFDocument}=require('pdf-lib');
const origin='http://127.0.0.1:5181',output=fileURLToPath(new URL('../../../artifacts/directory-export/',import.meta.url));
let browser,page,errors;
before(async()=>{await mkdir(output,{recursive:true});browser=await engines[engine].launch({headless:true,...engine==='chromium'?{executablePath:process.env.CHROMIUM_PATH}:{}});});
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
async function load(query='') {await page.goto(`${origin}/tests/directory-export-fixture.html${query}`);await page.locator('#open-export').focus();await page.locator('#open-export').press('Enter');await dialog().getByRole('combobox',{name:'导出范围',exact:true}).waitFor();}
async function select(label,value){await dialog().getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();}
async function whole(){await select('导出范围','整个章节目录');}
async function screenshot(name){await page.screenshot({path:output+name+'.png'});}
async function fits(){
  const issues=await dialog().evaluate(element=>[element,...element.querySelectorAll('.nc-modal-body,.nc-modal-actions,.nc-dialog-subject,.nc-dialog-notice,.form-grid,.nc-export-progress')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.className));
  assert.deepEqual(issues,[]);
  const bounds=await dialog().boundingBox(),footer=await dialog().locator('.nc-modal-actions').boundingBox();assert(bounds.y>=0&&bounds.y+bounds.height<=page.viewportSize().height+1);assert(footer.y>=bounds.y&&footer.y+footer.height<=bounds.y+bounds.height+1);
}
async function download(){const pending=page.waitForEvent('download');await action().click();const item=await pending;assert.equal(await item.failure(),null);await dialog().locator('[data-tone=success]').waitFor();return {name:item.suggestedFilename(),bytes:await readFile(await item.path())};}

test('exports real archives and PDFs across unvisited chapters with bounded image reads',async()=>{
  await load();const before=await page.evaluate(()=>window.directoryFixture.reading());
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.stats.indexes),[]);await whole();await fits();await screenshot('directory-light');
  for(const [format,label] of [['cbz','CBZ 漫画包'],['pdf','PDF 文档']]){
    await select('文件格式',label);const result=await download();assert(result.name.endsWith('.'+format));await writeFile(output+'chapters.'+format,result.bytes);
    if(format==='pdf')assert.equal((await PDFDocument.load(result.bytes)).getPageCount(),6);
    else{const reader=new ZipReader(new Uint8ArrayReader(result.bytes));try{
      const files=await reader.getEntries(),images=files.filter(file=>file.filename.endsWith('.png'));assert.equal(images.length,6);
      assert.deepEqual(images.map(file=>file.filename.split('/')[0]),[1,1,2,2,3,3].map(i=>`000${i}-第 ${i} 话 · 星海漫游`));
      const manifest=JSON.parse(await files.find(file=>file.filename==='export-manifest.json').getData(new TextWriter()));assert.equal(manifest.complete,true);assert.equal(manifest.chapters.length,3);assert.equal(manifest.pages.length,6);
    }finally{await reader.close();}}
  }
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
  const stats=await page.evaluate(()=>window.directoryFixture.stats);assert.deepEqual(stats.indexes,['chapter-1','chapter-2','chapter-3']);assert(stats.maximum<=2);assert(!stats.reads.includes('alternate'));
  await screenshot('directory-success');await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('#open-export')===document.activeElement);
});

test('chapter read failure produces no download and retry succeeds',async()=>{
  await load('?fail');await whole();let downloads=0;page.on('download',()=>downloads++);
  await action().click();await dialog().getByRole('alert').waitFor();assert.equal(downloads,0);assert(await action().isEnabled());await screenshot('directory-failure');
  await download();assert.equal(downloads,1);
});

for(const width of [320,1280])test(`${width}px export coalesces rapid progress and keeps text geometry stable`,async()=>{
  await page.setViewportSize({width,height:900});await load('?burst&scale=1.25');await whole();
  await dialog().evaluate(element=>{
    window.exportSamples=[];
    new MutationObserver(()=>{
      const panel=element.querySelector('.nc-export-progress'),bar=panel?.querySelector('progress');
      if(bar?.max!==72)return;
      const phase=panel.querySelector('strong').textContent,file=panel.querySelector('.nc-export-current'),count=panel.querySelector('.nc-export-count'),last=window.exportSamples.at(-1);
      if(last?.completed===bar.value&&last.phase===phase&&last.file===file.textContent)return;
      window.exportSamples.push({completed:bar.value,phase,file:file.textContent,height:panel.getBoundingClientRect().height,countWidth:count.getBoundingClientRect().width,overflow:panel.scrollWidth>panel.clientWidth+1});
    }).observe(element,{subtree:true,childList:true,characterData:true});
  });
  const pending=page.waitForEvent('download');await action().click();
  await page.waitForFunction(()=>window.exportSamples.length>=2);
  await dialog().locator('.nc-modal-body').evaluate(node=>{node.scrollTop=node.scrollHeight;});await fits();await screenshot(`directory-progress-${width}`);
  assert.equal(await(await pending).failure(),null);await dialog().locator('[data-tone=success]').waitFor();
  const samples=await page.evaluate(()=>window.exportSamples);
  assert(samples.length>=2&&samples.length<36,'Fast page events must be coalesced into readable updates');
  assert.deepEqual([...new Set(samples.map(sample=>sample.phase))],['处理中…']);
  for(const field of ['height','countWidth'])assert.equal(new Set(samples.map(sample=>sample[field])).size,1,`${field} must stay fixed across page numbers and chapter titles`);
  assert(samples.some(sample=>sample.file.includes('很长的章节标题')));assert(samples.every(sample=>!sample.overflow));
  for(let i=1;i<samples.length;i++)assert(samples[i].completed>=samples[i-1].completed);
});

test('cancellation, close and repeated clicks stop discovery without moving reading position',async()=>{
  await load('?slow');await whole();const before=await page.evaluate(()=>window.directoryFixture.reading());let downloads=0;page.on('download',()=>downloads++);
  await action().dblclick();await dialog().getByRole('button',{name:'取消导出',exact:true}).click();await action().waitFor();
  assert.equal(downloads,0);assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
  await action().click();await dialog().locator('.nc-export-progress').waitFor();await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);
  await page.waitForFunction(()=>window.directoryFixture.stats.active===0);assert.equal(downloads,0);
  assert.deepEqual(await page.evaluate(()=>window.directoryFixture.reading()),before);
});

test('Safari prepares a file, then saves from a fresh gesture; cancelling does not regenerate it',async()=>{
  await page.addInitScript(()=>{
    window.chrome={runtime:{getURL:path=>'safari-web-extension://FIXTURE/'+path}};
    window.sharedFiles=[];
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:async({files})=>{
      window.sharedFiles.push(files[0]);
      if(window.sharedFiles.length===1)throw new DOMException('User cancelled','AbortError');
    }});
  });
  let downloads=0;page.on('download',()=>downloads++);
  await load();await whole();await action().click();
  const save=dialog().getByRole('button',{name:'保存',exact:true});await save.waitFor();
  const before=await page.evaluate(()=>({reads:[...window.directoryFixture.stats.reads],shares:window.sharedFiles.length}));
  assert.equal(before.shares,0,'Preparing bytes must not open a share sheet without a fresh gesture');
  await save.click();await save.waitFor();await page.waitForFunction(()=>window.sharedFiles.length===1);
  assert.equal(await dialog().getByRole('alert').count(),0,'Share cancellation keeps the prepared file available');
  await save.click();await dialog().locator('[data-tone=success]').waitFor();
  const result=await page.evaluate(()=>({reads:window.directoryFixture.stats.reads,count:window.sharedFiles.length,
    same:window.sharedFiles[0]===window.sharedFiles[1],name:window.sharedFiles[1].name,size:window.sharedFiles[1].size}));
  assert.deepEqual(result.reads,before.reads);assert.equal(result.count,2);assert(result.same&&result.size>0&&result.name.endsWith('.cbz'));
  assert.equal(downloads,0);assert(page.url().startsWith(origin+'/tests/directory-export-fixture.html'));
});

test('Safari reports an unsupported save without navigating away from the reader',async()=>{
  await page.addInitScript(()=>{
    window.chrome={runtime:{getURL:path=>'safari-web-extension://FIXTURE/'+path}};
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});
  });
  await load();await whole();await action().click();
  await dialog().getByRole('alert').waitFor();
  assert((await dialog().getByRole('alert').textContent()).includes('无法保存此文件'));
  assert(page.url().startsWith(origin+'/tests/directory-export-fixture.html'));
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
