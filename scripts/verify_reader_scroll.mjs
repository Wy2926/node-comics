// Vite :5181, synthetic chapter/window fixture. No account or translation service.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',out=path.resolve('artifacts/reader-scroll');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const viewport=page.locator('.nc-reading-viewport');
const position=()=>viewport.evaluate(node=>node.scrollTop);
async function refresh(){await page.getByRole('button',{name:/更新模拟翻译状态/}).click();await settle();}
async function seek(chapter,selector,offset){
 const target=await page.evaluate(({chapter,selector,offset})=>{
  const v=document.querySelector('.nc-reading-viewport'),node=document.querySelector(`[data-copy-id="window-fixture-${chapter}"] ${selector}`);
  const top=node.getBoundingClientRect().top-v.getBoundingClientRect().top+v.scrollTop+offset;
  v.scrollTop=top;v.dispatchEvent(new Event('scroll',{bubbles:true}));return v.scrollTop;
 },{chapter,selector,offset});
 await settle();return target;
}
try{
 await page.goto(origin+'/tests/reader-window-fixture.html');
 await page.locator('.nc-page-image').first().waitFor();await settle();
 await page.getByRole('button',{name:'常规翻译',exact:true}).click();await settle();
 const input=page.getByLabel('跳转页码',{exact:true});
 await input.fill('120');await settle();
 const pending=await page.evaluate(()=>{
  const v=document.querySelector('.nc-reading-viewport');v.scrollTop+=12;const expected=v.scrollTop;
  // Deliver a React status commit before the browser dispatches its queued scroll event.
  [...document.querySelectorAll('button')].find(node=>node.textContent.startsWith('更新模拟翻译状态')).click();
  return {expected,actual:v.scrollTop};
 });
 assert.equal(pending.actual,pending.expected);await settle();checks.push('status commit does not overwrite a pending native scroll');
 for(const [selector,offset,label] of [
  ['.nc-reader-end',65,'chapter end gap'],
  ['.nc-reader-end',130,'lower chapter end gap'],
 ]){
  const target=await seek(0,selector,offset);await refresh();
  assert(Math.abs(await position()-target)<1,`${label}: jumped from ${target} to ${await position()}`);
  checks.push(`${label} survives translation status/failure updates`);
 }
 // The look-ahead reading line selects the next page before the viewport reaches it.
 await seek(1,'.nc-page-stack',-40);const before=await position();await refresh();
 assert(Math.abs(await position()-before)<1,'next-chapter heading snapped to page top');
 assert.equal(await input.inputValue(),'1');checks.push('next chapter activates without snapping past its heading');
 await seek(1,'.nc-page-stack',150);await settle();
 await seek(0,'.nc-reader-end',70);const backward=await position();await refresh();
 assert(Math.abs(await position()-backward)<1,'backward crossing snapped to the previous page edge');
 checks.push('backward chapter crossing retains the gap offset');
 await page.getByRole('button',{name:'完成模拟翻译',exact:true}).click();
 await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').first().waitFor();await settle();
 assert(Math.abs(await position()-backward)<1);checks.push('decoded translation replaces the original without moving the chapter gap');
 await page.screenshot({path:path.join(out,'chapter-gap.png')});
 // Crossing chapter 2 -> 3 evicts chapter 1; compare visual position, not absolute scrollTop.
 await seek(1,'.nc-page-stack',150);await input.fill('120');await settle();
 await seek(2,'.nc-page-stack',-40);
 const headingTop=()=>page.locator('[data-copy-id="window-fixture-2"] .nc-page-stack').evaluate(node=>node.getBoundingClientRect().top-node.closest('.nc-reading-viewport').getBoundingClientRect().top);
 assert(Math.abs(await headingTop()-40)<1,'chapter eviction lost the heading offset');await refresh();
 assert(Math.abs(await headingTop()-40)<1);checks.push('three-chapter window eviction preserves visual position');
 // Wheel scrolling during repeated status updates must remain monotonic in both directions.
 await viewport.hover();
 for(const direction of [1,-1]){
  let previous=await position();
  for(let i=0;i<8;i++){
   await page.mouse.wheel(0,direction*12);await page.waitForTimeout(40);await refresh();
   const current=await position();assert(direction*(current-previous)>=-1,'wheel motion reversed during status update');previous=current;
  }
 }
 checks.push('wheel scrolling stays monotonic through translation updates');
 await input.fill('8');await settle();await page.locator('.nc-image-failure').first().waitFor();
 const failed=await position();await refresh();assert(Math.abs(await position()-failed)<1);checks.push('image failure leaves the reading position stable');
 await input.fill('60');await settle();await seek(2,'.nc-page-stack',59*await page.locator('.nc-page-picture').first().evaluate(node=>node.getBoundingClientRect().height)+200);
 const saved=await position();await page.waitForTimeout(400);
 await page.getByRole('button',{name:'关闭并保存位置',exact:true}).click();await page.getByRole('button',{name:'重开阅读器',exact:true}).click();await settle();
 assert(Math.abs(await position()-saved)<1);checks.push('in-page saved position restores after reopening');
 await page.getByRole('button',{name:'阅读设置',exact:true}).click();
 const anchorBefore=await input.inputValue();await page.getByRole('switch',{name:'并排对照',exact:true}).click();await settle();
 assert.equal(await input.inputValue(),anchorBefore);await page.getByRole('button',{name:'关闭面板',exact:true}).click();
 await input.fill('060');await settle();
 const top=await page.locator('[data-copy-id="window-fixture-2"] [data-page-index="59"]').evaluate(node=>node.getBoundingClientRect().top-node.closest('.nc-reading-viewport').getBoundingClientRect().top);
 assert(Math.abs(top)<1);checks.push('comparison layout and explicit same-page navigation still restore correctly');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveTranslation:false},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await browser.close();}
