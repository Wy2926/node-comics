// Isolated Chromium + synthetic API. Start extension Vite on :5176; no real translation calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const catalog=JSON.parse(await readFile(new URL('../backend/shared/translation-fonts.json',import.meta.url),'utf8'));
const web='http://127.0.0.1:5176',out=path.resolve(process.env.FONT_VALIDATION_OUTPUT||'artifacts/translation-fonts-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage();
const checks=[],errors=[],loadedFonts=new Set(),requests=[],settingsLayouts=[];
const check=message=>{checks.push(message);console.log('PASS '+message);};
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.url().endsWith('.woff2'))requests.push(request.url());});
await context.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
const fixture=web+'/tests/reader-fixture.html?fonts=1&auto=fonts&long';
let releaseFonts;
const fontGate=new Promise(resolve=>{releaseFonts=resolve;});
await page.route('**/fonts/translation/*.woff2',async route=>{await fontGate;await route.continue();});
async function dismissNotes(target=page){
  await target.getByRole('combobox',{name:'翻译字体',exact:true}).waitFor();
  const notes=target.locator('.nc-release-notes[open]');
  if(await notes.count())await notes.locator('.nc-release-close').click();
}
async function selectValue(name,value,target=page){
  const trigger=target.getByRole('combobox',{name,exact:true});
  await trigger.waitFor();
  if(await trigger.getAttribute('data-value')===value){if(await trigger.getAttribute('aria-expanded')==='true')await trigger.press('Escape');return;}
  if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
  const id=await trigger.getAttribute('aria-controls');
  await target.locator(`[id=${JSON.stringify(id)}] [role=option][data-value=${JSON.stringify(value)}]`).click();
  await target.waitForFunction(({name,value})=>document.querySelector(`[role="combobox"][aria-label="${name}"]`)?.getAttribute('data-value')===value,{name,value});
}
async function optionValues(name,target=page,keepOpen=false){
  const trigger=target.getByRole('combobox',{name,exact:true});if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
  const id=await trigger.getAttribute('aria-controls');
  const result=await target.locator(`[id=${JSON.stringify(id)}] [role=option]`).evaluateAll(options=>options.map(option=>({value:option.getAttribute('data-value'),label:option.querySelector('.nc-select-label')?.textContent,disabled:option.getAttribute('aria-disabled')==='true'})));
  if(!keepOpen)await trigger.press('Escape');return result;
}
async function preview(font,language,target=page,option=false){
  const selector=option?`.nc-font-picker [role=option][data-value=${JSON.stringify(font.id)}] .nc-select-label`:'.nc-font-picker .nc-select-value';
  await target.waitForFunction(({selector,id})=>{const element=document.querySelector(selector);return element&&getComputedStyle(element).fontFamily.includes(id);},{selector,id:font.id});
  const evidence=await target.locator(selector).evaluate(element=>({text:element.textContent,language:element.lang,direction:getComputedStyle(element).direction,family:getComputedStyle(element).fontFamily,weight:getComputedStyle(element).fontWeight,synthesis:getComputedStyle(element).fontSynthesis,faces:[...document.fonts].filter(face=>getComputedStyle(element).fontFamily.includes(face.family.replaceAll('"',''))).map(face=>({family:face.family,status:face.status}))}));
  assert.equal(evidence.text,font.names[language]);assert.equal(evidence.language,language);
  assert.equal(evidence.weight,'400');assert.equal(evidence.synthesis,'none');
  assert(evidence.family.includes(font.id),JSON.stringify(evidence));assert(evidence.faces.some(face=>face.status==='loaded'),JSON.stringify(evidence));
  assert.equal(await target.locator('.nc-font-preview').count(),0,'the dropdown is the only font preview');
  if(language==='ar')assert.equal(evidence.direction,'rtl');
  loadedFonts.add(font.id);return evidence;
}
async function fontList(target=page){const id=await target.getByRole('combobox',{name:'翻译字体',exact:true}).getAttribute('aria-controls');return target.locator(`[id=${JSON.stringify(id)}]`);}
async function listFits(target=page){
  const list=await fontList(target),bounds=await list.evaluate(element=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,width:innerWidth,height:innerHeight,overflow:element.scrollWidth>element.clientWidth+1}));
  assert(bounds.left>=-1&&bounds.right<=bounds.width+1&&bounds.top>=-1&&bounds.bottom<=bounds.height+1&&!bounds.overflow,JSON.stringify(bounds));
}
async function textScale(value,target=page){
  await target.evaluate(value=>{
    const saved=JSON.parse(localStorage.getItem('nc-settings'));saved.textScale=value;
    localStorage.setItem('nc-settings',JSON.stringify(saved));window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));
  },value);
  await target.waitForFunction(value=>getComputedStyle(document.documentElement).fontSize===`${16*value}px`,value);
}
async function settingsLayout(target=page){
  const layout=await target.evaluate(()=>{
    const rect=selector=>{const element=document.querySelector(selector),bounds=element.getBoundingClientRect();return {left:bounds.left,right:bounds.right,width:bounds.width};};
    const picker=document.querySelector('.nc-font-picker');
    return {viewport:innerWidth,textScale:parseFloat(getComputedStyle(document.documentElement).fontSize)/16,touch:matchMedia('(pointer:coarse)').matches,
      language:rect('[aria-label="默认目标语言"]'),model:rect('.nc-model-trigger'),font:rect('.nc-font-picker .nc-select'),
      overflow:picker.scrollWidth>picker.clientWidth+1||document.documentElement.scrollWidth>innerWidth+1};
  });
  assert(!layout.overflow,JSON.stringify(layout));
  for(const control of [layout.language,layout.model]){
    assert(Math.abs(layout.font.width-control.width)<1&&Math.abs(layout.font.right-control.right)<1,JSON.stringify(layout));
  }
  const trigger=target.getByRole('combobox',{name:'翻译字体',exact:true});
  await trigger.click();await listFits(target);
  const menu=await(await fontList(target)).boundingBox();
  assert(Math.abs(menu.width-Math.min(Math.max(layout.font.width,180),layout.viewport-16))<1,JSON.stringify({layout,menu}));
  await trigger.press('Escape');settingsLayouts.push(layout);
}
const state=()=>page.evaluate(()=>({translations:window.readerFixture.translationRequests,jobs:window.readerFixture.jobs,submitted:window.readerFixture.submitted}));
const position=()=>page.locator('.nc-reading-viewport').evaluate(element=>element.scrollTop);
async function finish(){await page.getByRole('button',{name:'模拟完成',exact:true}).click();}
async function fontInReader(value){
  const bounds=await page.locator('.nc-reading-viewport').boundingBox();
  await page.mouse.move(bounds.x+2,bounds.y+bounds.height/2);
  await page.locator('.nc-translation-trigger').click();await selectValue('翻译字体',value);await page.getByRole('button',{name:'关闭面板',exact:true}).click();
}
try{
  const initialFontRequest=page.waitForRequest('**/fonts/translation/*.woff2');
  await page.goto(fixture+'#settings',{waitUntil:'domcontentloaded'});await dismissNotes();await initialFontRequest;
  const initialLanguage=await page.getByRole('combobox',{name:'默认目标语言',exact:true}).getAttribute('data-value');
  const initialDefault=catalog.fonts.find(font=>font.id===catalog.defaults[initialLanguage]);
  const pickerGeometry=()=>page.locator('.nc-font-picker').evaluate(element=>({height:element.getBoundingClientRect().height,nextOffset:element.nextElementSibling.getBoundingClientRect().top-element.getBoundingClientRect().top,status:!!element.querySelector('[role="status"]')}));
  const loadingLayout={before:await pickerGeometry()};
  assert.equal(loadingLayout.before.status,false,'pending font previews must not insert a loading row');
  assert.equal(await page.locator('.nc-font-picker .nc-select').isEnabled(),true);
  await page.locator('.nc-font-picker').screenshot({path:path.join(out,'font-preview-pending.png')});
  releaseFonts();
  await preview(initialDefault,initialLanguage);
  loadingLayout.after=await pickerGeometry();assert.deepEqual(loadingLayout.after,loadingLayout.before,'loading a font must preserve the picker height and following settings position');
  await page.locator('.nc-font-picker').screenshot({path:path.join(out,'font-preview-loaded.png')});
  await page.unroute('**/fonts/translation/*.woff2');
  check('a pending font remains selectable without a loading message; completing the preview preserves picker height and following settings position');
  assert.deepEqual(requests,[web+'/fonts/translation/'+initialDefault.id+'.woff2'],'a closed initial picker loads only its explicit language default');
  assert.equal(await page.locator('.nc-font-preview').count(),0);
  const languages=await optionValues('默认目标语言');
  assert.equal(languages.length,17);
  assert.deepEqual(new Set(languages.map(language=>language.value)),new Set(catalog.fonts.flatMap(font=>font.languages)));
  let localizedPreviews=0;
  for(const {value:language} of languages){
    await selectValue('默认目标语言',language);
    const expected=catalog.fonts.filter(font=>font.languages.includes(language));
    assert(expected.length>=5,`fewer than five fonts cover ${language}`);
    const languageDefault=expected.find(font=>font.id===catalog.defaults[language]);assert(languageDefault);
    assert.equal(await page.getByRole('combobox',{name:'翻译字体',exact:true}).getAttribute('data-value'),languageDefault.id);
    await preview(languageDefault,language);
    const alreadyRequested=new Set(requests),beforeOpen=requests.length;
    const actual=await optionValues('翻译字体',page,true);
    assert(actual.every(choice=>choice.value&&!choice.disabled),'font menus have no empty or legacy-font option');
    assert.deepEqual(actual.filter(choice=>choice.value&&!choice.disabled).map(({value,label})=>({value,label})),expected.map(font=>({value:font.id,label:font.names[language]})),language);
    for(const font of expected)await preview(font,language,page,true);
    assert.deepEqual(new Set(requests.slice(beforeOpen)),new Set(expected.map(font=>web+'/fonts/translation/'+font.id+'.woff2').filter(url=>!alreadyRequested.has(url))),'opening the list must fetch only uncached fonts for its current language');
    await listFits();
    if(['zh-Hans','en','ja','ko','ar'].includes(language))await(await fontList()).screenshot({path:path.join(out,`localized-${language}.png`)});
    await page.getByRole('combobox',{name:'翻译字体',exact:true}).press('Escape');
    for(const font of expected){
      await selectValue('翻译字体',font.id);await preview(font,language);localizedPreviews++;
    }
  }
  check(`all ${languages.length} target languages expose exactly their service-approved localized font names in the Chinese UI`);
  check(`all ${localizedPreviews} option and selected labels render with ${loadedFonts.size} real FontFace resources at weight 400, with no separate preview card`);
  assert.equal(new Set(requests).size,catalog.fonts.length);
  assert.equal(requests.length,catalog.fonts.length,'switching language must reuse a loaded font');

  const shared=catalog.fonts.find(font=>font.languages.includes('zh-Hans')&&font.languages.includes('ja'));
  assert(shared&&shared.names['zh-Hans']!==shared.names.ja,'shared-font scenario needs distinct localized names');
  for(const language of ['zh-Hans','ja']){
    await selectValue('默认目标语言',language);await selectValue('翻译字体',shared.id);await preview(shared,language);
  }
  const beforeSharedRequests=requests.length;
  await page.evaluate(()=>{
    const probe={loading:false,observer:new MutationObserver(()=>{if(document.querySelector('.nc-font-picker>[role="status"]'))probe.loading=true;})};
    probe.observer.observe(document.querySelector('.nc-font-picker'),{childList:true,subtree:true,characterData:true});
    window.fontSwitchProbe=probe;
  });
  for(const language of ['zh-Hans','ja','zh-Hans']){
    await selectValue('默认目标语言',language);await preview(shared,language);
    assert.equal(await page.locator('.nc-font-picker>[role="status"]').count(),0);
  }
  const flashed=await page.evaluate(()=>{window.fontSwitchProbe.observer.disconnect();return window.fontSwitchProbe.loading;});
  assert.equal(flashed,false,'a shared font must update its name without flashing a loading placeholder');
  assert.equal(requests.length,beforeSharedRequests);
  check('switching one shared font between Chinese and Japanese updates its native name immediately without reloading or flashing');

  const english=catalog.fonts.filter(font=>font.languages.includes('en')),first=english.find(font=>font.id===catalog.defaults.en),second=english.find(font=>font.id!==catalog.defaults.en);
  assert(first&&second,'reader retranslation scenario needs two English choices');
  await selectValue('默认目标语言','en');await selectValue('翻译字体',first.id);await preview(first,'en');
  const beforeReload=requests.length;
  await page.reload();await dismissNotes();
  assert.equal(await page.getByRole('combobox',{name:'默认目标语言',exact:true}).getAttribute('data-value'),'en');
  assert.equal(await page.getByRole('combobox',{name:'翻译字体',exact:true}).getAttribute('data-value'),first.id);
  await preview(first,'en');
  assert.deepEqual(requests.slice(beforeReload),[web+'/fonts/translation/'+first.id+'.woff2'],'a closed saved selection must load only its own font');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nc-translation-channels')));
  assert(Object.values(saved.fontPreferences).some(value=>value.en===first.id));
  check('font and target-language preferences survive a full reload and storage re-read');
  for(const scale of [1,1.25]){
    await textScale(scale);
    for(const width of [1280,768,700,390,320]){
      await page.setViewportSize({width,height:1000});await settingsLayout();
      if(width===1280&&scale===1)await page.locator('.settings-card:has(.nc-font-picker)').screenshot({path:path.join(out,'settings-width-1280-1.png')});
      if(width===320&&scale===1.25)await page.screenshot({path:path.join(out,'settings-width-320-1.25.png')});
    }
  }
  check('font, language and model controls align at 1280/768/700/390/320px with normal and 1.25 text scale; menus stay within the viewport');
  await textScale(1);await page.setViewportSize({width:1280,height:1000});
  await page.screenshot({path:path.join(out,'desktop-settings.png'),fullPage:true});

  const fontTrigger=page.getByRole('combobox',{name:'翻译字体',exact:true});
  await fontTrigger.press('ArrowDown');await fontTrigger.press('End');await fontTrigger.press('Escape');
  assert.equal(await fontTrigger.getAttribute('data-value'),first.id);
  for(const letter of second.names.en.slice(0,3).toLowerCase())await fontTrigger.press(letter);
  const active=await fontTrigger.getAttribute('aria-activedescendant');
  assert.equal(await page.locator(`[id=${JSON.stringify(active)}]`).getAttribute('data-value'),second.id);
  await fontTrigger.press('Enter');await preview(second,'en');
  assert.equal(await fontTrigger.getAttribute('aria-expanded'),'false');
  assert.equal(await fontTrigger.evaluate(element=>document.activeElement===element),true);
  await page.evaluate(()=>{window.readerFixture.delay=250;});
  await fontTrigger.press('Home');for(let i=0;i<english.indexOf(first);i++)await fontTrigger.press('ArrowDown');await fontTrigger.press('Tab');
  await page.evaluate(()=>{window.fontTabDestination=document.activeElement;});
  assert.equal(await fontTrigger.evaluate(element=>document.activeElement===element),false);
  await preview(first,'en');
  assert.equal(await page.evaluate(()=>document.activeElement===window.fontTabDestination),true,'restoring a reconnected font picker must not steal focus after Tab');
  await page.evaluate(()=>{window.readerFixture.delay=0;});
  check('font-label typeahead, Enter, Escape and Tab retain shared keyboard behavior without stealing focus after an asynchronous save');

  for(const stored of ['', 'retired-font', null]){
    await page.evaluate(stored=>{
      const saved=JSON.parse(localStorage.getItem('nc-translation-channels'));
      for(const preferences of Object.values(saved.fontPreferences)){if(stored===null)delete preferences.en;else preferences.en=stored;}
      localStorage.setItem('nc-translation-channels',JSON.stringify(saved));
    },stored);
    await page.reload();await dismissNotes();await preview(first,'en');
    assert.equal(await fontTrigger.getAttribute('data-value'),first.id);
    assert((await optionValues('翻译字体')).every(choice=>choice.value&&!choice.disabled));
  }
  check('empty, retired and absent saved fonts resolve to the language default without a legacy/empty option');

  await page.setViewportSize({width:390,height:844});
  await selectValue('默认目标语言','ar');
  const arabic=catalog.fonts.find(font=>font.languages.includes('ar'));await selectValue('翻译字体',arabic.id);await preview(arabic,'ar');
  const bounds=await page.locator('.nc-font-picker').evaluate(element=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,width:innerWidth,overflow:element.scrollWidth>element.clientWidth+1}));
  assert(bounds.left>=-1&&bounds.right<=bounds.width+1&&!bounds.overflow,JSON.stringify(bounds));
  await fontTrigger.scrollIntoViewIfNeeded();await page.mouse.wheel(0,220);await page.waitForTimeout(200);
  await optionValues('翻译字体',page,true);
  for(const font of catalog.fonts.filter(font=>font.languages.includes('ar')))await preview(font,'ar',page,true);
  await listFits();await page.screenshot({path:path.join(out,'mobile-arabic.png')});
  await fontTrigger.press('Escape');
  check('390px mobile layout keeps Arabic option and selected labels RTL with no dropdown overflow');
  await page.setViewportSize({width:1280,height:1000});
  await selectValue('默认目标语言','en');await selectValue('翻译字体',first.id);
  await page.evaluate(()=>{location.hash='library';});
  await page.getByRole('button',{name:'打开漫画 自动翻译 · fonts',exact:true}).waitFor();
  const notes=page.locator('.nc-release-notes[open]');if(await notes.count())await notes.locator('.nc-release-close').click();
  await page.getByRole('button',{name:'打开漫画 自动翻译 · fonts',exact:true}).click();
  await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.waitForFunction(()=>window.readerFixture.translationRequests.length>=4);
  await page.waitForFunction(()=>window.readerFixture.jobs.filter(job=>['queued','running'].includes(job.status)).length>=4);
  let before=await state();assert(before.translations.every(value=>value.body.font_id===first.id));
  await finish();await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').first().waitFor();
  await page.locator('.nc-reading-viewport').evaluate(element=>{element.scrollTop=180;});await page.waitForTimeout(250);
  const top=await position(),pageNumber=await page.getByLabel('跳转页码',{exact:true}).inputValue();assert(top>100);
  before=await state();await fontInReader(second.id);await page.waitForTimeout(400);
  assert.equal((await state()).translations.length,before.translations.length);
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),pageNumber);assert(Math.abs(await position()-top)<1);
  check('changing a font keeps existing images and the exact reading position without submitting tasks');
  await page.getByRole('button',{name:'重新翻译此页',exact:true}).click();
  await page.waitForFunction(count=>window.readerFixture.translationRequests.length>count,before.translations.length);
  let current=await state(),changed=current.translations.at(-1);
  assert(changed.body.regenerate_of);assert.equal(changed.body.font_id,second.id);
  const pendingCount=current.translations.length;
  await fontInReader(first.id);await page.waitForTimeout(400);assert.equal((await state()).translations.length,pendingCount);
  await page.waitForFunction(id=>window.readerFixture.jobs.some(job=>job.id===id&&['queued','running'].includes(job.status)),changed.id);
  await finish();await page.waitForFunction(id=>[...document.querySelectorAll('.nc-page-image')].some(image=>image.getAttribute('data-result-job')===id),changed.id);
  check('explicit regeneration uses the selected font; later preference changes keep the accepted UUID frozen');
  await fontInReader(first.id);await page.getByRole('button',{name:'重新翻译此页',exact:true}).click();
  await page.waitForFunction(count=>window.readerFixture.translationRequests.length>count,pendingCount);
  current=await state();assert.equal(current.translations.at(-1).body.font_id,first.id);assert(current.translations.at(-1).body.regenerate_of);
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),pageNumber);assert(Math.abs(await position()-top)<1);
  check('returning to the language default explicitly freezes its concrete font_id on regeneration');
  await page.screenshot({path:path.join(out,'reader-font-selection.png')});

  const failureContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true}),failurePage=await failureContext.newPage();
  failurePage.on('pageerror',error=>errors.push(error.message));
  await failureContext.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  let failFonts=true;
  await failurePage.route('**/fonts/translation/*.woff2',async route=>{if(failFonts)return route.abort();await new Promise(resolve=>setTimeout(resolve,250));await route.continue();});
  await failurePage.goto(fixture+'#settings');await dismissNotes(failurePage);
  await selectValue('默认目标语言','en',failurePage);await selectValue('翻译字体',first.id,failurePage);
  await failurePage.getByRole('status').filter({hasText:'字体预览加载失败'}).waitFor();
  assert.equal(await failurePage.locator('.nc-font-preview').count(),0);
  assert.equal(await failurePage.getByRole('combobox',{name:'翻译字体',exact:true}).getAttribute('data-value'),first.id);
  assert.equal(await failurePage.locator('.nc-font-picker .nc-select-value').evaluate(element=>getComputedStyle(element).fontFamily.includes('comic-relief')),false,'failed preview must not pretend to use the requested face');
  await failurePage.locator('.nc-font-picker').screenshot({path:path.join(out,'font-load-failure.png')});
  failFonts=false;
  const failureTrigger=failurePage.getByRole('combobox',{name:'翻译字体',exact:true});await failureTrigger.tap();
  for(const font of english)await preview(font,'en',failurePage,true);
  await listFits(failurePage);
  assert.equal(await failurePage.locator('.nc-font-picker>[role=status]').count(),0);
  const list=await fontList(failurePage);await list.locator(`[role=option][data-value=${JSON.stringify(second.id)}]`).tap();
  await preview(second,'en',failurePage);
  assert.equal(await failureTrigger.getAttribute('aria-expanded'),'false');
  await failurePage.locator('.nc-font-picker').screenshot({path:path.join(out,'font-load-recovered.png')});
  for(const scale of [1,1.25]){
    await textScale(scale,failurePage);
    for(const width of [390,320]){await failurePage.setViewportSize({width,height:844});await settingsLayout(failurePage);}
  }
  await failurePage.locator('.nc-font-picker').scrollIntoViewIfNeeded();
  await failurePage.screenshot({path:path.join(out,'settings-phone-large-text.png')});
  check('390/320px touch layouts retain matching control widths and bounded menus at normal and 1.25 text scale');
  await failureContext.close();check('failed previews report failure; reopening retries and delayed loaded labels fit the mobile dropdown and remain touch-selectable');
  const legacyContext=await browser.newContext(),legacyPage=await legacyContext.newPage(),legacyRequests=[];
  await legacyContext.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  legacyPage.on('request',request=>{if(request.url().endsWith('.woff2'))legacyRequests.push(request.url());});
  await legacyPage.goto(fixture.replace('fonts=1','fonts=0')+'#settings');
  await legacyPage.getByRole('combobox',{name:'默认目标语言',exact:true}).waitFor();
  assert.equal(await legacyPage.locator('.nc-font-picker').count(),0);assert.deepEqual(legacyRequests,[]);
  await legacyContext.close();check('older services without font capabilities expose no font picker and fetch no font resources');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,loadingLayout,settingsLayouts,fontCount:catalog.fonts.length,languageCount:languages.length,localizedPreviews,counts:Object.fromEntries(languages.map(({value})=>[value,catalog.fonts.filter(font=>font.languages.includes(value)).length])),liveProvider:false},null,2));
}catch(error){
  await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,state:await state().catch(()=>null)},null,2));throw error;
}finally{releaseFonts();await browser.close();}
