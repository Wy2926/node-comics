import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const out=path.resolve('artifacts/website-pricing');
await mkdir(out,{recursive:true});
const locales=['','zh-tw/','en/','ja/','ko/','fr/','es/','pt-br/','de/','it/','ru/','pl/','uk/','tr/','vi/','id/','ar/'];
const quarter={id:'plus-quarter',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:666,interval:'quarter',monthly_classic_pages:2500,hourly_image_limit:1200,trial_days:0,trial_classic_pages:0,channels:[{provider:'stripe',binding_id:'fixture',trial_days:0,trial_classic_pages:0}]};
const year={...quarter,id:'plus-year',interval:'year',unit_amount:2399};
let offers=[quarter,year],status=200,release=null,onCatalogRequest=null;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/v1/billing/catalog',async route=>{
 onCatalogRequest?.();
 if(release)await release;
 await route.fulfill({status,json:{offers}});
});
const shot=async(name,preserveFocus=false)=>{if(!preserveFocus)await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});};
const noOverflow=async(target=page)=>assert(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow '+target.url()+' width='+target.viewportSize().width);
const comparison=async(target,hourlyPages)=>{
 const frame=target.locator('.pricing-comparison');
 assert.equal(await frame.count(),1);
 const cards=frame.locator('.subscription-card');
 assert.equal(await cards.count(),hourlyPages?2:3);
 for(const card of await cards.all()){
  assert.equal(await card.locator('.subscription-allowance').count(),1);
  assert.equal(await card.locator('.subscription-features li').count(),8);
  for(const feature of ['local','model','rate','priority','reading','feedback','requests','early']){
   const row=card.locator(`[data-feature="${feature}"]`);
   assert.equal(await row.count(),1);
   const trigger=row.locator('.feature-info-trigger'),tip=row.locator('[role="tooltip"]');
   const detailed=['local','rate','feedback','requests'].includes(feature);
   assert.equal(await trigger.count(),detailed?1:0);
   if(detailed){
    assert.equal(await trigger.getAttribute('aria-describedby'),await tip.getAttribute('id'));
    assert((await tip.textContent()).trim());
   }
  }
 }
 if(hourlyPages)assert((await cards.nth(1).locator('[data-feature="rate"]').innerText()).replace(/\D/g,'').includes(String(hourlyPages)));
 assert.match(await cards.nth(0).locator('[data-feature="local"]').innerText(),/MTU/);
 assert.match(await cards.nth(1).locator('[data-feature="local"]').innerText(),/MTU/);

};
const live=async()=>{
 await page.locator('[data-billing-catalog="live"]').waitFor();
 assert.equal(await page.locator('.published-plan-pricing').count(),0,'live API offers replace published fallback');
};
const published=async(target,state)=>{
 await target.locator(`.billing-availability[data-state="${state}"]`).first().waitFor();
 const block=target.locator('.published-plan-pricing');
 assert.equal(await block.count(),2,'PLUS and Pro prices are visible');
 const locale=await target.locator('html').getAttribute('lang');
 const interval=await block.first().getAttribute('data-billing-interval');
 const expected='US$'+new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(interval==='year'?23.99:6.66);
 assert.equal(await block.first().locator('.price-value').innerText(),expected,'actual charge for the selected cadence');
 await comparison(target,0);
 assert(await target.locator('.billing-availability button').first().isDisabled(),'unavailable purchase action is disabled');
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
 const info=page.locator('.subscription-card.paid [data-feature="local"] .feature-info-trigger'),tip=page.locator('.subscription-card.paid [data-feature="local"] [role="tooltip"]');
 await info.hover();assert(await tip.isVisible(),'hover opens feature detail');
 await page.keyboard.press('Escape');assert(!(await tip.isVisible()),'Escape dismisses feature detail');
 await info.focus();assert(await tip.isVisible(),'keyboard focus opens feature detail');
 await info.press('Tab');assert(!(await tip.isVisible()),'leaving focus dismisses feature detail');
 await info.click();assert(await tip.isVisible(),'click opens feature detail');
 await page.locator('h1').click();assert(!(await tip.isVisible()),'outside click dismisses feature detail');
 assert.equal(await page.locator('.account-link').getAttribute('aria-label'),'我的账户');
 assert.match(await page.locator('.billing-offer .price').innerText(),/6.66/);
 await page.locator('input[value="year"]').check({force:true});
 assert.match(await page.locator('.billing-total').innerText(),/23.99/);
 assert.match(await page.locator('.billing-offer .price').innerText(),/23.99/);
 assert.match(await page.locator('.monthly-equivalent').innerText(),/2.00/);
 assert.match(await page.locator('.annual-badge').innerText(),/9.9/);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=plus-year/);
 await noOverflow();await shot('desktop-year');
 await page.locator('.language-menu summary').click();await shot('desktop-language',true);
 await page.locator('.language-menu a[lang="en"]').click();await live();
 assert.match(page.url(),/\/en\/pricing\//);
 assert.equal(await page.locator('.account-link').getAttribute('aria-label'),'My account');
 for(const locale of locales){
  await page.goto(origin+'/'+locale+'pricing/');await live();await comparison(page,1200);
  for(const width of [1440,1100,990,980,820,760,390,320]){
   await page.setViewportSize({width,height:1000});await noOverflow();
   for(const control of await page.locator('.language-menu summary,.github-link,.mobile-nav summary,.header-actions a').all()) {
    if(await control.isVisible()){const box=await control.boundingBox();assert(box.x>=0&&box.x+box.width<=width,`header overflow ${locale} ${width}`);}
   }
  }
 }
 await page.setViewportSize({width:390,height:900});await page.goto(origin+'/pricing/');await live();await page.locator('input[value="year"]').check({force:true});await shot('mobile-year');
 await page.locator('.language-menu summary').click();await shot('mobile-language');await page.locator('.language-menu summary').click();
 await page.locator('.mobile-nav summary').click();assert(await page.locator('.mobile-nav a[href="/account/"]').isVisible());await page.locator('.mobile-nav summary').click();
 await page.setViewportSize({width:1440,height:1100});
 offers=[year];await page.reload();await published(page,'unavailable');
 assert(await page.locator('input[value="quarter"]').isChecked(),'missing quarterly quote does not switch cadence automatically');
 assert(!(await page.locator('input[value="quarter"]').isDisabled()),'published quarterly preview remains available');
 await page.locator('input[value="year"]').check({force:true});await live();assert.equal(await page.locator('.annual-badge').count(),0);
 offers=[
  {...quarter,id:'plus-api-quarter',plan_revision_id:'plus-v2',unit_amount:699,hourly_image_limit:1500},
  {...year,id:'plus-api-year',plan_revision_id:'plus-v3',hourly_image_limit:1800},
 ];
 await page.reload();await live();
 assert.match(await page.locator('.billing-offer .price').innerText(),/6.99/);
 await comparison(page,1500);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=plus-api-quarter/);
 await page.locator('input[value="year"]').check({force:true});
 await comparison(page,1800);
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=plus-api-year/);
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
 assert(await page.locator('[role="alert"]').first().isVisible());await shot('error');
 status=200;offers=[quarter,year];let done;
 release=new Promise(resolve=>done=resolve);
 const requested=new Promise(resolve=>onCatalogRequest=resolve);
 await page.reload({waitUntil:'domcontentloaded'});
 await requested;await published(page,'loading');await shot('loading');
 done();release=null;onCatalogRequest=null;await live();
 assert.match(await page.locator('a[data-purchase-link]').getAttribute('href'),/price=plus-quarter/);
 assert.deepEqual(errors,[]);
 console.log('PASS: seventeen locales with and without JavaScript, eight widths, subscription cards with explicit monthly allowances with accessible feature tips, PLUS quarterly/yearly prices and rolling hourly limits, loading/error/empty states, live API quota/price replacement, annual amounts/link, year-only and language/mobile navigation; screenshots: '+out);
}finally{await browser.close();}
