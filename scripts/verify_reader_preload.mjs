// Vite :5181, real 4000 x 6000 synthetic PNGs. No account, supplier, or external image requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',out=path.resolve('artifacts/reader-preload');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[],samples=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
await page.addInitScript(()=>{
 const live=new Map(),reads=[],decodes=[],decodeFailures=[],keys=new WeakMap();let created=0,peakUrls=0,activeDecodes=0,peakDecodes=0;
 const get=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.get=function(key){
  const request=get.call(this,key);
  if(this.name==='objects'&&typeof key==='string'&&key.startsWith('inline-original:window-fixture-high-'))request.addEventListener('success',()=>{if(request.result instanceof Blob){keys.set(request.result,key);reads.push({key,time:performance.now(),bytes:request.result.size});}});
  return request;
 };
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
 URL.createObjectURL=function(blob){const url=create.call(this,blob);live.set(url,{key:keys.get(blob),bytes:blob.size});created++;peakUrls=Math.max(peakUrls,live.size);return url;};
 URL.revokeObjectURL=function(url){live.delete(url);return revoke.call(this,url);};
 const decode=HTMLImageElement.prototype.decode;
 HTMLImageElement.prototype.decode=async function(){
  const start=performance.now(),key=live.get(this.src)?.key;activeDecodes++;peakDecodes=Math.max(peakDecodes,activeDecodes);
  try{await decode.call(this);decodes.push({key,milliseconds:performance.now()-start,width:this.naturalWidth,height:this.naturalHeight,cancelled:!live.has(this.src)});}
  catch(error){decodeFailures.push({key,name:error.name,width:this.naturalWidth,height:this.naturalHeight,cancelled:!live.has(this.src)});throw error;}
  finally{activeDecodes--;}
 };
 window.readerPreloadMetrics=()=>({liveUrls:live.size,peakUrls,created,liveKeys:[...live.values()].map(value=>value.key),reads,decodes,decodeFailures,activeDecodes,peakDecodes});
});
const viewport=page.locator('.nc-reading-viewport');
const input=page.getByLabel('跳转页码',{exact:true});
const cell=index=>page.locator(`[data-copy-id="window-fixture-0"] [data-page-index="${index}"]`);
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const position=()=>viewport.evaluate(node=>node.scrollTop);
async function decoded(indices,panes=1){
 await page.waitForFunction(({indices,panes})=>indices.every(index=>{
  const images=document.querySelectorAll(`[data-copy-id="window-fixture-0"] [data-page-index="${index}"] .nc-page-image`);
  return images.length===panes&&[...images].every(image=>image.complete&&image.naturalWidth===4000&&image.naturalHeight===6000);
 }),{indices,panes});
 await settle();
}
async function sample(label,panes=1){
 // Wait for old windows and replacement URLs to be released before measuring retention.
 await page.waitForFunction(()=>window.readerPreloadMetrics().activeDecodes===0);
 await settle();
 const value=await page.evaluate(label=>{
  const v=document.querySelector('.nc-reading-viewport'),m=window.readerPreloadMetrics();
  const images=[...document.querySelectorAll('.nc-reading-viewport .nc-page-image')];
  return {label,currentPage:Number(document.querySelector('[aria-label="跳转页码"]').value),selectedPages:Number(v.dataset.decodedPages),mountedPages:v.querySelectorAll('.nc-manga-page').length,displayedImages:images.length,liveUrls:m.liveUrls,distinctReadKeys:new Set(m.reads.map(item=>item.key)).size,heldEncodedBytes:m.liveKeys.reduce((total,key)=>total+(m.reads.find(item=>item.key===key)?.bytes??0),0),estimatedDisplayedRgbaBytes:images.reduce((total,image)=>total+image.naturalWidth*image.naturalHeight*4,0)};
 },label);
 assert(value.mountedPages<=11,`${label}: page DOM exceeded its window`);
 assert(value.selectedPages<=11,`${label}: selected pages exceeded the decoded window`);
 assert(value.liveUrls<=value.selectedPages*panes,`${label}: retained Blob URLs outgrew the selected image window`);
 samples.push(value);return value;
}
async function settings(action){await page.getByRole('button',{name:'阅读设置',exact:true}).click();await action();await page.getByRole('button',{name:'关闭面板',exact:true}).click();await settle();}
try{
 const start=performance.now();await page.goto(origin+'/tests/reader-window-fixture.html?highres=1');
 await decoded([0,1]);
 const initial=await sample('initial');
 assert.equal(initial.currentPage,1);assert.equal(initial.selectedPages,11);assert.equal(initial.distinctReadKeys,10);
 const firstReadyMilliseconds=performance.now()-start;
 checks.push('Actual 4000 x 6000 PNGs preload the eleven-page window without excluding high-resolution neighbors');
 await input.fill('4');await decoded([2,3,4]);
 const middle=await sample('middle');assert.equal(middle.selectedPages,11);
 checks.push('Navigating into the chapter preloads both previous and next high-resolution pages');
 const middleTop=await position();
 await page.getByRole('button',{name:/更新模拟翻译状态/}).click();await settle();assert(Math.abs(await position()-middleTop)<1);
 checks.push('A translation failure/status commit keeps the original images and reading position stable');
 await settings(async()=>{for(let i=0;i<6;i++)await page.getByRole('button',{name:'缩小',exact:true}).click();});
 await decoded([2,3,4,5]);
 assert.equal(await input.inputValue(),'4');
 assert(await cell(5).evaluate(node=>{const a=node.getBoundingClientRect(),v=node.closest('.nc-reading-viewport').getBoundingClientRect();return a.bottom>v.top&&a.top<v.bottom;}));
 const visible=await sample('zoom40-visible-extra');assert.equal(visible.selectedPages,11);
 await viewport.evaluate(node=>{node.scrollTop+=20;node.dispatchEvent(new Event('scroll',{bubbles:true}));});await settle();
 await decoded([2,3,4,5]);assert.equal(await input.inputValue(),'4');await sample('scroll-visible-extra');
 await page.screenshot({path:path.join(out,'visible-neighbor.png')});
 checks.push('At 40% zoom a further visible page loads before and during scrolling while page 4 remains current');
 await settings(async()=>{for(let i=0;i<6;i++)await page.getByRole('button',{name:'放大',exact:true}).click();});
 await decoded([2,3,4]);
 await page.waitForFunction(()=>document.querySelector('.nc-reading-viewport').dataset.decodedPages==='11');
 await page.getByRole('button',{name:'完成模拟翻译',exact:true}).click();
 await page.getByRole('button',{name:'翻译',exact:true}).click();
 await settings(()=>page.getByRole('switch',{name:'并排对照',exact:true}).click());
 await decoded([2,3,4],2);
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-page-index="3"] .nc-page-image')].some(image=>image.dataset.resultJob!=='original'));
 const compared=await sample('comparison',2);assert.equal(compared.liveUrls,20);
 await page.screenshot({path:path.join(out,'comparison.png')});
 checks.push('Comparison retains full-resolution originals and translations within eleven pages; the bad page stays isolated');
 await settings(async()=>{await page.getByRole('switch',{name:'并排对照',exact:true}).click();await page.getByRole('button',{name:'单页阅读',exact:true}).click();});
 await decoded([3]);
 await page.waitForFunction(()=>document.querySelectorAll('.nc-reading-viewport .nc-manga-page').length===1&&window.readerPreloadMetrics().liveUrls===1);
 const single=await sample('single');assert.equal(single.selectedPages,1);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await decoded([4]);await sample('single-next');
 await page.getByRole('button',{name:'上一页',exact:true}).click();await decoded([3]);await sample('single-previous');
 checks.push('Single-page mode loads one image and supports forward/back navigation');
 await settings(()=>page.getByRole('button',{name:'连续阅读',exact:true}).click());
 await input.fill('8');await cell(7).locator('.nc-image-failure').waitFor();await decoded([6,8]);
 const failedTop=await position();await page.getByRole('button',{name:/更新模拟翻译状态/}).click();await settle();assert(Math.abs(await position()-failedTop)<1);
 await cell(7).getByRole('button',{name:'重试',exact:true}).click();await cell(7).locator('.nc-image-failure').waitFor();await sample('failed-page');
 await page.screenshot({path:path.join(out,'failed-page.png')});
 checks.push('A failed original and retry do not prevent surrounding high-resolution pages from loading');
 await input.fill('12');await decoded([10,11,12]);
 await viewport.evaluate(node=>{node.scrollTop+=180;node.dispatchEvent(new Event('scroll',{bubbles:true}));});
 await settle();await page.waitForTimeout(400);const saved=await position(),savedPage=await input.inputValue();
 await page.getByRole('button',{name:'关闭并保存位置',exact:true}).click();
 await page.waitForFunction(()=>window.readerPreloadMetrics().liveUrls===0);checks.push('Closing the reader releases all Blob URLs');
 await page.getByRole('button',{name:'重开阅读器',exact:true}).click();await decoded([10,11,12]);
 assert.equal(await input.inputValue(),savedPage);assert(Math.abs(await position()-saved)<1);await sample('reopened');
 checks.push('Reopening restores the same in-page position with a bounded eleven-page image window');
 for(const number of [18,3,21,5,15]){await input.fill(String(number));await decoded([number-2,number-1,number]);await sample(`jump-${number}`);}
 checks.push('Repeated far jumps release old images while keeping the DOM and held URLs bounded');
 await page.screenshot({path:path.join(out,'reopened.png')});
 const metrics=await page.evaluate(()=>window.readerPreloadMetrics());
 // Cancelled preloads clear their src immediately; a late native decode resolution can then have zero dimensions.
 const completedDecodes=metrics.decodes.filter(item=>!item.cancelled);
 assert(completedDecodes.every(item=>item.width===4000&&item.height===6000));
 assert(metrics.peakUrls<=44,`Transient Blob URL peak grew beyond two comparison windows: ${metrics.peakUrls}`);
 assert.deepEqual(errors,[]);
 const timings=completedDecodes.map(item=>item.milliseconds).sort((a,b)=>a-b),percentile=q=>timings[Math.min(timings.length-1,Math.floor((timings.length-1)*q))];
 const decodeFallbacks=metrics.decodeFailures.filter(item=>!item.cancelled&&item.name==='EncodingError');
 if(decodeFallbacks.length)checks.push('Valid originals and translations remain readable after native predecode EncodingError');
 const report={checks,errors,synthetic:true,livePixiv:false,liveTranslation:false,resolution:{width:4000,height:6000},firstReadyMilliseconds,samples,metrics:{createdUrls:metrics.created,peakUrls:metrics.peakUrls,peakConcurrentDecodes:metrics.peakDecodes,decodeCount:timings.length,decodeFallbackCount:decodeFallbacks.length,cancelledDecodes:metrics.decodes.length-completedDecodes.length+metrics.decodeFailures.filter(item=>item.cancelled).length,decodeMilliseconds:{median:percentile(.5),p95:percentile(.95),max:timings.at(-1)},cacheReadsByKey:Object.fromEntries([...new Set(metrics.reads.map(item=>item.key))].map(key=>[key,metrics.reads.filter(item=>item.key===key).length]))},memoryEstimate:'Displayed original and result PNG dimensions times 4 bytes per pixel; browser process memory is not measured by this script.'};
 await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,checks,errors,firstReadyMilliseconds,metrics:report.metrics}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await browser.close();}
