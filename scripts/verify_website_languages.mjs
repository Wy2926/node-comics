import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium,webkit,devices}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4331';
const out=path.resolve('artifacts/website-locales/browser');
await mkdir(out,{recursive:true});
const languages=['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id','ar'];
const prefix=locale=>locale==='zh-CN'?'':locale.toLowerCase()+'/';
const browser=await chromium.launch({channel:'chrome',headless:true});
const failures=[];
async function context(locale,options={},owner=browser){
  const value=await owner.newContext({viewport:{width:1440,height:1000},...options,locale});
  await value.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==new URL(origin).origin)return route.abort();
    if(url.pathname.startsWith('/v1/'))return route.fulfill({status:503,json:{error:'fixture unavailable'}});
    return route.continue();
  });
  value.on('page',page=>page.on('pageerror',error=>failures.push(error.message)));
  return value;
}
async function noOverflow(page){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow: '+page.url());}
async function verifyMenuDismissal(page,input){
  const menu=page.locator('.language-menu'),summary=menu.locator('summary');
  await summary[input]();
  assert(await menu.evaluate(node=>node.open));
  await page.locator('h1').first()[input]({position:{x:4,y:4}});
  assert.equal(await menu.evaluate(node=>node.open),false,'outside input closes the menu');
  await summary[input]();
  await page.keyboard.press('Escape');
  assert.equal(await menu.evaluate(node=>node.open),false,'Escape closes the menu');
  assert(await summary.evaluate(node=>node===document.activeElement),'Escape restores summary focus');
}
async function verifyTouchMenus(owner,device,name){
  const value=await context('zh-CN',device,owner),page=await value.newPage();
  try {
    await page.goto(origin+'/features/?menu=1#main');
    // Wait for deferred production modules, not only server-rendered links.
    await page.waitForFunction(()=>document.querySelector('.language-menu a[lang=en]')?.getAttribute('href')==='/en/features/?menu=1#main');
    await verifyMenuDismissal(page,'tap');
    await page.locator('.language-menu summary').tap();
    await page.screenshot({path:path.join(out,`${name}-language-open.png`)});
    await page.locator('.language-menu a[lang=en]').tap();
    await page.waitForURL('**/en/features/?menu=1#main');
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    assert.equal((await value.cookies()).find(cookie=>cookie.name==='nc-site-locale')?.value,'en');
    await page.waitForFunction(()=>document.querySelector('.language-menu a[lang=ja]')?.getAttribute('href')==='/ja/features/?menu=1#main');
    await page.locator('.language-menu summary').tap();
    await page.locator('.language-menu a[lang=ja]').tap();
    await page.waitForURL('**/ja/features/?menu=1#main');
    await page.goBack();
    await page.waitForURL('**/en/features/?menu=1#main');
    assert.equal(await page.locator('html').getAttribute('lang'),'en','Back restores the previous language');
    if(await page.locator('.language-menu').evaluate(node=>node.open)) await page.keyboard.press('Escape');
    await page.locator('.language-menu summary').tap();
    await page.locator('.mobile-nav summary').tap();
    assert.equal(await page.locator('.language-menu').evaluate(node=>node.open),false,'opening mobile navigation closes language menu');
    await page.locator('.mobile-nav a[href="/en/help/"]').tap();
    await page.waitForURL('**/en/help/');
    await noOverflow(page);
    await page.screenshot({path:path.join(out,`${name}-navigation-after.png`)});
  } finally {await value.close();}
}
async function verify(){
  const keyboardContext=await context('zh-CN'),keyboard=await keyboardContext.newPage();
  await keyboard.goto(origin+'/?menu=1');
  await keyboard.waitForFunction(()=>document.querySelector('.language-menu a[lang=en]')?.getAttribute('href')==='/en/?menu=1');
  await verifyMenuDismissal(keyboard,'click');
  await keyboard.locator('.language-menu summary').focus();
  await keyboard.keyboard.press('Enter');
  for(let index=0;index<languages.length;index++){
    await keyboard.keyboard.press('Tab');
    assert(await keyboard.locator('.language-menu').evaluate(node=>node.open&&node.contains(document.activeElement)),'internal Tab keeps the menu open');
  }
  await keyboard.keyboard.press('Tab');
  assert.equal(await keyboard.locator('.language-menu').evaluate(node=>node.open),false,'Tab to an outside control closes the menu');
  await keyboardContext.close();
  await verifyTouchMenus(browser,devices['Pixel 7'],'android-chromium');
  const safari=await webkit.launch({headless:true});
  try {await verifyTouchMenus(safari,devices['iPhone 13'],'iphone-webkit');}
  finally {await safari.close();}
  assert.deepEqual(failures,[]);
  await writeFile(path.join(out,'menu-verification.json'),JSON.stringify({origin,touch:['android-chromium','iphone-webkit'],keyboardDismissal:true,backNavigation:true,queryAndAnchor:true,pageErrors:failures},null,2));
  console.log('Verified desktop keyboard dismissal, Android/WebKit touch language and navigation menus, Back navigation, query and anchor preservation.');
  if(process.argv.includes('--menus-only'))return;
  for(const locale of languages){
    const value=await context(locale),page=await value.newPage();
    await page.goto(`${origin}/${prefix(locale)}`);
    await page.locator('.home-screenshot img').waitFor({state:'attached'});
    assert.equal(await page.locator('html').getAttribute('lang'),locale);
    assert.equal(await page.locator('[data-language-notice]').isVisible(),false);
    assert.equal(await page.locator('.language-menu a').count(),languages.length);
    assert.equal(await page.locator('.language-flag').evaluateAll(items=>items.every(item=>item.complete&&item.naturalWidth>0)),true);
    await noOverflow(page);
    await page.setViewportSize({width:320,height:740});
    await noOverflow(page);
    await page.setViewportSize({width:1440,height:1000});
    for(const route of ['pricing/','download/','guides/local-translation/']){
      await page.goto(`${origin}/${prefix(locale)}${route}`);
      assert.equal(await page.locator('html').getAttribute('lang'),locale);
      await noOverflow(page);
      if(route==='pricing/')assert.equal(await page.locator('.pricing-comparison .subscription-card').count(),3);
    }
    await value.close();
  }
  // Mismatch suggests a switch without navigating; clicking keeps the article and anchor.
  const german=await context('de-DE'),page=await german.newPage();
  await page.goto(origin+'/guides/local-comics/#section-2');
  const notice=page.locator('[data-language-notice]');
  await notice.waitFor({state:'visible'});
  assert.equal(new URL(page.url()).pathname,'/guides/local-comics/');
  assert.equal(await notice.locator('a').getAttribute('href'),'/de/guides/local-comics/#section-2');
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'BODY');
  await page.screenshot({path:path.join(out,'language-suggestion-desktop.png')});
  await notice.locator('a').click();
  await page.waitForURL('**/de/guides/local-comics/#section-2');
  assert.equal(await page.locator('html').getAttribute('lang'),'de');
  assert.equal((await german.cookies()).find(cookie=>cookie.name==='nc-site-locale')?.value,'de');
  await page.goto(origin+'/');
  assert.equal(await page.locator('[data-language-notice]').isVisible(),false,'manual preference suppresses suggestions');
  await german.close();
  const french=await context('fr-FR',{viewport:{width:320,height:740}}),mobile=await french.newPage();
  await mobile.goto(origin+'/');
  await mobile.locator('[data-language-notice]').waitFor({state:'visible'});
  await noOverflow(mobile);
  await mobile.locator('[data-language-notice] button').click();
  await mobile.goto(origin+'/features/');
  assert.equal(await mobile.locator('[data-language-notice]').isVisible(),false,'dismissal lasts through this tab session');
  await mobile.locator('.language-menu summary').click();
  const menu=mobile.locator('.language-menu nav');
  assert(await menu.evaluate(node=>node.scrollHeight>node.clientHeight),'seventeen-language menu must scroll');
  await menu.locator('a[lang=id]').scrollIntoViewIfNeeded();
  await mobile.screenshot({path:path.join(out,'language-menu-mobile.png')});
  await menu.locator('a[lang=id]').click();
  await mobile.waitForURL('**/id/features/');
  await noOverflow(mobile);
  assert.equal((await french.cookies()).find(cookie=>cookie.name==='nc-site-locale')?.value,'id');
  await french.close();
  const privateContext=await context('fr-FR'),privatePage=await privateContext.newPage();
  for(const route of ['translate/','account/','payment/success/','uninstall/']){
    await privatePage.goto(origin+'/'+route);
    assert.equal(await privatePage.locator('[data-language-notice]').isVisible(),false,'private flow: '+route);
    assert.equal(new URL(privatePage.url()).pathname,'/'+route);
  }
  await privatePage.goto(origin+'/fr/account/?price=lite-year#account');
  // Production may defer modules through Cloudflare Rocket Loader after load.
  await privatePage.waitForFunction(()=>document.querySelector('.language-menu a[lang=de]')?.getAttribute('href')==='/de/account/?price=lite-year#account');
  assert.equal(await privatePage.locator('.language-menu a[lang=de]').getAttribute('href'),'/de/account/?price=lite-year#account');
  await privateContext.close();
  // Optional browser storage must not disable the suggestion or manual link.
  const blocked=await context('fr-FR');
  await blocked.addInitScript(()=>{
    Object.defineProperty(document,'cookie',{get:()=>{throw new Error('disabled');},set:()=>{throw new Error('disabled');}});
    Object.defineProperty(window,'sessionStorage',{get:()=>{throw new Error('disabled');}});
  });
  const blockedPage=await blocked.newPage();
  await blockedPage.goto(origin+'/');
  await blockedPage.locator('[data-language-notice]').waitFor({state:'visible'});
  await blockedPage.locator('[data-language-notice] a').click();
  await blockedPage.waitForURL('**/fr/');
  await blocked.close();
  assert.deepEqual(failures,[]);
  await writeFile(path.join(out,'verification.json'),JSON.stringify({languages:17,pages:68,desktop:true,mobile:true,touch:['android-chromium','iphone-webkit'],keyboardDismissal:true,backNavigation:true,suggestions:'click only',manualPreference:true,dismissal:true,privateFlows:true,storageUnavailable:true,pageErrors:failures},null,2));
  console.log('Verified 17 languages, 68 public pages, Android/WebKit touch language and navigation menus, keyboard dismissal, Back navigation, suggestions, preferences, private flows and unavailable storage.');
}
try {await verify();} finally {await browser.close();}
