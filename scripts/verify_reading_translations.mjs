// Real Chromium reader, local synthetic API. Start extension Vite on :5176.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/reading-translations-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1280,height:900}}),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const snapshot=()=>page.evaluate(()=>({submitted:window.readerFixture.submitted,requests:window.readerFixture.requests,translations:window.readerFixture.translationRequests,jobs:window.readerFixture.jobs,completedAt:window.readerFixture.completedAt,downloadedAt:window.readerFixture.downloadedAt}));
async function jump(n){const input=page.getByLabel('跳转页码',{exact:true});await input.fill(String(n));await input.press('Enter');}
try{
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html?auto=pipeline');
  await page.locator('article.nc-book').filter({has:page.getByRole('button',{name:'打开漫画 自动翻译 · pipeline',exact:true})}).getByRole('button',{name:'开始阅读',exact:true}).click();
  await page.getByRole('button',{name:'常规翻译',exact:true}).click();
  await page.waitForFunction(()=>window.readerFixture.submitted.length===4);
  let state=await snapshot();assert.deepEqual(state.submitted,[0,1,2,3]);
  assert.deepEqual(state.translations.slice(0,4).map(item=>item.body.priority),['current','prefetch','prefetch','prefetch']);
  assert(state.translations.every(item=>/^[a-f0-9-]{36}$/.test(item.id)&&!('page_key' in item.body)&&!('session_id' in item.body)));
  check('current image is submitted first, followed by three independent prefetch images with short UUIDs');
  await page.evaluate(()=>{document.querySelector('.nc-reading-viewport').scrollTop+=4;});
  await page.waitForTimeout(400);assert.equal((await snapshot()).translations.length,state.translations.length);
  check('same-image scrolling sends no duplicate translation request');
  for(const current of [2,3]){
    await jump(current);await page.waitForFunction(n=>window.readerFixture.submitted.includes(n+2),current);
    const rolling=await snapshot();
    assert.equal(rolling.submitted.filter(n=>n===current+2).length,1);
  }
  await page.screenshot({path:path.join(out,'rolling-prefetch.png')});
  check('page 2 admits page 5 and page 3 admits page 6 without waiting for the original jobs');
  const started=Date.now();await jump(10);await page.waitForFunction(()=>window.readerFixture.submitted.includes(9));
  assert(Date.now()-started<1000);await page.waitForFunction(()=>window.readerFixture.submitted.includes(12));
  check('explicit navigation admits a fresh current image within one second while earlier jobs remain active');
  await page.evaluate(()=>window.readerFixture.unknown=true);await jump(14);
  await page.waitForFunction(()=>!window.readerFixture.unknown&&window.readerFixture.requests.includes('/v1/translations'));
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(14));
  state=await snapshot();assert.equal(state.submitted.filter(n=>n===13).length,1);
  check('lost acceptance response recovers the original UUID from a snapshot without duplicate translation');
  await page.evaluate(()=>window.readerFixture.rateBlockedUntil=Date.now()+4000);await jump(18);
  const beforeLimit=state.translations.length;
  await page.waitForFunction(count=>window.readerFixture.translationRequests.length>count,beforeLimit);
  await page.waitForTimeout(350);const limited=await snapshot();assert(!limited.submitted.includes(17));
  await page.evaluate(()=>window.readerFixture.finishNext());await page.waitForTimeout(600);
  assert.equal((await snapshot()).translations.length,limited.translations.length);
  check('job completion does not reopen the minute gate or cause a request loop');
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(17),null,{timeout:8000});
  check('deferred current image resumes automatically at its retry deadline');
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(20));
  await page.waitForTimeout(600);
  const beforeIdle=(await snapshot()).requests.filter(p=>p==='/v1/translations').length;
  await page.waitForTimeout(22000);state=await snapshot();
  const idleRequests=state.requests.filter(p=>p==='/v1/translations').length-beforeIdle;
  assert(idleRequests<=2,`too many idle update requests: ${idleRequests}`);
  assert(!state.requests.some(p=>p.startsWith('/v1/me/queues')||p.includes('reading-sessions')||p.includes('translation-plans')||p.includes('translation-operations')||p.includes('translation-changes')||p.startsWith('/v1/uploads')||/^\/v1\/jobs\//.test(p)));
  assert.deepEqual(errors,[]);
  check('idle reading holds one long poll, with zero queue preflights or repeated job GETs');
  await jump(1);
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await page.getByRole('button',{name:'单页阅读',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  const nextJob=await page.evaluate(()=>window.readerFixture.finishNext());assert(nextJob);
  await page.waitForFunction(()=>window.readerFixture.requests.includes('/v1/fixture-output'));
  await page.waitForFunction(()=>window.readerFixture.downloadedAt>=window.readerFixture.completedAt);
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'1');
  check('single-page reader downloads the next completed translation while still showing page 1');
  await page.screenshot({path:path.join(out,'reading.png')});
  assert(!state.requests.some(p=>p.startsWith('/v1/images/')&&p.endsWith('/access')));
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,translationRequests:state.translations.length,idleRequests,liveProvider:false},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,state:await snapshot().catch(()=>null)},null,2));throw error;}
finally{await browser.close();}
