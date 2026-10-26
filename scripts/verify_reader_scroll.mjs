import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
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
const pageTop=(chapter,index)=>page.locator(`[data-copy-id="window-fixture-${chapter}"] [data-page-index="${index}"]`).evaluate(node=>node.getBoundingClientRect().top-node.closest('.nc-reading-viewport').getBoundingClientRect().top);
const input=page.getByLabel('阅读进度',{exact:true});
async function jump(number){
 await setReaderProgress(input, String(number));await settle();
 assert.equal(Number(await input.inputValue()),Number(number),'progress range retains the requested value');
 assert.equal(Number(await page.getByLabel('阅读进度',{exact:true}).inputValue()),Number(number),'progress range commits before scrolling');
}
async function refresh(){await page.getByRole('button',{name:/更新模拟翻译状态/}).click();await settle();}
async function openMore(){const more=page.getByRole('dialog',{name:'阅读设置',exact:true}).locator('details.nc-reader-more');if(await more.getAttribute('open')===null)await more.locator(':scope > summary').click();}
async function seek(chapter,selector,offset){
 const target=await page.evaluate(({chapter,selector,offset})=>{
  const v=document.querySelector('.nc-reading-viewport'),node=document.querySelector(`[data-copy-id="window-fixture-${chapter}"] ${selector}`);
  const top=node.getBoundingClientRect().top-v.getBoundingClientRect().top+v.scrollTop+offset;
  v.scrollTop=top;return v.scrollTop;
 },{chapter,selector,offset});
 await settle();return target;
}
try{
 await page.goto(origin+'/tests/reader-window-fixture.html');
 await page.locator('.nc-page-image').first().waitFor();await settle();
 await page.getByRole('button',{name:'翻译',exact:true}).click();await settle();
 await jump(120);
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
 await seek(1,'.nc-page-stack',150);await jump(120);
 await seek(2,'.nc-page-stack',-40);
 const headingTop=()=>page.locator('[data-copy-id="window-fixture-2"] .nc-page-stack').evaluate(node=>node.getBoundingClientRect().top-node.closest('.nc-reading-viewport').getBoundingClientRect().top);
 assert(Math.abs(await headingTop()-40)<1,'chapter eviction lost the heading offset');await refresh();
 assert(Math.abs(await headingTop()-40)<1);checks.push('three-chapter window eviction preserves visual position');
 // Wheel scrolling during repeated status updates must remain monotonic in both directions.
 for(const direction of [1,-1]){
  let previous=await position();
  for(let i=0;i<8;i++){
   // The fixture status button moves the pointer outside the reader after each click.
   await viewport.hover();
   await page.mouse.wheel(0,direction*12);
   await page.waitForFunction(({previous,direction})=>direction*(document.querySelector('.nc-reading-viewport').scrollTop-previous)>0,{previous,direction});
   await refresh();
   const current=await position();assert(direction*(current-previous)>0,'wheel motion stopped or reversed during status update');previous=current;
  }
 }
 checks.push('wheel scrolling stays monotonic through translation updates');
 await jump(8);await page.locator('.nc-image-failure').first().waitFor();
 const failed=await position();await refresh();assert(Math.abs(await position()-failed)<1);checks.push('image failure leaves the reading position stable');
 await jump(60);const previousSaved=await page.getByLabel('保存位置',{exact:true}).textContent();
 await seek(2,'.nc-page-stack',59*await page.locator('.nc-page-picture').first().evaluate(node=>node.getBoundingClientRect().height)+200);
 const saved=await position(),savedPageTop=await pageTop(2,59);
 await page.waitForFunction(previous=>document.querySelector('[aria-label="保存位置"]').textContent!==previous,previousSaved);
 await page.getByRole('button',{name:'关闭并保存位置',exact:true}).click();await page.getByRole('button',{name:'重开阅读器',exact:true}).click();await settle();
 assert(Math.abs(await position()-saved)<1,`reopened position changed from ${saved} to ${await position()}`);
 assert(Math.abs(await pageTop(2,59)-savedPageTop)<1,`reopened page top changed from ${savedPageTop} to ${await pageTop(2,59)}`);
 checks.push('in-page saved scroll and visual page position restore after reopening');
 await page.getByRole('button',{name:'阅读设置',exact:true}).click();
 await openMore();
 const anchorBefore=await input.inputValue();await page.getByRole('switch',{name:'并排对照',exact:true}).click();await settle();
 assert.equal(await input.inputValue(),anchorBefore);await page.getByRole('button',{name:'关闭面板',exact:true}).click();
 const comparisonPosition=await position();await jump('060');
 assert(Math.abs(await position()-comparisonPosition)<1,'committing the current page number changed its reading anchor');
 checks.push('same-page input preserves the in-page anchor');
 await jump(59);await jump(60);
 const top=await pageTop(2,59);
 assert(Math.abs(top)<1);checks.push('comparison layout and explicit page navigation still restore correctly');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveTranslation:false},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await browser.close();}
