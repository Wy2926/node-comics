import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const out=path.resolve('artifacts/website-pricing');
await mkdir(out,{recursive:true});
const locales=['','en/','zh-tw/','ja/','ko/'];
const month={id:'lite-month',plan_id:'lite',plan_revision_id:'lite-v1',name:'Lite',currency:'usd',unit_amount:599,interval:'month',monthly_redraw_pages:0,hourly_image_limit:1200,trial_days:7,trial_redraw_pages:0,channels:[{provider:'stripe',binding_id:'fixture',trial_days:7,trial_redraw_pages:0}]};
const year={...month,id:'lite-year',interval:'year',unit_amount:5999};
let offers=[month,year],status=200,release=null,onCatalogRequest=null;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/v1/billing/catalog',async route=>{
 onCatalogRequest?.();
 if(release)await release;
 await route.fulfill({status,json:{offers}});
});
const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});};
const noOverflow=async(target=page)=>assert(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
const comparison=async(target,hourlyPages)=>{
 const frame=target.locator('.pricing-comparison');
 assert.equal(await frame.count(),1,'one connected pricing comparison');
 assert.equal(await frame.locator('.pricing-grid .price-card').count(),2,'both pricing cards share the comparison frame');
 const table=frame.locator('table.plan-comparison');
 assert.equal(await table.locator('thead th').count(),3,'comparison has feature, ordinary and Lite columns');
 assert.equal(await table.locator('tbody tr').count(),6,'six feature comparison rows');
 for(const feature of ['reading','classic','rate','redraw','priority','early']){
  const row=table.locator(`tbody tr[data-feature="${feature}"]`);
  assert.equal(await row.count(),1,`comparison feature ${feature}`);
  assert.equal(await row.locator(':scope > th, :scope > td').count(),3,`aligned columns for ${feature}`);
 }
 assert((await table.locator('[data-feature="rate"] td').last().innerText()).replace(/\D/g,'').includes(String(hourlyPages)),'Lite hourly request limit follows the active catalog');
 assert(!/PLUS|\b300\b/.test(await frame.innerText()),'retired PLUS is absent from new-purchase pricing');
};
const live=async()=>{
 await page.locator('[data-billing-catalog="live"]').waitFor();
 assert.equal(await page.locator('.published-lite-pricing').count(),0,'live API offers replace published fallback');
};
const published=async(target,state)=>{
 await target.locator(`.billing-availability[data-state="${state}"]`).waitFor();
 const block=target.locator('.published-lite-pricing');
 assert(await block.isVisible(),'published Lite pricing is visible');
 const prices=block.locator('.published-price-grid .published-price');
 assert.equal(await prices.count(),2,'monthly and yearly prices remain visible together');
 for(const [index,expected] of ['US$5.99','US$59.99'].entries()){
  assert((await prices.nth(index).innerText()).replace(/\s/g,'').includes(expected),`published price ${expected}`);
 }
 await comparison(target,1200);
 assert(await target.locator('.billing-availability button').isDisabled(),'unavailable purchase action is disabled');
 assert.equal(await target.locator('a[href*="price="]').count(),0,'no synthetic checkout link');
 assert.equal(await target.locator('[data-billing-catalog="live"]').count(),0);
};
try {
 // Reviewers and crawlers must see both published prices without hydration or an API response.
 const staticContext=await browser.newContext({javaScriptEnabled:false,viewport:{width:1440,height:1100}});
 try {
  const staticPage=await staticContext.newPage();
  for(const locale of locales){
   await staticPage.goto(origin+'/'+locale+'pricing/');
   await published(staticPage,'loading');await noOverflow(staticPage);
  }
 }finally{await staticContext.close();}
 await page.goto(origin+'/pricing/');await live();
 assert.equal(await page.locator('.account-link').innerText(),'我的账户');
 assert.match(await page.locator('.billing-offer .price').innerText(),/5.99/);
 await page.locator('input[value="year"]').check({force:true});
 assert.match(await page.locator('.billing-total').innerText(),/59.99/);
 assert.match(await page.locator('.billing-offer .price').innerText(),/5.00/);
 assert.match(await page.locator('.annual-saving').innerText(),/11.89/);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=lite-year/);
 await noOverflow();await shot('desktop-year');
 await page.locator('.language-menu summary').click();await shot('desktop-language');
 await page.locator('.language-menu a[lang="en"]').click();await live();
 assert.match(page.url(),/\/en\/pricing\//);
 assert.equal(await page.locator('.account-link').innerText(),'My account');
 for(const locale of locales){
  await page.goto(origin+'/'+locale+'pricing/');await live();await comparison(page,1200);
  for(const width of [1440,1100,990,980,820,760,390,320]){
   await page.setViewportSize({width,height:1000});await noOverflow();
   const header=await page.locator('.header-tools').boundingBox();assert(header.x+header.width<=width,`header overflow ${locale} ${width}`);
  }
 }
 await page.setViewportSize({width:390,height:900});await page.goto(origin+'/pricing/');await live();await page.locator('input[value="year"]').check({force:true});await shot('mobile-year');
 await page.locator('.language-menu summary').click();await shot('mobile-language');await page.locator('.language-menu summary').click();
 await page.locator('.mobile-nav summary').click();assert(await page.locator('.mobile-nav a[href="/account/"]').isVisible());await page.locator('.mobile-nav summary').click();
 await page.setViewportSize({width:1440,height:1100});
 offers=[year];await page.reload();await live();assert(await page.locator('input[value="month"]').isDisabled());assert.equal(await page.locator('.annual-badge').count(),0);
 offers=[
  {...month,id:'lite-api-month',plan_revision_id:'lite-v2',unit_amount:699,hourly_image_limit:1500},
  {...year,id:'lite-api-year',plan_revision_id:'lite-v3',hourly_image_limit:1800},
 ];
 await page.reload();await live();
 assert.match(await page.locator('.billing-offer .price').innerText(),/6.99/);
 await comparison(page,1500);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=lite-api-month/);
 await page.locator('input[value="year"]').check({force:true});
 await comparison(page,1800);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=lite-api-year/);
 offers=[];
 for(const locale of locales){
  await page.goto(origin+'/'+locale+'pricing/');await published(page,'unavailable');
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:width===1440?1100:900});await noOverflow();
   if(!locale&&width!==320)await shot(width===1440?'desktop-unavailable':'mobile-unavailable');
  }
 }
 await page.setViewportSize({width:1440,height:1100});
 status=503;await page.goto(origin+'/pricing/');await published(page,'error');
 assert(await page.locator('[role="alert"]').isVisible());await shot('error');
 status=200;offers=[month,year];let done;
 release=new Promise(resolve=>done=resolve);
 const requested=new Promise(resolve=>onCatalogRequest=resolve);
 await page.reload({waitUntil:'domcontentloaded'});
 await requested;await published(page,'loading');await shot('loading');
 done();release=null;onCatalogRequest=null;await live();
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=lite-month/);
 assert.deepEqual(errors,[]);
 console.log('PASS: five locales with and without JavaScript, eight widths, connected six-feature comparison, Lite monthly/yearly prices and rolling hourly limits, loading/error/empty states, live API quota/price replacement, annual amounts/link, year-only and language/mobile navigation; screenshots: '+out);
}finally{await browser.close();}
