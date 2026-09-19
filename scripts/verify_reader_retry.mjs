// Start extension Vite on :5176. Real reader/hooks, isolated account and simulated API only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/reader-retry-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'chromium'})});
const checks=[],errors=[];let page;
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function open(offline=false){
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  const scenario=offline?'connection':'retry';
  await page.goto(web+'/tests/reader-fixture.html?auto='+scenario+(offline?'&offline':''));
  await page.locator('article.nc-book').filter({has:page.getByRole('button',{name:'打开作品 自动翻译 · '+scenario,exact:true})}).getByRole('button',{name:'开始阅读',exact:true}).click();
  await page.locator('.nc-page-image').waitFor();
}
async function geometry(){return page.locator('.nc-page-picture').first().evaluate(i=>({width:i.clientWidth,height:i.clientHeight,scroll:document.querySelector('.nc-reading-viewport').scrollTop}));}
async function waitSubmitted(count){await page.waitForFunction(count=>window.readerFixture.submitted.length===count,count,{timeout:15000});}
try{
  await open();
  const failed=page.getByRole('button',{name:'翻译失败 · 重试',exact:true});await failed.waitFor();
  assert.equal(await failed.innerText(),'翻译失败\n重试');assert((await failed.getAttribute('title')).includes('模拟文字识别失败'));
  const before=await geometry();await page.evaluate(()=>window.readerFixture.delay=800);
  await failed.click();const busy=page.getByRole('button',{name:'重试中',exact:true});await busy.waitFor();assert(await busy.isDisabled());
  await page.screenshot({path:path.join(out,'retry-pending.png')});check('retry immediately shows a spinner and disables repeat clicks');
  await busy.waitFor({state:'hidden'});await page.evaluate(()=>window.readerFixture.delay=0);await waitSubmitted(1);assert.deepEqual(await geometry(),before);check('failed-page retry submits once and preserves reading position');
  await page.evaluate(()=>window.readerFixture.failDownloads=true);await page.getByRole('button',{name:'模拟完成',exact:true}).click();
  const downloadFailure=page.getByRole('button',{name:'加载失败 · 重试',exact:true});await downloadFailure.waitFor({timeout:15000});
  await page.evaluate(()=>{window.readerFixture.failDownloads=false;window.readerFixture.delay=500;});await downloadFailure.click();await page.getByRole('button',{name:'重试中',exact:true}).waitFor();
  await page.locator('.nc-page-image[data-result-job^="submitted-"]').waitFor({timeout:15000});assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),1);check('download retry displays the existing result without regenerating or billing a new job');
  await page.close();
  await open(true);const offline=page.getByRole('button',{name:'连接失败 · 重试',exact:true});await offline.waitFor();
  await page.evaluate(()=>window.readerFixture.delay=700);await offline.click();await page.getByRole('button',{name:'重试中',exact:true}).waitFor();await offline.waitFor();
  assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),0);check('retry before capabilities/rights load gives visible feedback and remains a concise error while offline');
  await page.setViewportSize({width:390,height:844});const badge=await offline.boundingBox();assert(badge.width<220&&badge.height<46,JSON.stringify(badge));await page.screenshot({path:path.join(out,'offline-mobile.png')});check('failure notice remains one compact row on mobile; details are hover-only');
  const recoveringAt=Date.now();await page.evaluate(()=>{window.readerFixture.offline=false;window.readerFixture.delay=0;});await offline.click();await waitSubmitted(1);
  assert(Date.now()-recoveringAt<8000,'manual retry should bypass the existing eight-second network backoff');check('one retry restores service configuration and resumes work immediately after network recovery');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));console.log('Artifacts: '+out);
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser.close();}
