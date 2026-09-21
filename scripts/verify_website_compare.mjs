import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const out='artifacts/website-compare';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const ready=()=>page.locator('.compare-art[aria-busy="false"] img').waitFor({state:'visible'});
try{
 await page.goto(origin);await page.locator('.compare').scrollIntoViewIfNeeded();await ready();
 const top=await page.evaluate(()=>scrollY);
 let release;const gate=new Promise(resolve=>release=resolve);
 await page.route('**/journey-en*.webp',async route=>{await gate;await route.continue();});
 await page.locator('.compare button').nth(2).click();
 await page.locator('.compare-spinner').waitFor();
 await page.locator('.compare').screenshot({path:out+'/loading.png'});
 assert.equal(await page.locator('.compare-art').getAttribute('aria-busy'),'true');
 release();await ready();assert.match(await page.locator('.compare-art img').getAttribute('src'),/journey-en/);
 assert(Math.abs(await page.evaluate(()=>scrollY)-top)<2,'position changed');
 await page.unroute('**/journey-en*.webp');
 await page.route('**/journey-ko*.webp',route=>route.abort());
 await page.locator('.compare button').nth(3).click();await page.locator('.compare [role="alert"]').waitFor();
 await page.locator('.compare').screenshot({path:out+'/error.png'});
 await page.unroute('**/journey-ko*.webp');await page.locator('.compare-feedback button').click();await ready();
 await page.locator('.compare button').nth(0).click();await page.locator('.compare button').nth(2).click();await page.locator('.compare button').nth(1).click();await ready();
 assert.match(await page.locator('.compare-art img').getAttribute('src'),/journey-translated/);
 await page.locator('.compare').screenshot({path:out+'/desktop.png'});
 for(const locale of ['','en/','zh-tw/','ja/','ko/']){
  await page.goto(origin+'/'+locale);await page.locator('.compare').scrollIntoViewIfNeeded();await ready();
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1000});
   const panel=await page.locator('.compare').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=width,'compare overflow '+locale+width);
   const box=await page.locator('.compare-art').boundingBox();assert(Math.abs(box.height/box.width-1.5)<.02,'cropped illustration');
  }
  for(let i=0;i<4;i++){await page.locator('.compare button').nth(i).click();await ready();}
 }
 await page.locator('.compare').screenshot({path:out+'/mobile.png'});
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.deepEqual(errors,[]);console.log('PASS: five locales, four images, desktop/mobile, loading, failure/retry, rapid switching, stable scroll; '+out);
}finally{await browser.close();}
