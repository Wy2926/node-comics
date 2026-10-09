// Isolated Vite UI regression. All external HTTP is mocked; no account or model calls.
// Start apps/extension with npm run dev -- --port 5181, then run from the repo root.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web=process.env.TEST_READER_URL||'http://127.0.0.1:5181';
const origin=new URL(web).origin;
assert(['localhost','127.0.0.1'].includes(new URL(web).hostname),'Use an isolated local preview');
const out=path.resolve('artifacts/mobile-validation');
await mkdir(out,{recursive:true});
const {version}=JSON.parse(await readFile('apps/extension/package.json','utf8'));
const reports=[];
for(const engine of (process.env.MOBILE_BROWSER||'chromium,firefox,webkit').split(',')){
  const browser=await engines[engine].launch({headless:true,...engine==='chromium'&&process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{}});
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,...engine==='firefox'?{}:{isMobile:true},locale:'zh-CN',reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],checks=[];
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  const check=name=>{checks.push(name);console.log(`${engine}: PASS ${name}`);};
  const shot=name=>page.screenshot({path:path.join(out,`${engine}-${name}.png`)});
  const media=id=>({id,title:{native:`手机布局样本 ${id}`,english:`Mobile layout ${id}`,romaji:`Mobile ${id}`},genres:['Fantasy','Drama'],status:'RELEASING',format:'MANGA',averageScore:88,startDate:{year:2026},coverImage:{large:'https://mobile-fixture.test/cover.svg'}});
  await context.route(/^https?:\/\//,route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin)return route.continue();
    if(url.hostname==='graphql.anilist.co'){
      const {variables}=route.request().postDataJSON();
      return route.fulfill({json:{data:variables.id?{Media:{...media(variables.id),synonyms:['不同语言的样本名称'],description:'A local fixture description. '.repeat(120),staff:{edges:[]}}}:{Page:{pageInfo:{hasNextPage:false},media:Array.from({length:12},(_,i)=>media(i+1))}}}});
    }
    if(url.hostname==='mobile-fixture.test')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#b6dafa"/><text x="32" y="100" font-size="32">Mobile fixture</text></svg>'});
    return route.fulfill({status:503,contentType:'application/json',body:'{}'});
  });
  await context.addInitScript(({version})=>{
    if(!localStorage.getItem('nc-settings'))localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light',layout:'continuous',fit:'width',discoveryTextTranslation:false}));
    localStorage.setItem('nc-release-notes-version',version);
  },{version});
  const inViewport=async locator=>{
    await locator.waitFor({state:'visible'});
    const box=await locator.boundingBox(),viewport=page.viewportSize();
    assert(box&&box.x>=-1&&box.y>=-1&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,`Control outside viewport: ${await locator.getAttribute('aria-label')} ${JSON.stringify(box)}`);
  };
  const noOverflow=async()=>{
    const value=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert(value.scroll<=value.width+1,`Horizontal page overflow ${JSON.stringify(value)}`);
  };
  try{
    await page.goto(web);
    await page.getByRole('navigation',{name:'主导航'}).waitFor();
    const nav=page.getByRole('navigation',{name:'主导航'});
    for(const [width,height] of [[320,568],[360,800],[390,844],[430,932],[844,390]]){
      await page.setViewportSize({width,height});
      for(const name of ['我的漫画','远程书库','发现','搜索漫画','漫画网站']){
        const button=nav.getByRole('button',{name,exact:true});
        await inViewport(button);await button.click();await noOverflow();
      }
      await page.getByRole('button',{name:'外观与设置',exact:true}).click();await noOverflow();
      await page.getByRole('button',{name:'我的账户',exact:true}).click();await noOverflow();
      const notice=await page.locator('.nc-notifications').boundingBox(),navigation=await nav.boundingBox();
      assert(notice.y+notice.height<=navigation.y,'Notification area covers bottom navigation');
      check(`all main destinations ${width}x${height}`);
    }
    await page.setViewportSize({width:390,height:844});
    await nav.getByRole('button',{name:'我的漫画',exact:true}).click();await shot('library');
    const utilities=page.getByRole('button',{name:'更多操作 · 主导航',exact:true});
    await utilities.tap();await inViewport(page.getByRole('link',{name:'GitHub',exact:true}));
    await page.locator('.nc-release-trigger').tap();
    await inViewport(page.locator('.nc-release-close'));await inViewport(page.getByRole('button',{name:'知道了',exact:true}));
    await shot('release-notes');await page.getByRole('button',{name:'知道了',exact:true}).tap();await utilities.tap();
    check('phone utility menu retains release notes and reachable close/actions');
    await page.getByRole('button',{name:'外观与设置',exact:true}).click();
    const select=page.getByRole('combobox',{name:'默认目标语言',exact:true});
    await select.scrollIntoViewIfNeeded();await select.tap();
    const languageList=page.getByRole('listbox');
    await inViewport(languageList);await shot('select');
    if(engine==='chromium'){
      const cdp=await context.newCDPSession(page),box=await languageList.boundingBox();
      await languageList.evaluate(el=>{el.scrollTop=0;});
      const x=Math.round(box.x+box.width/2),y=Math.round(box.y+box.height/2);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let distance=20;distance<=120;distance+=20){
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-distance}]});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
      }
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert(await languageList.evaluate(el=>el.scrollTop>0),'Native touch pan did not scroll the language list');
      assert.equal(await select.getAttribute('aria-expanded'),'true');
      await cdp.detach();
    }
    const option=languageList.getByRole('option').nth(2),choice=await option.getAttribute('data-value');
    await option.tap();assert.equal(await select.getAttribute('data-value'),choice);
    assert.equal(await select.getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('.nc-scrollbar-layer').count(),0,'Coarse pointer installed custom scrollbars');
    await page.getByRole('button',{name:'自定义快捷键',exact:true}).click();await inViewport(page.getByRole('dialog').getByRole('button',{name:'关闭弹窗',exact:true}));await shot('shortcuts');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'我的账户',exact:true}).click();
    await page.getByRole('button',{name:'登录账户',exact:true}).first().click();await inViewport(page.getByRole('button',{name:'关闭登录',exact:true}));await shot('login');await page.getByRole('button',{name:'关闭登录',exact:true}).click();
    check('touch select, shortcut dialog and login close remain reachable');
    await nav.getByRole('button',{name:'发现',exact:true}).click();
    const card=page.locator('.nc-discovery-card').first();
    await card.click();await page.getByRole('dialog').waitFor();await noOverflow();await inViewport(page.getByRole('dialog').getByRole('button',{name:'关闭弹窗',exact:true}));await shot('discovery-detail');
    await page.getByRole('dialog').getByRole('button',{name:'关闭弹窗',exact:true}).click();
    check('discovery detail is scrollable and closable on phone');
    await nav.getByRole('button',{name:'我的漫画',exact:true}).click();
    await page.evaluate(async()=>{
      const {comicFile}=await import('/tests/comic-fixture.ts');
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=1200;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#e4efff';ctx.fillRect(0,0,800,1200);ctx.fillStyle='#315480';ctx.font='48px sans-serif';ctx.fillText('Mobile reader fixture',60,120);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const file=await comicFile('Mobile fixture',Array.from({length:8},()=>blob)),transfer=new DataTransfer();transfer.items.add(file);
      const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await page.locator('.nc-page-image').first().waitFor({timeout:60000});
    const viewport=page.locator('.nc-reading-viewport');
    await inViewport(page.getByRole('button',{name:'返回我的漫画',exact:true}));
    await inViewport(page.getByRole('button',{name:'打开目录',exact:true}));
    await inViewport(page.getByRole('button',{name:'阅读设置',exact:true}));
    const notice=await page.locator('.nc-notifications').boundingBox(),tools=await page.locator('#nc-reader-translation-tools').boundingBox();
    assert(notice.y+notice.height<=tools.y,'Notification area covers reading tools');
    const jump=page.getByRole('spinbutton',{name:'跳转页码',exact:true});
    const currentPage=page.getByRole('slider',{name:'阅读进度',exact:true});
    const waitPage=value=>page.waitForFunction(value=>document.querySelector('.nc-reader-progress').value===String(value),value);
    await jump.fill('3');await jump.press('Enter');await waitPage(3);
    await jump.fill('');assert.equal(await jump.inputValue(),'');assert.equal(await currentPage.inputValue(),'3');
    await jump.fill('2');assert.equal(await currentPage.inputValue(),'3');
    await jump.press('Enter');await waitPage(2);
    assert.equal(await jump.evaluate(element=>document.activeElement===element),false);
    await jump.fill('1');await jump.fill('12');assert.equal(await currentPage.inputValue(),'2');
    await jump.press('Tab');await waitPage(8);assert.equal(await jump.inputValue(),'8');
    for(const invalid of ['','2.5']){
      await jump.fill(invalid);await jump.press('Enter');
      assert.equal(await currentPage.inputValue(),'8');assert.equal(await jump.inputValue(),'8');
    }
    await jump.fill('0');await jump.press('Enter');await waitPage(1);
    check('page draft supports clearing, multi-digit edits, integer bounds and Done/blur commit');
    await viewport.evaluate(el=>el.scrollTo(0,400));
    const offset=await viewport.evaluate(el=>el.scrollTop);
    await page.getByRole('button',{name:'阅读设置',exact:true}).click();
    await inViewport(page.getByRole('button',{name:'关闭面板',exact:true}));await shot('reader-settings');
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    assert(Math.abs(await viewport.evaluate(el=>el.scrollTop)-offset)<3,'Reader settings changed reading position');
    await shot('reader');
    await page.getByRole('button',{name:'打开目录',exact:true}).click();await inViewport(page.getByRole('button',{name:'关闭面板',exact:true}));await shot('reader-directory');await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    await page.setViewportSize({width:844,height:390});await inViewport(page.getByRole('button',{name:'阅读设置',exact:true}));await shot('reader-landscape');
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    await page.getByRole('button',{name:'打开漫画 Mobile fixture',exact:true}).waitFor();await noOverflow();
    await shot('library-populated');
    check('real CBZ import, reader controls, drawers, orientation and position retention');
    const longImage=await page.evaluate(async pngModule=>{
      const {bitmapPng}=await import(pngModule);
      const original=Object.getOwnPropertyDescriptor(window,'OffscreenCanvas');
      Object.defineProperty(window,'OffscreenCanvas',{configurable:true,value:undefined});
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=20000;
      let bitmap,decoded;
      try{
        const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,64,20000);ctx.fillStyle='#ff0000';ctx.fillRect(0,0,64,1);ctx.fillStyle='#0000ff';ctx.fillRect(0,19999,64,1);
        bitmap=await createImageBitmap(canvas);decoded=await createImageBitmap(await bitmapPng(bitmap));
        canvas.width=canvas.height=1;
        const pixel=canvas.getContext('2d');pixel.drawImage(decoded,0,19999,1,1,0,0,1,1);
        return {width:decoded.width,height:decoded.height,bottom:[...pixel.getImageData(0,0,1,1).data]};
      }finally{bitmap?.close();decoded?.close();canvas.width=canvas.height=1;if(original)Object.defineProperty(window,'OffscreenCanvas',original);else delete window.OffscreenCanvas;}
    },'/@fs/'+path.resolve('backend/shared/translation-images/png.ts').replaceAll('\\','/'));
    assert.deepEqual(longImage,{width:64,height:20000,bottom:[0,0,255,255]});
    check('20000px image uses bounded document canvases without OffscreenCanvas and retains bottom pixels');
    await page.evaluate(()=>{const settings=JSON.parse(localStorage.getItem('nc-settings'));localStorage.setItem('nc-settings',JSON.stringify({...settings,appearance:'dark',textScale:1.25}));});
    await page.reload();await page.setViewportSize({width:320,height:568});
    await page.getByRole('button',{name:'外观与设置',exact:true}).click();await noOverflow();await shot('settings-dark-large');
    check('320px dark appearance and large text');
    // Synthetic visual-viewport geometry, not an operating-system keyboard test.
    await page.setViewportSize({width:390,height:844});
    await page.goto(`${origin}/tests/modal-fixture.html`);
    await page.evaluate(async()=>{
      const meta=document.createElement('meta');meta.name='viewport';meta.content='width=device-width, initial-scale=1';document.head.append(meta);
      await import('/src/ui/touch-controls.css');
    });
    await page.locator('#open-import').click();
    await page.evaluate(()=>{
      for(const [key,value] of Object.entries({height:360,offsetTop:72}))Object.defineProperty(visualViewport,key,{configurable:true,value});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    const dialog=page.getByRole('dialog'),close=dialog.locator('.modal-close'),footer=dialog.locator('.nc-modal-actions');
    const closeBefore=await close.boundingBox(),footerBefore=await footer.boundingBox();
    for(const control of [close,footer]){
      const box=await control.boundingBox();assert(box.y>=72&&box.y+box.height<=433,`Modal control behind simulated keyboard: ${JSON.stringify(box)}`);
    }
    await dialog.locator('.nc-modal-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    assert.equal((await close.boundingBox()).y,closeBefore.y);assert.equal((await footer.boundingBox()).y,footerBefore.y);
    await shot('keyboard-dialog');await close.click();
    check('simulated keyboard keeps modal close and fixed actions in the visual viewport');
    await page.addInitScript(()=>{
      window.chrome={runtime:{getURL:path=>location.origin+path,sendMessage:async()=>({}),openOptionsPage:async()=>{}},tabs:{query:async()=>[{id:1,url:'https://mobile-fixture.test/comic',title:'Mobile fixture'}]}};
    });
    await page.goto(`${origin}/entrypoints/popup/index.html`);
    await page.locator('.nc-popup').waitFor();
    for(const [width,height] of [[320,568],[390,844],[844,390]]){
      await page.setViewportSize({width,height});await noOverflow();
      const language=page.getByRole('combobox',{name:'默认目标语言',exact:true});
      await language.tap();await inViewport(page.getByRole('listbox'));await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'键盘快捷键',exact:true}).scrollIntoViewIfNeeded();
      await inViewport(page.getByRole('button',{name:'键盘快捷键',exact:true}));
    }
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor===getComputedStyle(document.querySelector('.nc-popup')).backgroundColor),'Phone popup background must follow its theme below short content');
    await shot('popup');
    check('popup layout and language list fit phone and landscape with mocked extension APIs');
    for(const hasTouch of [false,true]){
      const desktop=await browser.newContext({viewport:{width:420,height:600},screen:{width:1920,height:1080},hasTouch,locale:'zh-CN',reducedMotion:'reduce'});
      try{
        await desktop.route(/^https?:\/\//,route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:503,contentType:'application/json',body:'{}'}));
        await desktop.addInitScript(({version})=>{
          localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light'}));
          localStorage.setItem('nc-release-notes-version',version);
        },{version});
        let desktopPage=await desktop.newPage();desktopPage.on('pageerror',error=>errors.push(error.message));
        await desktopPage.goto(web);
        const desktopNav=desktopPage.getByRole('navigation',{name:'主导航'});await desktopNav.waitFor();
        for(const [width,height] of [[1440,480],[1001,480],[1000,480],[844,390],[701,700],[700,700]]){
          await desktopPage.setViewportSize({width,height});
          assert.equal(await desktopNav.evaluate(el=>getComputedStyle(el).position==='fixed'),width<=700||hasTouch&&width<=1000&&height<=500);
          for(const name of ['我的漫画','远程书库','搜索漫画','漫画网站']){
            await desktopNav.getByRole('button',{name,exact:true}).click();
            assert(await desktopPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Desktop overflow: ${width}x${height}, touch=${hasTouch}, ${name}`);
          }
        }
        await desktop.addInitScript(()=>{window.chrome={runtime:{getURL:path=>location.origin+path,sendMessage:async()=>({}),openOptionsPage:async()=>{}},tabs:{query:async()=>[{id:1,url:'https://mobile-fixture.test/comic',title:'Desktop fixture'}]}};});
        // setViewportSize also resets emulated screen dimensions. A fresh page
        // keeps a 420px popup viewport on the context's 1920px desktop screen.
        await desktopPage.close();desktopPage=await desktop.newPage();
        desktopPage.on('pageerror',error=>errors.push(error.message));
        await desktopPage.goto(`${origin}/entrypoints/popup/index.html`);
        await desktopPage.locator('.nc-popup-language .nc-select').waitFor();
        assert.equal(await desktopPage.locator('.nc-popup').evaluate(el=>el.getBoundingClientRect().width),420);
        assert.equal(await desktopPage.evaluate(()=>screen.width),1920);
        assert.equal(await desktopPage.locator('.nc-popup-language').evaluate(el=>getComputedStyle(el).flexDirection),'row');
        assert.equal(await desktopPage.locator('.nc-popup-library .nc-popup-shortcut').evaluate(el=>getComputedStyle(el).display),'flex');
        if(hasTouch){
          assert((await desktopPage.locator('.nc-popup-language .nc-select').boundingBox()).height>=44);
        }else{
          assert((await desktopPage.locator('.switch').boundingBox()).height<44);
          await desktopPage.locator('.nc-popup-language .nc-select').click();
          assert.equal((await desktopPage.locator('.nc-select-option').first().boundingBox()).height,36);
        }
        await desktopPage.screenshot({path:path.join(out,`${engine}-desktop-popup-touch-${hasTouch}.png`)});
      }finally{await desktop.close();}
    }
    check('desktop mouse/touch widths retain bounded navigation and compact popup without hiding shortcuts');
    assert.deepEqual(errors,[]);
    reports.push({engine,checks,errors,realMobileDevice:false,externalServices:false});
  }catch(error){
    console.error(await page.evaluate(()=>({url:location.hash,viewport:[innerWidth,innerHeight],overflow:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.right>innerWidth+1;}).slice(0,12).map(el=>({tag:el.tagName,class:el.className,right:el.getBoundingClientRect().right}))})));
    await shot('failure').catch(()=>{});throw error;
  }
  finally{await browser.close();await writeFile(path.join(out,'report.json'),JSON.stringify(reports,null,2));}
}
