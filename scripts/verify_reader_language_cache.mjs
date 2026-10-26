// Vite :5176; real React, IndexedDB and image decoding, with a synthetic translation service.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5176',out=path.resolve('artifacts/reader-language-cache');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const counts=()=>page.evaluate(()=>({submitted:window.readerFixture.translationRequests.length,downloads:window.readerFixture.requests.filter(path=>path.endsWith('/result')).length}));
async function selectLanguage(name){
  await page.locator('.nc-translation-trigger').click();
  await page.getByRole('combobox',{name:'翻译目标语言',exact:true}).click();
  await page.getByRole('option',{name,exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
}
async function displayed(id){
  await page.waitForFunction(id=>{const image=document.querySelector('.nc-page-image');return image?.getAttribute('data-result-job')===id&&image.complete&&image.naturalWidth>0&&!document.querySelector('.nc-page-image-pending');},id);
  assert.equal(await page.locator('.nc-image-failure').count(),0);
}
async function finish(language){
  await page.waitForFunction(language=>window.readerFixture.jobs.some(job=>job.target_language===language&&job.status==='running'),language);
  const id=await page.evaluate(()=>window.readerFixture.finishNext());assert(id);await displayed(id);return id;
}
try{
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/tests/reader-fixture.html?auto=connection&long');
  await page.getByRole('button',{name:'关闭版本更新',exact:true}).click();
  await page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true}).click();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await page.getByRole('button',{name:'连续',exact:true}).click();
  await page.getByRole('button',{name:'铺满宽度',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  await page.getByRole('button',{name:'翻译',exact:true}).click();
  const chinese=await finish('zh-Hans');
  await selectLanguage('English');const english=await finish('en');
  const cached=await counts();assert.deepEqual(cached,{submitted:2,downloads:2});
  await page.locator('.nc-reading-viewport').evaluate(view=>{view.scrollTop=150;});
  const top=await page.locator('.nc-reading-viewport').evaluate(view=>view.scrollTop);assert(top>100);
  // Only switching back exercises an already-published reference whose reader
  // used to be destroyed by the previous language's runtime cleanup.
  for(const [language,id] of [['简体中文',chinese],['English',english],['简体中文',chinese],['English',english]]){
    await selectLanguage(language);await displayed(id);
    assert.deepEqual(await counts(),cached,'cached language switches must not translate or download again');
    assert.equal(await page.getByLabel('阅读进度',{exact:true}).inputValue(),'1');
    assert(Math.abs(await page.locator('.nc-reading-viewport').evaluate(view=>view.scrollTop)-top)<1);
    checks.push(language+' displays its cached result without retry or position changes');
  }
  await page.screenshot({path:path.join(out,'cached-languages.png')});
  await page.getByRole('button',{name:'原图',exact:true}).click();await displayed('original');
  await page.getByRole('button',{name:'翻译',exact:true}).click();await displayed(english);
  assert.deepEqual(await counts(),cached);assert.deepEqual(errors,[]);
  checks.push('original/translated toggles still reuse the authorized cached result');
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,...cached,liveProvider:false},null,2));
  checks.forEach(check=>console.log('PASS '+check));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}
finally{await browser.close();}
