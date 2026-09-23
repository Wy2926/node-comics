// Start extension Vite on :5176. Isolated Chrome profile and synthetic API only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/history-removal-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const library=page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的漫画',exact:true});
const book=page.locator('article.nc-book').filter({has:page.getByRole('button',{name:'打开漫画 星光书店',exact:true})});
async function inLibrary(){
  await page.waitForURL(url=>url.hash==='#library');
  await library.waitFor();
  assert.equal(await library.getAttribute('aria-current'),'page');
  assert.equal(await page.getByRole('button',{name:'翻译记录',exact:true}).count(),0);
  await book.waitFor();
}
async function openBook(){await book.getByRole('button',{name:/^(开始阅读|继续阅读)$/}).click();await page.locator('.nc-page-image').first().waitFor();}
try{
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html?historyRemoval=1#history');
  await inLibrary();
  assert.equal(new URL(page.url()).search,'?historyRemoval=1');
  check('direct legacy hash opens the library and preserves query parameters');
  await page.screenshot({path:path.join(out,'library.png')});

  await page.getByRole('button',{name:'外观与设置',exact:true}).click();
  await page.waitForURL(url=>url.hash==='#settings');
  await page.evaluate(()=>{location.hash='history';});
  await inLibrary();
  await page.goBack();
  await page.waitForURL(url=>url.hash==='#settings');
  await page.getByRole('heading',{name:'外观与偏好',exact:true}).waitFor();
  await page.goForward();
  await inLibrary();
  check('legacy hash changes, browser back and forward retain valid navigation');

  await page.locator('button.nc-account-button').click();
  await page.waitForURL(url=>url.hash==='#account');
  await page.getByRole('heading',{name:'我的账户',exact:true}).waitFor();
  await page.evaluate(()=>{location.hash='queue';});
  await inLibrary();
  check('account navigation still works and unknown hashes return to the library');

  await openBook();
  await page.getByLabel('跳转页码',{exact:true}).fill('5');await page.getByLabel('跳转页码',{exact:true}).press('Enter');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='5');
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(out,'reader.png')});
  await page.evaluate(()=>{location.hash='history';});
  await inLibrary();
  await openBook();
  await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='5');
  check('leaving the reader through the legacy hash retains the saved page on reopening');
  await page.evaluate(()=>{location.hash='queue';});
  await inLibrary();

  const rightsBefore=await page.evaluate(()=>window.readerFixture.requests.filter(url=>url==='/v1/me/entitlements').length);
  await page.clock.install();
  await page.clock.runFor(120_000);
  await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
  await page.clock.runFor(100);
  const requests=await page.evaluate(()=>window.readerFixture.requests);
  assert(!requests.some(url=>url==='/v1/translation-operations'||url.startsWith('/v1/me/queues')));
  assert(!requests.includes('/v1/me/translation-changes'));
  assert(requests.filter(url=>url==='/v1/me/entitlements').length>rightsBefore);
  check('no history, queue or translation polling in original mode; after two minutes idle, focus still refreshes account rights');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,requests,liveProvider:false},null,2));
}catch(error){
  await page.screenshot({path:path.join(out,'failure.png')});
  await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));
  throw error;
}finally{await browser.close();}
