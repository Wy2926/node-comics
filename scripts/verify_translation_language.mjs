// Built MV3, isolated profiles and blocked external networking; no translation requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=path.resolve('apps/extension/.output/chrome-mv3');
const output=path.resolve('artifacts/translation-language');
await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-'));
const results=[];
const dictionaries=await Promise.all((await readdir(path.join(extension,'i18n'))).filter(file=>file.endsWith('.json'))
  .map(async file=>JSON.parse(await readFile(path.join(extension,'i18n',file),'utf8'))));
const labels=key=>[...new Set(dictionaries.map(dictionary=>dictionary[key]))];
async function launch(profile,locale){
  const context=await chromium.launchPersistentContext(profile,{
    headless:true,channel:'chromium',executablePath:process.env.TEST_CHROMIUM,locale,viewport:{width:1280,height:900},
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  context.setDefaultTimeout(15000);
  await context.route('https://**/*',route=>route.abort());
  await context.route('http://**/*',route=>route.abort());
  return context;
}
async function openSettings(context){
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).hostname}`;
  const page=context.pages().find(page=>page.url().startsWith(origin))??await context.newPage();
  await page.goto(origin+'/options.html');
  await page.waitForFunction(()=>localStorage.getItem('nc-settings')&&document.querySelector('.nc-preferences'));
  return {page,worker,origin};
}
async function snapshot(page){
  return page.evaluate(async()=>({browser:navigator.languages,ui:document.documentElement.lang,
    local:JSON.parse(localStorage.getItem('nc-settings')),saved:(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']}));
}
async function control(page,key){
  const name=new RegExp('^(?:'+labels(key).map(label=>label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')$');
  return page.getByRole('combobox',{name});
}
async function choose(page,key,value){
  await (await control(page,key)).click();
  await page.getByRole('listbox').filter({visible:true}).locator(`[role="option"][data-value="${value}"]`).click();
}
async function expectTarget(page,value){
  // waitForFunction predicates must be synchronous; a Promise would pass even when it resolves false.
  const deadline=Date.now()+15000;let state;
  do{
    state=await snapshot(page);
    if(state.local?.language===value&&state.saved?.language===value)break;
    await delay(25);
  }while(Date.now()<deadline);
  assert.equal(state.local?.language,value);assert.equal(state.saved?.language,value);
  await page.waitForFunction(({names,value})=>Array.from(document.querySelectorAll('[role="combobox"]'))
    .some(element=>names.includes(element.getAttribute('aria-label'))&&element.getAttribute('data-value')===value),
  {names:labels('默认目标语言'),value});
}

for(const [locale,expected] of [['en-US','en'],['zh-TW','zh-Hant'],['ja-JP','ja'],['pt-PT','pt-BR'],['ar-SA','en']]){
  const profile=path.join(run,locale);let context=await launch(profile,locale);
  try{
    let {page,origin}=await openSettings(context);
    assert.equal((await snapshot(page)).browser[0],locale);
    await expectTarget(page,expected);
    await (await control(page,'默认目标语言')).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(run,locale+'-initial.png')});
    await choose(page,'默认目标语言','ko');await expectTarget(page,'ko');
    await page.reload();await expectTarget(page,'ko');
    await choose(page,'界面语言','en');await expectTarget(page,'ko');
    const popup=await context.newPage();await popup.goto(origin+'/popup.html');
    await expectTarget(popup,'ko');await popup.close();
    await context.close();context=await launch(profile,'de-DE');
    ({page}=await openSettings(context));await expectTarget(page,'ko');
    assert.equal((await snapshot(page)).browser[0],'de-DE');
    // Existing-user fixture retains the former default and unrelated preferences.
    const previous={...(await snapshot(page)).saved,language:'zh-Hans',uiLanguage:'fr',accentTheme:'rose',layout:'double',textScale:1.25};
    await page.evaluate(value=>chrome.storage.local.set({'nc-reader-settings':value}),previous);
    await page.reload();await expectTarget(page,'zh-Hans');
    assert.deepEqual((await snapshot(page)).saved,previous);
    await (await control(page,'默认目标语言')).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(run,locale+'-existing.png')});
    results.push({browser:locale,initial:expected,manual:'ko',afterBrowserRestart:'ko',existing:'zh-Hans'});
    console.log(JSON.stringify(results.at(-1)));
  }catch(error){
    const page=context.pages().find(page=>page.url().includes('/options.html'));
    if(page){console.error(JSON.stringify(await snapshot(page)));await page.screenshot({path:path.join(run,locale+'-failure.png')});}
    throw error;
  }finally{await context.close();}
}
console.log(JSON.stringify({results,artifacts:run},null,2));
