import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
// Start isolated Vite :5181. Native Chromium, synthetic local PNGs and status updates.
// READER_PERF_LABEL names artifacts only; every run enforces the current contract.
// Timings include development React and fixture instrumentation, not real source/network/model work.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',label=process.env.READER_PERF_LABEL||'current';
assert(/^[a-zA-Z0-9_-]+$/.test(label),'READER_PERF_LABEL must be a filename-safe label');
const out=path.resolve('output/playwright/reader-performance');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const results=[],supplemental=[],errors=[],blockedRequests=[],violations=[];let currentPage,failure;
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function readyWindow(page){
 await page.waitForFunction(()=>{
  const cells=[...document.querySelectorAll('[data-page-index]')];
  return cells.length>0&&cells.length<=4&&cells.every(cell=>{const image=cell.querySelector('.nc-page-image');return image?.complete&&image.naturalWidth>0;});
 });
 await settle(page);
}
const metrics=async session=>Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
const difference=(before,after)=>Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(key=>[key,key.endsWith('Duration')?Number(((after[key]-before[key])*1000).toFixed(3)):after[key]-before[key]]));

try{
 for(const pages of [120,1000]){
  const context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
  const page=await context.newPage();currentPage=page;page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
   const url=route.request().url();if(new URL(url).origin===origin||url.startsWith('blob:')||url.startsWith('data:'))return route.continue();
   blockedRequests.push(url);return route.abort();
  });
  await page.addInitScript(()=>{
   localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light'}));
   localStorage.setItem('isolated-window-fixture',JSON.stringify({mode:'classic',preference:'translation',fit:'window',zoom:100}));
   const durations=[];window.__readerLongTasks=durations;
   if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{for(const entry of list.getEntries())durations.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
  });
  const session=await context.newCDPSession(page);await session.send('Performance.enable');
  await page.goto(`${origin}/tests/reader-window-fixture.html?performance=1&pages=${pages}`);
  await page.locator('.nc-page-image').first().waitFor();await settle(page);
  assert(await page.evaluate(()=>window.__readerFixturePerformance.snapshot().dimensionReads>0),'geometry instrumentation must observe the initial layout');
  const input=page.getByLabel('阅读进度',{exact:true});
  await setReaderProgress(input, String(Math.floor(pages/2)));await readyWindow(page);
  for(const phase of ['status','scroll','scroll-status']){
   await page.evaluate(()=>{window.__readerFixturePerformance.reset();window.__readerLongTasks.length=0;});
   const before=await metrics(session);
   const samples=await page.evaluate(async phase=>{
    const viewport=document.querySelector('.nc-reading-viewport');
    const status=[...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('更新模拟翻译状态'));
    const frameTimes=[],jumps=[];let maxMounted=0,maxImages=0,maxJump=0,previousTime;
    const start=performance.now(),initial=viewport.scrollTop;
    for(let step=0;step<120;step++){
     const now=await new Promise(requestAnimationFrame);if(previousTime!==undefined)frameTimes.push(now-previousTime);previousTime=now;
     const direction=step<60?1:-1;
     if(phase!=='status')viewport.scrollTop+=direction*96;
     const expected=viewport.scrollTop;
     if(phase==='status'||phase==='scroll-status'&&step%4===0)status.click();
     maxJump=Math.max(maxJump,Math.abs(viewport.scrollTop-expected));
     if(Math.abs(viewport.scrollTop-expected)>=1)jumps.push({step,expected,actual:viewport.scrollTop});
     maxMounted=Math.max(maxMounted,document.querySelectorAll('[data-page-index]').length);
     maxImages=Math.max(maxImages,document.querySelectorAll('.nc-page-image').length);
    }
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    frameTimes.sort((a,b)=>a-b);
    return {elapsedMs:performance.now()-start,initial,final:viewport.scrollTop,maxMounted,maxImages,maxJump,jumps,steps:120,
     frameMs:{p50:frameTimes[Math.floor(frameTimes.length*.5)],p95:frameTimes[Math.floor(frameTimes.length*.95)],max:frameTimes.at(-1),over33:frameTimes.filter(value=>value>33.4).length,over50:frameTimes.filter(value=>value>50).length},
     fixture:window.__readerFixturePerformance.snapshot(),longTasks:window.__readerLongTasks.slice()};
   },phase);
   const after=await metrics(session),result={pages,phase,...samples,cdp:difference(before,after)};
   results.push(result);console.log(JSON.stringify(result));
   if(result.maxMounted>4)violations.push(`${pages}/${phase}: mounted page window grew to ${result.maxMounted}`);
   if(result.maxImages>4)violations.push(`${pages}/${phase}: image window grew to ${result.maxImages}`);
   if(result.maxJump>=1)violations.push(`${pages}/${phase}: translation commit moved the scroll position by ${result.maxJump}px`);
   if(Math.abs(result.final-result.initial)>=1)violations.push(`${pages}/${phase} did not return to its original position`);
   // Budget fixed input steps, not React commits: extra rerenders must not make
   // the test more lenient. Exact offset reuse is covered by the geometry unit test.
   if(result.fixture.dimensionReads>result.steps*200)violations.push(`${pages}/${phase}: dimension reads exceeded 200 per input step`);
  }
  await page.screenshot({path:path.join(out,`${label}-${pages}.png`)});await context.close();currentPage=undefined;
 }
 {
  // A non-zero chapter origin and a non-integer page height expose floating-point
  // signature changes that an integer-sized first chapter cannot reproduce.
  const context=await browser.newContext({viewport:{width:1199,height:900},locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
  const page=await context.newPage();currentPage=page;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>localStorage.setItem('isolated-window-fixture',JSON.stringify({mode:'classic',preference:'translation',fit:'width',zoom:50})));
  await page.goto(`${origin}/tests/reader-window-fixture.html?performance=1&fractional=1`);
  await page.locator('.nc-page-image').first().waitFor();await settle(page);
  await page.getByRole('button',{name:'切下一章',exact:true}).click();await settle(page);
  const input=page.getByLabel('阅读进度',{exact:true});await setReaderProgress(input, '60');await readyWindow(page);
  const result=await page.evaluate(async()=>{
   const viewport=document.querySelector('.nc-reading-viewport'),stack=document.querySelector('[data-copy-id="window-fixture-1"] .nc-page-stack');
   const status=[...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('更新模拟翻译状态'));
   const initial=viewport.scrollTop,stackTop=stack.getBoundingClientRect().top-viewport.getBoundingClientRect().top+viewport.scrollTop;
   const pageHeight=stack.querySelector('[data-page-index]').getBoundingClientRect().height;
   let maxJump=0,maxMounted=0;
   for(let step=0;step<120;step++){
    await new Promise(requestAnimationFrame);viewport.scrollTop+=(step<60?1:-1)*96;
    const expected=viewport.scrollTop;if(step%4===0)status.click();
    maxJump=Math.max(maxJump,Math.abs(viewport.scrollTop-expected));
    maxMounted=Math.max(maxMounted,document.querySelectorAll('[data-page-index]').length);
   }
   await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   return {name:'fractional-second-chapter',initial,final:viewport.scrollTop,stackTop,pageHeight,maxJump,maxMounted};
  });
  supplemental.push(result);console.log(JSON.stringify(result));
  if(result.stackTop<=0||Number.isInteger(result.pageHeight))violations.push('fractional scenario must have a non-zero chapter origin and fractional page height');
  if(result.maxJump>=1||Math.abs(result.final-result.initial)>=1)violations.push('fractional second chapter moved during mixed scrolling and translation status updates');
  if(result.maxMounted>4)violations.push('fractional second chapter exceeded the mounted page window');
  await page.screenshot({path:path.join(out,`${label}-fractional-second-chapter.png`)});await context.close();currentPage=undefined;
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(violations,[]);
}catch(error){
 failure=error.message;
 if(currentPage&&!currentPage.isClosed())await currentPage.screenshot({path:path.join(out,`${label}-failure.png`)}).catch(()=>{});
 throw error;
}finally{
 await writeFile(path.join(out,`${label}.json`),JSON.stringify({label,browser:browser.version(),viewport:{width:1280,height:900},pages:[120,1000],framesPerPhase:120,statusUpdatesPerMixedPhase:30,results,supplemental,errors,blockedRequests,violations,complete:results.length===6&&supplemental.length===1&&!failure,failure,scope:'development React; synthetic local PNGs; no live network, translation service or production/device performance claim'},null,2));
 await browser.close();
}
