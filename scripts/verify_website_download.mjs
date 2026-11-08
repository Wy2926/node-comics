import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const catalog=JSON.parse(await readFile('backend/extension-release.json','utf8'));
const releases=catalog.releases.filter(item=>item.version===(catalog.current_by_browser?.[item.browser]??catalog.current));
assert.deepEqual(releases.map(item=>item.browser).sort(),['chrome','edge','firefox']);
const output='artifacts/extension-download';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});
// A remembered choice suppresses unrelated language suggestions during visual checks.
await page.context().addCookies([{name:'nc-site-locale',value:'zh-CN',url:origin}]);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let manifestRequests=0;page.on('request',request=>{if(request.url()===manifestUrl)manifestRequests++;});
const manifestUrl='https://comics-updates.nodelane.net/stable/index.json';
const manifest=await (await fetch(manifestUrl)).json();
const architectures=['arm64-v8a','armeabi-v7a','x86_64'];
const appPackages=architectures.map(arch=>manifest.updates.filter(item=>item.platform==='android'&&item.arch===arch).sort((a,b)=>b.build-a.build)[0]);
async function checkApp(target=page){
 const primary=target.locator('[data-app-download][data-app-arch="arm64-v8a"]');
 await primary.waitFor({state:'visible',timeout:15000});
 assert.equal(await primary.getAttribute('href'),appPackages[0].url);
 assert.equal(await primary.locator('[data-app-version]').innerText(),`v${appPackages[0].version}`);
 assert.equal(await target.locator('[data-app-release] select').count(),0);
 const alternatives=target.locator('.app-alternatives');
 if(await alternatives.count()){
  assert.equal(await alternatives.getAttribute('open'),null);
  assert.equal(await alternatives.locator('[data-app-download]').first().isVisible(),false);
  await alternatives.locator('summary').click();
  for(const item of appPackages.slice(1)){
   const link=alternatives.locator(`[data-app-download][data-app-arch="${item.arch}"]`);
   assert.equal(await link.isVisible(),true);
   assert.equal(await link.getAttribute('href'),item.url);
   assert.equal(await link.locator('[data-app-version]').innerText(),`v${item.version}`);
  }
  await alternatives.locator('summary').click();
 }else assert.equal(await target.locator('[data-app-download]').count(),1);
}
async function screenshotOptions(name){
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
 const clip=await page.locator('.download-options').boundingBox();
 await page.screenshot({path:output+'/'+name+'.png',fullPage:true,clip});
}
async function noOverflow(target=page){assert(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow: ${target.url()}`);}

try{
 await page.goto(origin+'/');
 await checkApp();
 assert.equal(manifestRequests,1,'Default download needs only one manifest request');
 await page.screenshot({path:output+'/home-desktop.png'});
 await screenshotOptions('download-options');
 // Verify direct navigation to the exact public APK URL without transferring a large installer.
 const apk=appPackages[0].url;
 await page.route(apk,route=>route.abort());
 const navigation=page.waitForRequest(request=>request.url()===apk&&request.isNavigationRequest());
 await page.locator('[data-app-download]').click();
 await navigation;
 await page.unroute(apk);
 for(const locale of ['','zh-tw/','en/','ja/','ko/','fr/','es/','pt-br/','de/','it/','ru/','pl/','uk/','tr/','vi/','id/','ar/']){
  await page.goto(origin+'/'+locale+'download/');
  await checkApp();
  await noOverflow();
  assert.equal(await page.locator('.store-card[data-app]').count(),2);
  assert.equal(await page.locator('[data-app="ios"] [data-app-download]').count(),0);
  for(const release of releases){
   const card=page.locator(`[data-browser="${release.browser}"]`),link=card.locator('.package-download');
   if(!release.download_url){
    assert.equal(await link.count(),0);
    assert.equal(await card.locator('.package-download-unavailable').getAttribute('aria-disabled'),'true');
    continue;
   }
   assert.equal(await link.getAttribute('href'),release.download_url);
   assert.equal(await link.getAttribute('download'),release.filename);
   assert.ok((await card.innerText()).includes('v'+release.version));
   const format=release.filename.split('.').at(-1).toUpperCase();
   assert.ok((await link.innerText()).includes(format));
   assert.ok((await link.getAttribute('aria-label')).includes(format));
   assert.ok((await card.locator('.package-meta').innerText()).includes(format));
   const storeBox=await card.locator('.store-link').boundingBox(),downloadBox=await link.boundingBox();
   assert(downloadBox.y>=storeBox.y+storeBox.height,'Package download must appear below its own store button');
  }
  assert.equal(await page.locator('[data-browser="firefox"] .store-link').getAttribute('href'),'https://addons.mozilla.org/firefox/addon/nodelane-comics/');
  assert.equal(await page.locator('[data-browser="firefox"] .package-download').count(),Number(!!releases.find(r=>r.browser==='firefox').download_url));
  assert.equal(await page.locator('.package-download').count(),releases.filter(r=>r.download_url).length);
  assert.equal(await page.locator('.direct-download').count(),0);
  assert.equal(await page.locator('.install-steps li').count(),3);
  const logos=page.locator('.store-card img.store-icon');
  assert.equal(await logos.count(),3);
  for(const logo of await logos.all()){
   await logo.scrollIntoViewIfNeeded();
   await logo.evaluate(async image=>{await image.decode();if(!image.naturalWidth)throw Error('Browser logo failed');});
  }
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:output+'/'+(origin.includes('127.0.0.1')?'local':'live')+'-'+(locale.replace('/','')||'zh-CN')+'.png',fullPage:true});
  if(!locale) await page.screenshot({path:output+'/download-app-cards.png',fullPage:true,clip:await page.locator('.app-download-cards').boundingBox()});
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});
   await noOverflow();
  }
  if(['','en/','ar/'].includes(locale)) await page.screenshot({path:output+'/'+(locale.replace('/','')||'zh-CN')+'-download-cards-mobile.png',fullPage:true,clip:await page.locator('.app-download-cards').boundingBox()});
  await page.setViewportSize({width:1440,height:1100});
 }
 if(!origin.includes('127.0.0.1')){
  await page.goto(origin+'/download/');
  for(const release of releases.filter(r=>r.download_url)){
   const promise=page.waitForEvent('download');await page.locator(`[data-browser="${release.browser}"] .package-download`).click();
   const download=await promise;assert.equal(download.suggestedFilename(),release.filename);
   const path=output+'/'+release.filename;await download.saveAs(path);
   const bytes=await readFile(path);
   assert.equal(bytes.length,release.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.sha256);
   console.log(`PASS ${release.browser} real browser download, filename, byte size and SHA-256`);
  }
 }
 // App tutorial and status routes use the same translated controls on narrow screens.
 for(const locale of ['','zh-tw/','en/','ja/','ko/','fr/','es/','pt-br/','de/','it/','ru/','pl/','uk/','tr/','vi/','id/','ar/']){
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/'+locale+'guides/android-app/');
  await checkApp();
  assert.equal(await page.locator('.guide-screenshot img').count(),3);
  for(const image of await page.locator('.guide-screenshot img').all()){
   await image.scrollIntoViewIfNeeded();
   await image.evaluate(image=>image.decode());
  }
  await noOverflow();
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  if(['','en/','ar/'].includes(locale)) {
   await page.screenshot({path:output+'/'+(locale.replace('/','')||'zh-CN')+'-app-mobile.png',fullPage:true});
   await page.screenshot({path:output+'/'+(locale.replace('/','')||'zh-CN')+'-app-intro-mobile.png',fullPage:true,clip:await page.locator('.android-app-intro').boundingBox()});
  }
  await page.setViewportSize({width:320,height:740});
  await noOverflow();
  await page.goto(origin+'/'+locale+'guides/ios-orion/');
  assert.equal(await page.locator('[data-app-download], .guide-screenshot').count(),0);
  assert((await page.locator('h1').innerText()).includes('IPA'));
  await noOverflow();
 }
 await page.setViewportSize({width:1440,height:1100});
 await page.goto(origin+'/guides/android-app/');
 await checkApp();
 for(const image of await page.locator('.guide-screenshot img').all()){
  await image.scrollIntoViewIfNeeded();
  await image.evaluate(image=>image.decode());
 }
 await page.locator('.guide-screenshot > a').first().scrollIntoViewIfNeeded();
 const before=await page.evaluate(()=>scrollY);
 const popupPromise=page.waitForEvent('popup');
 const imageUrl=await page.locator('.guide-screenshot > a').first().getAttribute('href');
 await page.locator('.guide-screenshot > a').first().click();
 const popup=await popupPromise;
 await popup.waitForLoadState();
 assert.equal(new URL(popup.url()).pathname,imageUrl);
 await popup.close();
 assert(Math.abs(await page.evaluate(()=>scrollY)-before)<2,'Opening an original screenshot must preserve the tutorial position');
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
 await page.screenshot({path:output+'/app-desktop.png',fullPage:true});
 await page.screenshot({path:output+'/app-download-section.png',fullPage:true,clip:await page.locator('.android-app-intro').boundingBox()});
 await page.goto(origin+'/guides/');
 assert.equal(await page.locator('.workflow-card[href="/guides/android-app/"]').count(),1);
 // Existing Android Firefox route remains separate.
 await page.goto(origin+'/guides/android-firefox/');
 assert.equal(await page.locator('.guide-screenshot img').count(),3);
 assert.equal(await page.locator('[data-app-release]').count(),0);
 await page.goto(origin+'/guides/ios-orion/');
 await page.screenshot({path:output+'/ios-status.png'});
 for(const locale of ['','en/','ar/']){
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});
   await page.setViewportSize({width:390,height:844});
   await page.goto(origin+'/'+locale);
   await checkApp();
   await noOverflow();
   await screenshotOptions((locale.replace('/','')||'zh-CN')+'-options-'+colorScheme);
   await page.setViewportSize({width:320,height:740});
   await noOverflow();
  }
 }
 // Failure/retry never exposes stale or release-page APK links; optional choices stay collapsed.
 let attempts=0;
 await page.route(manifestUrl,route=>{attempts++;return attempts===1?route.fulfill({status:503,body:'unavailable',headers:{'access-control-allow-origin':'*'}}):route.fulfill({json:manifest,headers:{'access-control-allow-origin':'*'}});});
 await page.goto(origin+'/en/guides/android-app/');
 await page.locator('[data-release-retry]').waitFor({state:'visible'});
 assert.equal(await page.locator('[data-app-download][href]').count(),0);
 assert.equal(attempts,1);
 await page.locator('[data-app-release]').screenshot({path:output+'/app-download-failure.png'});
 await page.locator('[data-release-retry]').click();
 await checkApp();
 assert.equal(attempts,2);
 await page.unroute(manifestUrl);
 // Timeout follows the same recoverable error path.
 await page.route(manifestUrl,()=>{});
 await page.goto(origin+'/en/guides/android-app/');
 await page.locator('[data-release-retry]').waitFor({state:'visible',timeout:12000});
 assert.equal(await page.locator('[data-app-download][href]').count(),0);
 await page.unroute(manifestUrl);
 const plain=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),plainPage=await plain.newPage();
 await plainPage.goto(origin+'/en/guides/android-app/');
 assert.equal(await plainPage.locator('[data-app-download][data-app-arch="arm64-v8a"]').isVisible(),false);
 assert((await plainPage.locator('.release-notes').innerText()).includes('GitHub'));
 assert.equal(await plainPage.locator('.release-notes').getAttribute('href'),'https://github.com/Wy2926/node-comics-app/releases/latest');
 await noOverflow(plainPage);
 await plain.close();
 // Screenshot failure retains usable instructions and original-image links.
 await page.route('**/*.webp',route=>route.abort());
 await page.goto(origin+'/en/guides/android-app/');
 await checkApp();
 assert.equal(await page.locator('.guide-screenshot a[href$=".png"]').count(),3);
 await page.locator('.guide-contents a[href="#section-3"]').click();
 await page.waitForURL('**/#section-3');
 assert(await page.locator('.guide-prose').innerText());
 await noOverflow();
 assert.deepEqual(errors,[]);console.log('PASS 17-language downloads/app tutorials, default arm64 download and optional architecture links, direct APK navigation, 320px/390px, light/dark/RTL, failure/retry/timeout and no-JS fallback');
}finally{await browser.close();}
