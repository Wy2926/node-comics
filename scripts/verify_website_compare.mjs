import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const out='artifacts/website-compare';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
// Model a supported desktop browser; the headless test runner itself is not an install target.
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort());
const locales=['','zh-tw/','en/','ja/','ko/','fr/','es/','pt-br/','de/','it/','ru/','pl/','uk/','tr/','vi/','id/','ar/'];
async function fits(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow: '+page.url());}
try {
  for(const locale of locales){
    await page.goto(`${origin}/${locale}`);
    const screenshot=page.locator('.home-screenshot img');
    await screenshot.waitFor();
    await screenshot.evaluate(image=>image.decode());
    assert.equal(await page.locator('main input[type=file], main astro-island').count(),0);
    assert.equal(await page.locator('.home-screenshot img').count(),1);
    assert.equal(await page.locator('.hero-store').count(),3);
    assert.equal(await page.locator('.home-faq, .home-cta').count(),0);
    assert.equal(await page.locator('.home-hero .button').count(),1);
    assert.match(await page.locator('.home-hero a[data-install-extension]').getAttribute('href'),/^https:\/\/chromewebstore\.google\.com\//);
    assert.equal(await page.locator('.home-plan').count(),2);
    await page.locator('.home-cycle input[value=year]').check();
    assert.equal(await page.locator('.home-plan-lite .home-price:visible').getAttribute('data-home-price'),'year');
    await page.locator('.home-cycle input[value=month]').check();
    assert.equal(await page.locator('.home-plan-lite .home-price:visible').getAttribute('data-home-price'),'month');
    assert.equal(await page.locator('#see-it').count(),1);
    assert.equal(await page.locator('#translation').count(),1);
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await fits();}
  }
  await page.screenshot({path:out+'/homepage-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/en/');
  await page.screenshot({path:out+'/homepage-desktop.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: 17 static extension homepages, real comparison image, anchors, billing preview toggles, desktop/mobile layout.');
} finally {await browser.close();}
