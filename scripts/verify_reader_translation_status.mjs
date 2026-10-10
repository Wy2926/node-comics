// Vite :5176, real 640 x 20000 PNG, isolated account and simulated translation API.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5176',out=path.resolve('artifacts/reader-translation-status');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
await page.addInitScript(()=>{
  window.decodeTest={hold:false,reject:false,releases:[]};
  const native=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=function(){
    const decoded=native.call(this);
    if(!this.src.startsWith('blob:'))return decoded;
    if(window.decodeTest.reject){window.decodeTest.reject=false;return decoded.then(()=>{throw new DOMException('Synthetic decode failure','TimeoutError');});}
    return window.decodeTest.hold?decoded.then(()=>new Promise(resolve=>window.decodeTest.releases.push(resolve))):decoded;
  };
});
const viewport=page.locator('.nc-reading-viewport'),badge=page.locator('.nc-image-status-layer .nc-image-translation');
const position=()=>viewport.evaluate(v=>v.scrollTop);
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const rerun=page.locator('[data-reader-retry-trigger]');
const railPositions=()=>page.evaluate(()=>Object.fromEntries([
  '[data-reader-back-trigger]','[data-reader-directory-trigger]',
  '.nc-reader-navigation>button:first-child','.nc-reader-navigation>button:last-child',
  '.nc-page-versions>button:first-child','.nc-page-versions>button:last-child',
  '.nc-translation-trigger','[data-reader-settings-trigger]',
].map(selector=>{const {x,y,width,height}=document.querySelector(selector).getBoundingClientRect();return [selector,{x,y,width,height}];})));
async function stableRails(expected){await page.mouse.move(640,80);await settle();assert.deepEqual(await railPositions(),expected);}
try{
  await page.goto(origin+'/tests/reader-fixture.html?auto=connection&long&native-long');
  const open=page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true});await open.waitFor();
  const releaseNotes=page.getByRole('button',{name:'知道了',exact:true});if(await releaseNotes.count())await releaseNotes.click();
  await open.click();await page.locator('.nc-page-image').waitFor();
  assert.equal(await page.locator('.nc-page-image').evaluate(image=>image.naturalHeight),20000);
  assert.equal(await page.getByRole('button',{name:'翻译状态',exact:true}).count(),0);
  await page.mouse.move(640,80);await settle();const initialRails=await railPositions();
  assert.equal(await rerun.count(),0);
  await page.screenshot({path:path.join(out,'rails-before-translation.png')});
  checks.push('The reading toolbar contains no development diagnostics or premature rerun action');

  await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.waitForFunction(()=>window.readerFixture.submitted.length===1);await badge.waitFor();
  assert.equal(await rerun.count(),0);
  await viewport.evaluate(v=>v.scrollTop=document.querySelector('.nc-page-picture').clientHeight/3);await settle();
  const before=await position();
  const geometry=await page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    return {picture:rect('.nc-page-picture'),status:rect('.nc-image-status-layer .nc-image-translation'),viewport:rect('.nc-reading-viewport')};
  });
  assert(geometry.picture.top<geometry.viewport.top&&geometry.picture.bottom>geometry.viewport.bottom);
  assert(geometry.status.top>=geometry.viewport.top&&geometry.status.bottom<geometry.viewport.bottom,JSON.stringify(geometry));
  await page.screenshot({path:path.join(out,'long-image-visible-status.png')});
  checks.push('The badge stays inside the viewport at one third of an actual 20000px image');

  // No-text is terminal, but an explicit rerun must use regenerate_of instead of reusing it.
  await page.evaluate(()=>{const job=window.readerFixture.jobs.at(-1);job.status='no_text';job.updated_at=new Date().toISOString();});
  await rerun.waitFor();assert(await rerun.isEnabled());
  assert.equal(await badge.count(),0);assert.equal(await page.locator('.nc-page-image').getAttribute('data-result-job'),'original');
  assert.equal(await page.getByRole('button',{name:'译图有问题',exact:true}).count(),0);
  const noTextId=await page.evaluate(()=>window.readerFixture.translationRequests.at(-1).id);
  await stableRails(initialRails);
  await page.screenshot({path:path.join(out,'no-text-explicit-retry.png')});
  assert.equal(await page.evaluate(()=>window.readerFixture.translationRequests.length),1);
  // The same-frame clicks also exercise the synchronous lock, before React rerenders.
  await page.evaluate(()=>window.readerFixture.delay=350);
  await rerun.evaluate(button=>{button.click();button.click();button.click();});
  assert(await rerun.isDisabled());assert.equal(await rerun.getAttribute('aria-busy'),'true');
  await page.waitForFunction(()=>window.readerFixture.submitted.length===2);
  await page.evaluate(()=>window.readerFixture.delay=0);
  await rerun.waitFor({state:'detached'});
  const requestsAfterRetry=await page.evaluate(()=>window.readerFixture.translationRequests);
  assert.equal(requestsAfterRetry.length,2);assert.notEqual(requestsAfterRetry[0].id,requestsAfterRetry[1].id);
  assert.deepEqual(requestsAfterRetry[1].body,{regenerate_of:noTextId});
  assert.equal(await rerun.count(),0);assert(Math.abs(await position()-before)<1);await stableRails(initialRails);
  checks.push('A no-text long image has an explicit right-rail rerun; rapid clicks create exactly one new regenerate_of UUID');

  await page.evaluate(()=>window.decodeTest.hold=true);await page.getByRole('button',{name:'模拟完成',exact:true}).click();
  await page.waitForFunction(()=>window.decodeTest.releases.length>0);await badge.filter({hasText:'正在解码译图'}).waitFor();
  assert.equal(await page.locator('.nc-page-image').getAttribute('data-result-job'),'original');
  assert.equal(await page.getByRole('button',{name:'译图有问题',exact:true}).count(),0);
  assert.equal(await rerun.count(),0);
  assert(Math.abs(await position()-before)<1);
  await page.screenshot({path:path.join(out,'decoding-status.png')});
  checks.push('Cached-but-decoding results retain the original and hide feedback and model rerun actions');

  await page.evaluate(()=>{window.decodeTest.hold=false;for(const release of window.decodeTest.releases.splice(0))release();});
  await page.locator('.nc-page-image:not([data-result-job="original"])').waitFor();await settle();
  assert.equal(await badge.count(),0);assert.equal(await page.locator('.nc-page-image').evaluate(image=>image.naturalHeight),20000);
  await page.getByRole('button',{name:'译图有问题',exact:true}).waitFor();
  assert(Math.abs(await position()-before)<1);assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),2);
  assert(await rerun.isEnabled());await stableRails(initialRails);
  await page.screenshot({path:path.join(out,'rails-with-feedback.png')});
  checks.push('Actual display confirmation clears the badge and enables result feedback without changing scroll position');

  await page.getByRole('button',{name:'原图',exact:true}).click();await page.locator('.nc-page-image[data-result-job="original"]').waitFor();
  await page.evaluate(()=>window.decodeTest.reject=true);await page.getByRole('button',{name:'翻译',exact:true}).click();
  const retry=badge.getByRole('button',{name:'加载失败 · 重试',exact:true});await retry.waitFor();
  assert.equal(await rerun.count(),0);
  assert.equal(await page.locator('.nc-page-image').getAttribute('data-result-job'),'original');
  const requests=await page.evaluate(()=>window.readerFixture.translationRequests.length);
  await retry.click();await page.locator('.nc-page-image:not([data-result-job="original"])').waitFor();await settle();
  assert.equal(await badge.count(),0);assert.equal(await page.evaluate(()=>window.readerFixture.translationRequests.length),requests);
  assert(Math.abs(await position()-before)<1);
  checks.push('Decode failure retains the original and its visible retry only reloads the existing translation');

  await stableRails(initialRails);
  await rerun.focus();await page.keyboard.press('Tab');
  assert(await page.getByRole('button',{name:'原图',exact:true}).evaluate(button=>button===document.activeElement));
  await page.keyboard.press('Tab');
  assert(await page.getByRole('button',{name:'翻译',exact:true}).evaluate(button=>button===document.activeElement));
  checks.push('Both rails retain core coordinates across real task transitions; keyboard order follows the vertical layout');

  await page.setViewportSize({width:1280,height:420});await settle();
  const smallRails=await page.locator('.nc-reader-rail').evaluateAll(rails=>rails.map(rail=>({scroll:rail.scrollHeight,client:rail.clientHeight,top:rail.getBoundingClientRect().top,bottom:rail.getBoundingClientRect().bottom})));
  assert(smallRails[0].scroll>smallRails[0].client);
  for(const rail of smallRails)assert(rail.top>=0&&rail.bottom<=420);
  for(const [selector,rect] of Object.entries(await railPositions())){assert.equal(rect.x,initialRails[selector].x);assert.equal(rect.width,initialRails[selector].width);}
  const edgeBars=await page.locator('.nc-reader-rail').evaluateAll(rails=>rails.filter(rail=>rail.scrollHeight>rail.clientHeight).map(rail=>({
    edge:document.querySelector(`.nc-scrollbar-y[aria-controls="${rail.id}"]`).getBoundingClientRect().left,
    content:rail.querySelector('button').getBoundingClientRect().right,
  })));
  for(const rail of edgeBars)assert(rail.edge>=rail.content,'A toolbar scrollbar covers the button label');
  await page.locator('[data-reader-feedback-trigger]').scrollIntoViewIfNeeded();
  const feedbackBounds=await page.locator('[data-reader-feedback-trigger]').boundingBox();assert(feedbackBounds.y>=0&&feedbackBounds.y+feedbackBounds.height<=420);
  await page.screenshot({path:path.join(out,'rails-short-window.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.nc-reader-rail').evaluateAll(rails=>rails.forEach(rail=>rail.scrollTop=0));await settle();
  const narrowRails=await page.locator('.nc-reader-rail').evaluateAll(rails=>rails.map(rail=>({left:rail.getBoundingClientRect().left,right:rail.getBoundingClientRect().right,scroll:rail.scrollWidth,client:rail.clientWidth})));
  for(const rail of narrowRails){assert(rail.left>=0&&rail.right<=390);assert(rail.scroll<=rail.client);}
  for(const rect of Object.values(await railPositions()))assert(rect.width>=28,'Scrollbar reservation squeezed a narrow tool');
  await page.screenshot({path:path.join(out,'rails-narrow-window.png')});
  checks.push('Short windows scroll the fixed slots and narrow windows keep both rails within their gutters');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,geometry,initialRails,smallRails,narrowRails,realBrowser:true,liveProvider:false,decodeDelaySimulated:true},null,2));
  console.log(JSON.stringify({checks,errors,geometry,out},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());throw error;}
finally{await browser.close();}
