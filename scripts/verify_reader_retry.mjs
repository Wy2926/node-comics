// Start extension Vite on :5176. Real reader/hooks, isolated account and simulated API only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/reader-retry-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const checks=[],errors=[];let page;
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function open(offline=false){
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  const scenario=offline?'connection':'retry';
  await page.goto(web+'/tests/reader-fixture.html?auto='+scenario+(offline?'&offline':''));
  const entry=page.getByRole('button',{name:'打开漫画 自动翻译 · '+scenario,exact:true});await entry.waitFor();
  const releaseNotes=page.getByRole('button',{name:'知道了',exact:true});if(await releaseNotes.count())await releaseNotes.click();
  await entry.click();
  await page.locator('.nc-page-image').waitFor();
  await page.getByRole('button',{name:'翻译',exact:true}).click();
}
async function geometry(){return page.locator('.nc-page-picture').first().evaluate(i=>({width:i.clientWidth,height:i.clientHeight,scroll:document.querySelector('.nc-reading-viewport').scrollTop}));}
async function waitSubmitted(count){await page.waitForFunction(count=>window.readerFixture.submitted.length===count,count,{timeout:15000});}
try{
  await open();
  const failed=page.getByRole('button',{name:'翻译失败 · 重试',exact:true});await failed.waitFor();
  assert.match(await page.locator('.nc-translation-detail').first().innerText(),/模拟文字识别失败.*FIXTURE_FAILURE/);
  const before=await geometry();await page.evaluate(()=>window.readerFixture.delay=800);
  await failed.click();const busy=page.getByRole('button',{name:'重试中',exact:true});await busy.waitFor();assert(await busy.isDisabled());
  await page.screenshot({path:path.join(out,'retry-pending.png')});check('retry immediately shows a spinner and disables repeat clicks');
  await busy.waitFor({state:'hidden'});await page.evaluate(()=>window.readerFixture.delay=0);await waitSubmitted(1);assert.deepEqual(await geometry(),before);check('failed-page retry submits once and preserves reading position');
  await page.waitForFunction(()=>window.readerFixture.jobs.some(job=>['queued','running'].includes(job.status)));
  await page.evaluate(()=>window.readerFixture.failDownloads=true);await page.getByRole('button',{name:'模拟完成',exact:true}).click();
  const downloadFailure=page.getByRole('button',{name:'加载失败 · 重试',exact:true});await downloadFailure.waitFor({timeout:15000});
  const reads=await page.evaluate(()=>{window.readerFixture.failDownloads=false;window.readerFixture.delay=500;return window.readerFixture.requests.filter(path=>path.endsWith('/result')).length;});
  await downloadFailure.click();await page.waitForFunction(before=>window.readerFixture.requests.filter(path=>path.endsWith('/result')).length>before,reads);
  await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').waitFor({timeout:15000});assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),1);check('download retry displays the existing result without regenerating or billing a new job');
  await page.close();
  await open(true);const offline=page.getByRole('button',{name:'连接失败 · 重试',exact:true});await offline.waitFor();
  await page.evaluate(()=>window.readerFixture.delay=700);await offline.click();await page.getByRole('button',{name:'重试中',exact:true}).waitFor();await offline.waitFor();
  assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),0);check('retry before capabilities/rights load gives visible feedback and remains a concise error while offline');
  await page.setViewportSize({width:390,height:844});const detail=page.locator('.nc-translation-detail').first(),box=await detail.boundingBox();assert(box&&box.width>0&&box.height>0&&box.x>=0&&box.x+box.width<=390);assert.match(await detail.innerText(),/网络/);await page.screenshot({path:path.join(out,'offline-mobile.png')});check('mobile shows the cause inside the viewport without hovering or submitting a retry');
  const recoveringAt=Date.now();await page.evaluate(()=>{window.readerFixture.offline=false;window.readerFixture.delay=0;});await offline.click();await waitSubmitted(1);
  assert(Date.now()-recoveringAt<8000,'manual retry should bypass the existing eight-second network backoff');check('one retry restores service configuration and resumes work immediately after network recovery');
  await page.close();
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html?auto=connection');
  await page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true}).waitFor();
  const releaseNotes=page.getByRole('button',{name:'知道了',exact:true});if(await releaseNotes.count())await releaseNotes.click();
  await page.evaluate(async()=>{
    const {catalog}=await import('/src/comics/repositories/index.ts');
    const [comic]=await catalog.list('comics');
    localStorage.setItem('nc-comic-view:'+comic.id,JSON.stringify({mode:'unsupported',preference:'translation'}));
    const settings=JSON.parse(localStorage.getItem('nc-settings'));
    localStorage.setItem('nc-settings',JSON.stringify({...settings,translationMode:'unsupported',autoTranslateTabs:true}));
    window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));
  });
  await page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true}).click();
  await page.locator('.nc-page-image').waitFor();
  assert.equal(await page.getByRole('button',{name:'AI 重绘',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'原图',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>window.readerFixture.translationRequests.length),0);
  const recoveredGeometry=await geometry();
  await page.locator('.nc-translation-trigger').click();
  assert.equal(await page.getByRole('button',{name:'AI 重绘',exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'翻译',exact:true}).click();await waitSubmitted(1);
  assert(await page.evaluate(()=>window.readerFixture.translationRequests.every(request=>request.body.mode==='classic')));
  assert.deepEqual(await geometry(),recoveredGeometry);
  await page.screenshot({path:path.join(out,'classic-only-upgrade.png')});
  check('invalid viewing preferences restore originals; explicit classic selection submits without moving the page');
  await page.evaluate(async()=>{const {selectChannel}=await import('/src/translation/channels/index.ts');await selectChannel('shinobu');});
  const manage=page.getByRole('button',{name:'管理模型与字体',exact:true}),manager=page.getByRole('dialog',{name:'模型与字体',exact:true});
  await manage.waitFor();const position=await geometry(),submitted=await page.evaluate(()=>window.readerFixture.submitted.length);
  await manage.focus();await manage.press('Enter');await manager.waitFor();
  await manager.locator('.nc-resource-card').first().waitFor();assert(await manager.getByRole('button',{name:'下载缺少的必需资源'}).isEnabled());
  await manager.getByRole('button',{name:'关闭弹窗'}).click();await manager.waitFor({state:'hidden'});
  assert.deepEqual(await geometry(),position);assert(await manage.evaluate(button=>document.activeElement===button));assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),submitted);
  await page.goto(web+'/tests/reader-fixture.html?auto=connection#settings/resources');await manager.waitFor();
  await manager.getByRole('button',{name:'关闭弹窗'}).click();assert.equal(new URL(page.url()).hash,'#settings');
  check('missing resources open the download dialog from the image or a fresh settings tab; closing restores reader position and focus');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));console.log('Artifacts: '+out);
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser.close();}
