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
async function verifyLanguageNotices(){
  const switchLabels={
    'zh-CN':'切换到简体中文','zh-TW':'切換到繁體中文',en:'Switch to English',ja:'日本語に切り替える',ko:'한국어로 전환',
    fr:'Passer au français',es:'Cambiar a español','pt-BR':'Mudar para português',de:'Auf Deutsch wechseln',it:'Passa all’italiano',
    ru:'Перейти на русский',pl:'Przełącz na polski',uk:'Перейти на українську',tr:'Türkçeye geç',vi:'Chuyển sang tiếng Việt',id:'Gunakan bahasa Indonesia',ar:'التبديل إلى العربية',
  };
  for(const locale of languages){
    // Exercise both directions independently of the surrounding page language.
    const source=locale==='ar'||locale==='zh-CN'?'en':'ar';
    const route=`/${prefix(source)}guides/local-comics/?from=language-notice#section-2`;
    const value=await context(locale),page=await value.newPage();
    try {
      await page.goto(origin+route);
      const notice=page.locator('[data-language-notice]');
      await notice.waitFor({state:'visible'});
      assert.equal(page.url(),origin+route,'no automatic redirect');
      assert.equal(await page.locator('html').getAttribute('lang'),source,'page content keeps its URL language');
      assert.equal(await notice.getAttribute('lang'),locale,'notice uses the visitor’s supported browser language');
      assert.equal(await notice.getAttribute('dir'),locale==='ar'?'rtl':'ltr');
      assert.equal(await notice.locator('a').textContent(),switchLabels[locale]);
      assert.equal(await notice.locator('a').getAttribute('hreflang'),locale);
      assert((await notice.locator('[data-language-title]').textContent()).trim());
      assert((await notice.locator('[data-language-message]').textContent()).trim());
      assert((await notice.locator('button').textContent()).trim());
      assert.equal(await notice.evaluate(node=>node.contains(document.activeElement)),false,'notice must not steal focus');
      assert.equal(await page.locator('link[rel=alternate][hreflang]').count(),18);
      assert.equal(new URL(await page.locator('link[rel=canonical]').getAttribute('href')).pathname,new URL(page.url()).pathname);
      for(const width of [1440,320]){
        await page.setViewportSize({width,height:800});
        await page.evaluate(()=>{document.documentElement.style.fontSize='125%';});
        await noOverflow(page);
        assert(await notice.evaluate(node=>{
          const box=node.getBoundingClientRect();
          return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight&&node.scrollWidth<=node.clientWidth;
        }),`${locale}: notice fits at ${width}px with large text`);
        for(const control of [notice.locator('a'),notice.locator('button')]){
          assert(await control.evaluate(node=>{
            const box=node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
          }),`${locale}: notice action is not obscured`);
        }
        if(['zh-CN','en','ar'].includes(locale))await page.screenshot({path:path.join(out,`notice-${locale}-${width}.png`)});
      }
      const destination=`/${prefix(locale)}guides/local-comics/?from=language-notice#section-2`;
      await notice.locator('a').focus();
      await page.keyboard.press('Enter');
      await page.waitForURL(origin+destination);
      assert.equal(await page.locator('html').getAttribute('lang'),locale);
      assert.equal((await value.cookies()).find(cookie=>cookie.name==='nc-site-locale')?.value,locale);
      await page.goBack();
      await page.waitForURL(origin+route);
      assert.equal(await page.locator('html').getAttribute('lang'),source,'Back restores the original language URL');
      assert.equal(await notice.isVisible(),false,'manual choice suppresses further suggestions without redirecting Back');
    } finally {await value.close();}
  }
  const dismissed=await context('fr-FR'),dismissedPage=await dismissed.newPage();
  try {
    await dismissedPage.goto(origin+'/');
    const notice=dismissedPage.locator('[data-language-notice]');
    await notice.waitFor({state:'visible'});
    assert.equal(await notice.locator('button').textContent(),'Pas maintenant');
    await notice.locator('button').click();
    await dismissedPage.goto(origin+'/features/');
    assert.equal(await notice.isVisible(),false,'dismissal lasts for this tab session');
    assert.equal((await dismissed.cookies()).some(cookie=>cookie.name==='nc-site-locale'),false,'not now does not save a permanent preference');
  } finally {await dismissed.close();}
  const blocked=await context('zh-CN');
  await blocked.addInitScript(()=>{
    Object.defineProperty(document,'cookie',{get:()=>{throw new Error('disabled');},set:()=>{throw new Error('disabled');}});
    Object.defineProperty(window,'sessionStorage',{get:()=>{throw new Error('disabled');}});
  });
  try {
    const page=await blocked.newPage();
    await page.goto(origin+'/en/features/?from=language-notice#main');
    const notice=page.locator('[data-language-notice]');
    await notice.waitFor({state:'visible'});
    await notice.locator('button').click();
    assert.equal(await notice.isVisible(),false,'dismissal works without storage');
    await page.reload();
    await notice.waitFor({state:'visible'});
    await notice.locator('a').click();
    await page.waitForURL(origin+'/features/?from=language-notice#main');
  } finally {await blocked.close();}
  const noScript=await context('zh-CN',{javaScriptEnabled:false});
  try {
    const page=await noScript.newPage();
    await page.goto(origin+'/en/features/');
    assert.equal(await page.locator('[data-language-notice]').isVisible(),false);
    assert.equal(await page.locator('.language-menu a').count(),17);
    await page.locator('.language-menu summary').click();
    await page.locator('.language-menu a[lang="zh-CN"]').click();
    await page.waitForURL(origin+'/features/');
  } finally {await noScript.close();}
  const privateContext=await context('fr-FR');
  try {
    const page=await privateContext.newPage();
    for(const route of ['translate/','account/','payment/success/','uninstall/']){
      await page.goto(origin+'/'+route);
      assert.equal(await page.locator('[data-language-notice]').isVisible(),false,'private flow: '+route);
      assert.equal(new URL(page.url()).pathname,'/'+route);
    }
    await page.goto(origin+'/fr/account/?price=lite-year#account');
    // Production may defer modules through Cloudflare Rocket Loader after load.
    await page.waitForFunction(()=>document.querySelector('.language-menu a[lang=de]')?.getAttribute('href')==='/de/account/?price=lite-year#account');
  } finally {await privateContext.close();}
  assert.deepEqual(failures,[]);
  await writeFile(path.join(out,'notice-verification.json'),JSON.stringify({languages:17,widths:[1440,320],textScale:1.25,bidirectional:true,keyboardSwitch:true,backNavigation:true,dismissal:true,storageUnavailable:true,noJavaScript:true,privateFlows:true,automaticRedirect:false,pageErrors:failures},null,2));
  console.log('Verified browser-language notices in 17 locales, LTR/RTL, desktop/320px large text, keyboard switching, Back, dismissal, unavailable storage, no-JS and private flows.');
}
async function verifyHeaderLayout(){
  const value=await context('en'),page=await value.newPage();
  const widths=[1920,1441,1440,1366,1281,1280,1101,1100,900,761,760,480,390,320];
  try {
    for(const locale of languages){
      await page.goto(`${origin}/${prefix(locale)}guides/remote-library/`);
      await page.evaluate(()=>document.fonts.ready);
      const geometry=()=>page.locator('.header-inner > .brand, .desktop-nav, .header-tools, .header-download').evaluateAll(elements=>elements.map(element=>{
        const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height};
      }));
      const positions=new Map();
      for(const width of widths){
        await page.setViewportSize({width,height:1000});
        positions.set(width,await geometry());
        const errors=await page.evaluate(()=>{
          const errors=[],header=document.querySelector('.header-inner').getBoundingClientRect();
          const controls=[...document.querySelectorAll('.header-inner > .brand, .desktop-nav a, .header-download, .language-menu > summary, .account-link, .mobile-nav > summary')]
            .map(element=>({element,rect:element.getBoundingClientRect()})).filter(item=>item.rect.width&&item.rect.height);
          for(const {element,rect} of controls){
            const name=element.textContent.trim()||element.getAttribute('aria-label');
            if(rect.left<header.left-1||rect.right>header.right+1||rect.top<header.top-1||rect.bottom>header.bottom+1)errors.push(`outside header: ${name}`);
            if(!element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)))errors.push(`obscured: ${name}`);
          }
          for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
            const a=controls[i].rect,b=controls[j].rect;
            if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)errors.push('overlapping controls');
          }
          const nav=document.querySelector('.desktop-nav').getBoundingClientRect();
          if(nav.width){
            for(const selector of ['.header-inner > .brand','.header-tools']){
              const other=document.querySelector(selector).getBoundingClientRect();
              if(Math.max(nav.left-other.right,other.left-nav.right)<12)errors.push('navigation squeezed');
            }
          }
          if(document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');
          return errors;
        });
        assert.deepEqual(errors,[],`${locale}: header at ${width}px`);
        if(['zh-CN','en','ja','ko','uk','ar'].includes(locale)&&[1366,1280,390].includes(width))await page.screenshot({path:path.join(out,`header-${locale}-${width}.png`)});
      }
      await page.goto(`${origin}/${prefix(locale)}`);
      await page.evaluate(()=>document.fonts.ready);
      for(const width of widths){
        await page.setViewportSize({width,height:1000});
        assert.equal(await page.locator('.header-download').isVisible(),false,`${locale}: homepage has no top download action at ${width}px`);
        assert.equal(await page.locator('.header-download').evaluate(element=>{element.focus();return element===document.activeElement;}),false,`${locale}: hidden download action is not focusable`);
        assert.deepEqual(await geometry(),positions.get(width),`${locale}: header shifts between homepage and guide at ${width}px`);
      }
    }
    const noScript=await context('uk',{javaScriptEnabled:false,viewport:{width:1280,height:900}});
    try {
      const fallback=await noScript.newPage();
      await fallback.goto(`${origin}/uk/guides/remote-library/`);
      await fallback.locator('.mobile-nav summary').click();
      await fallback.locator('.mobile-nav a[href="/uk/help/"]').click();
      await fallback.waitForURL('**/uk/help/');
    } finally {await noScript.close();}
    console.log(`Verified stable homepage/guide header controls in 17 languages at ${widths.length} widths, including breakpoint edges, RTL and no-JS navigation.`);
  } finally {await value.close();}
}
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
  if(process.argv.includes('--notices-only')){await verifyLanguageNotices();return;}
  await verifyHeaderLayout();
  if(process.argv.includes('--header-only'))return;
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
  await verifyLanguageNotices();
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
  const french=await context('fr-FR',{viewport:{width:320,height:740}}),mobile=await french.newPage();
  await mobile.goto(origin+'/fr/features/');
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
  assert.deepEqual(failures,[]);
  await writeFile(path.join(out,'verification.json'),JSON.stringify({languages:17,pages:68,desktop:true,mobile:true,touch:['android-chromium','iphone-webkit'],keyboardDismissal:true,backNavigation:true,suggestions:'click only',manualPreference:true,dismissal:true,privateFlows:true,storageUnavailable:true,pageErrors:failures},null,2));
  console.log('Verified 17 languages, 68 public pages, Android/WebKit touch language and navigation menus, keyboard dismissal, Back navigation, suggestions, preferences, private flows and unavailable storage.');
}
try {await verify();} finally {await browser.close();}
