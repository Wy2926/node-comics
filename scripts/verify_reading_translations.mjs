import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
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
const snapshot=()=>page.evaluate(()=>({submitted:window.readerFixture.submitted,requests:window.readerFixture.requests,translations:window.readerFixture.translationRequests,jobs:window.readerFixture.jobs,eventStreams:window.readerFixture.eventStreams,completedAt:window.readerFixture.completedAt,downloadedAt:window.readerFixture.downloadedAt}));
async function jump(n){const input=page.getByRole('slider',{name:'阅读进度',exact:true});await setReaderProgress(input, String(n));}
async function readerButton(name){await page.mouse.move(1,450);await page.getByRole('button',{name,exact:true}).click();}
try{
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html?auto=pipeline&long');
  await page.locator('.nc-release-notes[open] .nc-release-close').click();
  // Pin the long-page scenario; the product now defaults to 50%, which fits this fixture on one screen.
  await page.evaluate(async()=>{
    const {catalog}=await import('/src/comics/repositories/index.ts');
    const {readingViewKey,readingViewDefaults,saveReadingView}=await import('/src/reader/view.ts');
    const [comic]=await catalog.list('comics');saveReadingView(readingViewKey(comic.id),{...readingViewDefaults(),fit:'width'});
  });
  await page.locator('article.nc-book').filter({has:page.getByRole('button',{name:'打开漫画 自动翻译 · pipeline',exact:true})}).getByRole('button',{name:/^打开漫画 /}).click();
  await readerButton('翻译');
  await page.waitForFunction(()=>window.readerFixture.submitted.length===6);
  await page.waitForFunction(()=>window.readerFixture.requests.includes('/v1/translations/events'));
  let state=await snapshot();assert.deepEqual(state.submitted,[0,1,2,3,4,5]);
  await page.waitForFunction(()=>window.readerFixture.eventStreams.ids.length===6);
  assert.equal(await page.evaluate(()=>window.readerFixture.eventStreams.maxActive),1,'new UUIDs reconnect a single active stream without waiting for the full batch');
  assert(state.translations.every(item=>!('priority' in item.body)),'reading order is local scheduling, not a server priority field');
  assert(state.translations.every(item=>/^[a-f0-9-]{36}$/.test(item.id)&&!('page_key' in item.body)&&!('session_id' in item.body)));
  assert(state.translations.every(item=>!('comic_title' in item.body)),'translation requests must not include work-title context');
  check('current image is submitted first, followed by exactly five independent successor images with short UUIDs');
  await page.evaluate(()=>{document.querySelector('.nc-reading-viewport').scrollTop+=4;});
  await page.waitForTimeout(400);assert.equal((await snapshot()).translations.length,state.translations.length);
  check('same-image scrolling sends no duplicate translation request');
  for(const current of [1,2]){
    const metrics=await page.locator(`[data-page-index="${current-1}"]`).evaluate(cell=>{
      const v=cell.closest('.nc-reading-viewport'),r=cell.querySelector('.nc-page-picture').getBoundingClientRect();
      return {top:r.top-v.getBoundingClientRect().top+v.scrollTop,height:r.height,viewport:v.clientHeight};
    });
    const threshold=Math.max(0,Math.min(metrics.height/3,metrics.height-metrics.viewport));assert(threshold>0);
    await page.locator('.nc-reading-viewport').evaluate((v,top)=>{v.scrollTop=top;},metrics.top+threshold-3);
    await page.waitForTimeout(300);const beforeThreshold=(await snapshot()).translations.length;
    await page.locator('.nc-reading-viewport').evaluate((v,top)=>{v.scrollTop=top;},metrics.top+threshold+3);
    await page.waitForTimeout(300);assert.equal((await snapshot()).translations.length,beforeThreshold);
    assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),String(current));
    await page.waitForTimeout(300);const rolling=await snapshot();
    assert.equal(rolling.submitted.filter(n=>n===current+4).length,1);assert(!rolling.submitted.includes(current+5));
    if(current===1){await jump(2);await page.waitForFunction(()=>window.readerFixture.submitted.includes(6));}
  }
  await page.screenshot({path:path.join(out,'rolling-prefetch.png')});
  check('five successors are submitted before scrolling; crossing one-third adds no duplicate or sixth successor, and the next page refills the window');
  await readerButton('阅读设置');
  await page.getByRole('button',{name:'双页',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  await jump(3);await page.waitForFunction(()=>window.readerFixture.submitted.includes(7));
  await page.waitForFunction(()=>window.readerFixture.eventStreams.ids.length===7);
  assert.deepEqual((await snapshot()).submitted,[0,1,2,3,4,5,6,7]);
  assert.deepEqual(await page.locator('.nc-reading-surface .nc-manga-page').evaluateAll(cells=>cells.map(cell=>Number(cell.dataset.pageIndex))),[1,2]);
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'3');
  await page.waitForTimeout(300);assert.equal((await snapshot()).submitted.length,8);
  await page.screenshot({path:path.join(out,'double-five-successors.png')});
  check('double-page reading submits both current pages 2–3 plus five successors 4–8, while mounting only two pages');
  await readerButton('阅读设置');
  await page.getByRole('button',{name:'单页',exact:true}).click();
  await page.getByRole('button',{name:'适应窗口',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  const started=Date.now();await jump(10);await page.waitForFunction(()=>window.readerFixture.submitted.includes(9));
  assert(Date.now()-started<1000);await page.waitForFunction(()=>window.readerFixture.submitted.includes(14));
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'10');
  check('single-page reading submits page 10 and five successors before scrolling, while a direct jump still starts the current page within one second');
  await page.evaluate(()=>window.readerFixture.unknown=true);await jump(17);
  await page.waitForFunction(()=>!window.readerFixture.unknown&&window.readerFixture.requests.includes('/v1/translations'));
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(21));
  state=await snapshot();assert.equal(state.submitted.filter(n=>n===16).length,1);
  check('lost acceptance response recovers the original UUID from a snapshot without duplicate translation');
  await page.evaluate(()=>window.readerFixture.rateBlockedUntil=Date.now()+4000);await jump(25);
  const beforeLimit=state.translations.length;
  await page.waitForFunction(count=>window.readerFixture.translationRequests.length>count,beforeLimit);
  await page.waitForTimeout(350);const limited=await snapshot();assert(!limited.submitted.includes(24));
  await page.evaluate(()=>window.readerFixture.finishNext());await page.waitForTimeout(600);
  assert.equal((await snapshot()).translations.length,limited.translations.length);
  check('job completion does not reopen the minute gate or cause a request loop');
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(24),null,{timeout:8000});
  check('deferred current image resumes automatically at its retry deadline');
  await page.waitForFunction(()=>window.readerFixture.submitted.includes(29));
  await page.waitForTimeout(600);
  const beforeState=await snapshot(),beforeIdle=beforeState.requests.filter(p=>p==='/v1/translations'||p==='/v1/translations/events').length;
  const beforePolicy=beforeState.requests.filter(p=>p==='/v1/capabilities'||p==='/v1/me/entitlements').length;
  await page.evaluate(()=>{for(let i=0;i<10;i++)window.dispatchEvent(new Event('focus'));});
  await page.waitForTimeout(22000);state=await snapshot();
  const idleRequests=state.requests.filter(p=>p==='/v1/translations'||p==='/v1/translations/events').length-beforeIdle;
  assert.equal(idleRequests,0,`unexpected idle update requests: ${idleRequests}`);
  assert.equal(state.requests.filter(p=>p==='/v1/capabilities'||p==='/v1/me/entitlements').length,beforePolicy);
  assert(!state.requests.some(p=>p.startsWith('/v1/me/queues')||p.includes('reading-sessions')||p.includes('translation-plans')||p.includes('translation-operations')||p.includes('translation-changes')||p.startsWith('/v1/uploads')||/^\/v1\/jobs\//.test(p)));
  assert.deepEqual(errors,[]);
  check('idle reading reuses SSE for 22 seconds with zero repeated HTTP reads, including ten focus events');
  await jump(1);
  await readerButton('阅读设置');
  await page.getByRole('button',{name:'单页',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  const nextJob=await page.evaluate(()=>window.readerFixture.finishNext());assert(nextJob);
  await page.waitForFunction(()=>window.readerFixture.requests.some(path=>path.endsWith('/result')));
  await page.waitForFunction(()=>window.readerFixture.downloadedAt>=window.readerFixture.completedAt);
  await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').waitFor();
  assert.deepEqual(await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').first().evaluate(image=>[image.naturalWidth,image.naturalHeight]),[640,900]);
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'1');
  const resultPath=`/v1/translations/${nextJob}/result`;
  await page.waitForFunction(path=>window.readerFixture.requests.includes(path),resultPath);
  await page.waitForFunction(async id=>{
    const [{translationScope,readJobs},{resultBlobKey},{translationCache},{API_ORIGIN}]=await Promise.all([
      import('/src/translation/channels/adapters/nodelane/store.ts'),import('/src/storage/translations/results.ts'),
      import('/src/storage/translations/index.ts'),import('/src/service.ts'),
    ]);
    const scope={key:translationScope(API_ORIGIN,'fixture-pipeline')},jobs=await readJobs(scope.key,[],[id]);
    return !!jobs[0]&&await translationCache.has(resultBlobKey(scope,jobs[0]));
  },nextJob);
  assert.equal(await page.locator(`.nc-page-image[data-result-job="${nextJob}"]`).count(),0);
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'1');
  assert.equal((await snapshot()).requests.filter(path=>path===resultPath).length,1);
  check('single-page reader downloads, composes and persistently caches the completed offscreen page before navigation');
  const firstJob=await page.locator('.nc-page-image').first().getAttribute('data-result-job');
  await jump(2);await page.locator(`.nc-page-image[data-result-job="${nextJob}"]`).waitFor();
  assert.equal((await snapshot()).requests.filter(path=>path===resultPath).length,1);
  check('navigating to the prefetched translation reuses complete local bytes with zero additional result downloads');
  await page.screenshot({path:path.join(out,'prefetched-result.png')});
  await jump(1);await page.locator(`.nc-page-image[data-result-job="${firstJob}"]`).waitFor();
  await page.screenshot({path:path.join(out,'reading.png')});
  await readerButton('阅读设置');
  await page.getByRole('button',{name:'连续',exact:true}).click();
  await page.getByRole('button',{name:'铺满宽度',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.locator('.nc-reading-viewport').evaluate(node=>{node.scrollTop=200;});
  await page.waitForTimeout(200);
  const top=await page.locator('.nc-reading-viewport').evaluate(node=>node.scrollTop);
  const resultId=await page.locator('.nc-page-image').first().getAttribute('data-result-job');
  const submittedBeforeSwitch=(await snapshot()).translations.length;
  assert(top>100);assert(resultId&&resultId!=='original');
  await readerButton('原图');
  await page.waitForFunction(()=>document.querySelector('.nc-page-image')?.getAttribute('data-result-job')==='original');
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'1');
  assert(Math.abs(await page.locator('.nc-reading-viewport').evaluate(node=>node.scrollTop)-top)<1);
  await readerButton('翻译');
  await page.waitForFunction(id=>document.querySelector('.nc-page-image')?.getAttribute('data-result-job')===id,resultId);
  assert.equal(await page.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'1');
  assert(Math.abs(await page.locator('.nc-reading-viewport').evaluate(node=>node.scrollTop)-top)<1);
  state=await snapshot();assert.equal(state.translations.length,submittedBeforeSwitch);
  assert(!state.requests.some(p=>p.startsWith('/v1/comic-titles/')),'body translation must not query the title translation service');
  assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>window.readerFixture.eventStreams.maxActive),1);
  check('original and translated views preserve a nonzero in-page reading position without resubmission');
  await page.screenshot({path:path.join(out,'switched-position.png')});
  assert(!state.requests.some(p=>p.startsWith('/v1/images/')&&p.endsWith('/access')));
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,translationRequests:state.translations.length,idleRequests,liveProvider:false},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,state:await snapshot().catch(()=>null)},null,2));throw error;}
finally{await browser.close();}
