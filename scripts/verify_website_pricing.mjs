import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const out=path.resolve('artifacts/website-pricing');await mkdir(out,{recursive:true});
const month={id:'plus-month',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:999,interval:'month',monthly_redraw_pages:300,trial_days:7,trial_redraw_pages:30,channels:[{provider:'stripe',binding_id:'fixture',trial_days:7,trial_redraw_pages:30}]};
const year={...month,id:'plus-year',interval:'year',unit_amount:9999};
let offers=[month,year],status=200,release=null;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/v1/billing/catalog',async route=>{if(release)await release;await route.fulfill({status,json:{offers}});});
const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});};
const noOverflow=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
try {
 await page.goto(origin+'/pricing/');await page.locator('.membership-rights').waitFor();
 assert.equal(await page.locator('.account-link').innerText(),'我的账户');
 assert.match(await page.locator('.billing-offer .price').innerText(),/9.99/);
 await page.locator('input[value="year"]').check({force:true});
 assert.match(await page.locator('.billing-total').innerText(),/99.99/);
 assert.match(await page.locator('.billing-offer .price').innerText(),/8.33/);
 assert.match(await page.locator('.annual-saving').innerText(),/19.89/);
 assert.match(await page.locator('.billing-offer .button').getAttribute('href'),/price=plus-year/);
 await noOverflow();await shot('desktop-year');
 await page.locator('.language-menu summary').click();await shot('desktop-language');
 await page.locator('.language-menu a[lang="en"]').click();await page.locator('.membership-rights').waitFor();
 assert.match(page.url(),/\/en\/pricing\//);
 assert.equal(await page.locator('.account-link').innerText(),'My account');
 for(const locale of ['','en/','zh-tw/','ja/','ko/']){
  await page.goto(origin+'/'+locale+'pricing/');await page.locator('.membership-rights').waitFor();
  for(const width of [1440,1100,990,980,820,760,390,320]){
   await page.setViewportSize({width,height:1000});await noOverflow();
   const header=await page.locator('.header-tools').boundingBox();assert(header.x+header.width<=width,`header overflow ${locale} ${width}`);
  }
 }
 await page.setViewportSize({width:390,height:900});await page.goto(origin+'/pricing/');await page.locator('.membership-rights').waitFor();await page.locator('input[value="year"]').check({force:true});await shot('mobile-year');
 await page.locator('.language-menu summary').click();await shot('mobile-language');await page.locator('.language-menu summary').click();
 await page.locator('.mobile-nav summary').click();assert(await page.locator('.mobile-nav a[href="/account/"]').isVisible());await page.locator('.mobile-nav summary').click();
 await page.setViewportSize({width:1440,height:1100});
 offers=[year];await page.reload();await page.locator('.membership-rights').waitFor();assert(await page.locator('input[value="month"]').isDisabled());assert.equal(await page.locator('.annual-badge').count(),0);
 offers=[];await page.reload();await page.getByText('订阅暂未开放',{exact:true}).waitFor();
 status=503;await page.reload();await page.locator('[role="alert"]').waitFor();await shot('error');
 status=200;offers=[month,year];let done;release=new Promise(resolve=>done=resolve);await page.reload();await page.getByText('正在读取套餐…',{exact:true}).waitFor();done();release=null;await page.locator('.membership-rights').waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: five locales, eight widths, annual amounts/link, language navigation, mobile navigation, loading/error/empty/year-only states; screenshots: '+out);
}finally{await browser.close();}
