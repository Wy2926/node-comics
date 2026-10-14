// Run alongside modal.browser.mjs against the isolated Vite 5181 origin.
import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',output=fileURLToPath(new URL('../../../artifacts/confirmation-dialogs/',import.meta.url));
let browser,page,errors;
before(async()=>{await mkdir(output,{recursive:true});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});});
after(async()=>{await browser?.close();});
beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
  errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
});
afterEach(async()=>{await page.close();assert.deepEqual(errors,[]);});
const dialog=()=>page.locator('dialog[open]');
const action=name=>dialog().getByRole('button',{name,exact:true});
async function load(query=''){await page.goto(`${origin}/tests/confirmation-fixture.html${query}`);await page.locator('#open-export').waitFor();}
async function open(kind){await page.locator('#open-'+kind).click();}
async function snapshot(name){await page.screenshot({path:output+name+'.png'});}
async function fits(){
  const issues=await dialog().evaluate(element=>[element,...element.querySelectorAll('.nc-modal-body,.nc-modal-actions,.nc-dialog-subject,.nc-dialog-notice,.nc-dialog-footer')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.className));
  assert.deepEqual(issues,[],'no horizontal overflow');
  const bounds=await dialog().boundingBox(),footer=await dialog().locator('.nc-modal-actions').boundingBox();
  assert(bounds.y>=0&&bounds.y+bounds.height<=page.viewportSize().height+1);
  assert(footer.y>=bounds.y&&footer.y+footer.height<=bounds.y+bounds.height+1);
}
async function bookMenu(actionName){
  await page.getByRole('button',{name:'更多操作 · 星海漫游 · 第一卷',exact:true}).click();
  await page.getByRole('menuitem',{name:actionName,exact:true}).click();
}

test('export keeps actual source/page downloads, structured status and focus restoration',async()=>{
  await load();await open('export');await action('保存完整源文件').waitFor();
  assert.match(await dialog().innerText(),/仅当前内容，不包含其他章节/);
  assert.equal(await dialog().locator('.nc-dialog-subject').count(),1);
  await fits();await snapshot('export-light');
  for(const name of ['保存完整源文件','导出全部页面']){
    const download=page.waitForEvent('download');await action(name).click();
    assert.equal(await (await download).failure(),null);
    await dialog().locator('[role=status][data-tone=success]').waitFor();
    assert.equal(await dialog().locator('.nc-export-progress').count(),0);
  }
  await snapshot('export-success');await page.keyboard.press('Escape');
  assert.equal(await dialog().count(),0);
  assert(await page.locator('#open-export').evaluate(node=>node===document.activeElement));
});

test('incomplete export requires opt-in, shows inline failure, and EPUB has no page export',async()=>{
  await load();await open('incomplete');assert(await action('导出已发现页面').isDisabled());
  await dialog().getByRole('checkbox').check();assert(await action('导出已发现页面').isEnabled());
  await action('导出已发现页面').click();await dialog().getByRole('alert').waitFor();
  assert(await action('导出已发现页面').isEnabled());await snapshot('export-error');
  await page.keyboard.press('Escape');await open('epub');
  await dialog().getByText('完整源文件不可用，请重新获取后再导出。',{exact:true}).waitFor();
  assert.equal(await dialog().getByRole('combobox').count(),0);
  assert.equal(await dialog().locator('.nc-dialog-footer button').count(),0);
});

test('bulk removal shows bounded titles, preserves literal user text, and cancels without deleting',async()=>{
  await load();await open('library');await page.getByRole('button',{name:'批量管理',exact:true}).click();
  await page.getByRole('button',{name:'全选 8 部',exact:true}).click();await page.getByRole('button',{name:'移除漫画',exact:true}).click();
  assert.match(await dialog().innerText(),/已选 8 部作品/);assert.match(await dialog().innerText(),/还有 3 部漫画/);
  assert.equal(await dialog().locator('.nc-dialog-list li').count(),5);
  assert.equal(await dialog().locator('img').count(),0);
  assert.match(await dialog().innerText(),/<img src=x onerror=alert\(1\)>/);
  const before=await page.evaluate(()=>scrollY);await fits();await snapshot('remove-batch-light');
  await action('取消').click();assert.equal(await dialog().count(),0);assert.equal(await page.evaluate(()=>scrollY),before);
  assert.match(await page.locator('.nc-batch-toolbar').innerText(),/已选 8 部作品/);
  await page.getByRole('button',{name:'移除漫画',exact:true}).click();await action('移除漫画').click();
  await dialog().waitFor({state:'detached'});assert.match(await page.locator('#notice').innerText(),/已移除 8 部漫画/);
});

test('offline page/file actions expose distinct impacts and cancellation never starts work',async()=>{
  await load();await open('downloads');await bookMenu('清除离线内容');
  assert.match(await dialog().innerText(),/离线原图/);assert.match(await dialog().innerText(),/漫画与阅读记录/);await fits();await snapshot('clear-pages');await action('取消').click();
  await page.getByRole('button',{name:'重新下载',exact:true}).click();
  assert.match(await dialog().innerText(),/从头重新下载/);assert.match(await dialog().innerText(),/24.0 MB/);await snapshot('redownload');await page.keyboard.press('Escape');
  await open('complete-file');await page.locator('[data-file-download-id]').getByRole('button',{name:'清除离线内容',exact:true}).click();
  assert.match(await dialog().innerText(),/完整离线文件/);await snapshot('clear-file');await action('取消').click();
  await open('downloads');await page.locator('[data-file-download-id]').getByRole('button',{name:'取消缓存',exact:true}).click();
  assert.equal(await dialog().getAttribute('aria-label'),'取消缓存');await action('取消').click();
});

test('download failure is inline, busy guards prevent duplicate clicks and closing, then retry succeeds',async()=>{
  await load();await open('download');await fits();await snapshot('download-prompt');
  await action('下载后阅读').click();await page.keyboard.press('Escape');assert(await dialog().isVisible());
  assert(await action('处理中…').isDisabled());assert(await action('取消').isDisabled());
  await dialog().getByRole('alert').waitFor();assert.equal(await page.locator('#attempts').innerText(),'1');
  await snapshot('download-failure');await action('下载后阅读').click();await dialog().waitFor({state:'detached'});
  assert.equal(await page.locator('#attempts').innerText(),'2');
  assert(await page.locator('#open-download').evaluate(node=>node===document.activeElement));
});

test('source removal keeps counts and an inline retry that completes the interrupted cleanup',async()=>{
  await load('?fail');await open('remove-source');await action('移除书库及关联资料').waitFor();
  await page.waitForFunction(()=>!document.querySelector('dialog .button.danger').disabled);
  assert.match(await dialog().innerText(),/关联漫画：8 本/);assert.match(await dialog().innerText(),/远端书库文件保留/);
  await snapshot('remove-source');await action('移除书库及关联资料').click();await dialog().getByRole('alert').waitFor();
  assert(await action('移除书库及关联资料').isEnabled());await action('移除书库及关联资料').click();await dialog().waitFor({state:'detached'});
});

test('disconnect clearly preserves reading records and cancellation returns to the library',async()=>{
  await load();await open('remote');await page.getByRole('button',{name:'管理书库',exact:true}).click();
  await page.getByRole('menuitem',{name:'断开连接',exact:true}).click();
  assert.match(await dialog().innerText(),/停止来源请求/);assert.match(await dialog().innerText(),/漫画与阅读记录/);
  await snapshot('disconnect-source');await action('取消').click();
});

test('single removal identifies the comic and uses the same consequences as bulk removal',async()=>{
  await load();await open('library');
  await page.getByRole('button',{name:'打开漫画 星海漫游 · 第一卷',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'移除漫画',exact:true}).click();
  assert.match(await dialog().locator('.nc-dialog-subject').innerText(),/星海漫游 · 第一卷/);
  assert.equal(await dialog().locator('.nc-dialog-list').count(),0);await fits();await snapshot('remove-single');await action('取消').click();
});

test('dark narrow large-text removal keeps footer fixed and does not overflow',async()=>{
  await page.setViewportSize({width:320,height:640});await load('?theme=dark&scale=1.25');await open('library');
  await page.getByRole('button',{name:'批量管理',exact:true}).click();await page.getByRole('button',{name:'全选 8 部',exact:true}).click();await page.getByRole('button',{name:'移除漫画',exact:true}).click();
  await fits();const initial=await dialog().locator('.nc-modal-actions').boundingBox();
  await dialog().locator('.nc-modal-body').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  assert.deepEqual(await dialog().locator('.nc-modal-actions').boundingBox(),initial);await snapshot('remove-dark-320');await action('取消').click();
});

test('all 16 languages fit the download confirmation at 320px with large text',async()=>{
  await page.setViewportSize({width:320,height:640});
  for(const locale of ['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id']){
    await load(`?theme=dark&scale=1.25&locale=${locale}`);await open('download');await fits();
    assert(!/\{\d+\}/.test(await dialog().innerText()),locale+' has no unresolved placeholders');
    if(['de','en','zh-TW'].includes(locale))await snapshot('download-320-'+locale);
    await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);
  }
});
