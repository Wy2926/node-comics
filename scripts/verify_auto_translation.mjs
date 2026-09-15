// Isolated Chrome/API integration check. Start backend/tests/manual_ui_server.py and Vite on 5174.
// Set UI_FIXTURE_DIRECTORY to the fixture's printed directory and PLAYWRIGHT_MODULE if needed.
import assert from 'node:assert/strict';
import {completeLocalImport} from './local_import_helpers.mjs';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const api='http://127.0.0.1:18089',web='http://127.0.0.1:5174';
assert(process.env.UI_FIXTURE_DIRECTORY,'UI_FIXTURE_DIRECTORY is required');
const output=path.resolve('artifacts/auto-validation');await mkdir(output,{recursive:true});
const auth=await fetch(api+'/v1/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'auto-'+randomUUID().slice(0,8)})}).then(r=>r.json());
const adminAuth=await fetch(api+'/v1/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin'})}).then(r=>r.json());
const giftResponse=await fetch(api+`/v1/admin/users/${auth.user.id}/quota-grants`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+adminAuth.access_token,'Idempotency-Key':randomUUID()},body:JSON.stringify({mode:'redraw',pages:10,expires_at:new Date(Date.now()+3600000).toISOString(),note:'isolated automatic UI check'})});
assert.equal(giftResponse.status,201);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'})});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[],checks=[],batches=[];
const baselineCss=process.env.CSS_BASELINE?await readFile(process.env.CSS_BASELINE,'utf8'):undefined;
const queueWrites=[];
page.on('request',r=>{if(r.url()===api+'/v1/me/queue'&&r.method()==='PUT')queueWrites.push(r.postData());});
page.on('pageerror',e=>errors.push(e.message));
const check=name=>{checks.push(name);console.log('PASS '+name);};
const waitFor=async(fn,label)=>{const until=Date.now()+35000;while(!fn()){assert(Date.now()<until,label);await new Promise(r=>setTimeout(r,100));}};
const enabled=async value=>assert.equal(await page.getByRole('switch',{name:'自动翻译',exact:true}).getAttribute('aria-checked'),String(value));
const jump=async n=>{const input=page.getByLabel('跳转页码');await input.fill(String(n));await input.press('Enter');await input.blur();};
const pending=()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('nc-library-submission-v2:')).map(k=>JSON.parse(localStorage.getItem(k))));
async function compareStyles(name){
  // Wait for lazy thumbnail decoding before comparing CSS; a loading placeholder is not a style regression.
  await page.waitForFunction(()=>[...document.querySelectorAll('.nc-thumbnail')].filter(el=>{
    const box=el.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight;
  }).every(el=>el.querySelector('img')?.complete));
  const current=await page.screenshot({path:path.join(output,`${name}.png`),animations:'disabled'});
  if(!baselineCss)return;
  const selector='style[data-vite-dev-id$="/styles.css"]';
  const original=await page.locator(selector).textContent();
  try{
    await page.locator(selector).evaluate((el,css)=>{el.textContent=css;},baselineCss);
    const baseline=await page.screenshot({path:path.join(output,`${name}-baseline.png`),animations:'disabled'});
    const comparison=await page.evaluate(async({first,second})=>{
      async function pixels(encoded){const img=new Image();img.src='data:image/png;base64,'+encoded;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,img.width,img.height).data;}
      const a=await pixels(first),b=await pixels(second);let changed=0,maxDelta=0;
      for(let i=0;i<a.length;i+=4){let delta=0;for(let c=0;c<4;c++)delta=Math.max(delta,Math.abs(a[i+c]-b[i+c]));if(delta)changed++;maxDelta=Math.max(maxDelta,delta);}
      return {changed,maxDelta,pixels:a.length/4};
    },{first:current.toString('base64'),second:baseline.toString('base64')});
    // Chromium can round a few blurred shadow pixels by one channel unit after stylesheet replacement.
    assert(comparison.maxDelta<=1&&comparison.changed/comparison.pixels<=0.005,`${name}: removing obsolete CSS changed the screenshot: ${JSON.stringify(comparison)}`);
  }finally{await page.locator(selector).evaluate((el,css)=>{el.textContent=css;},original);}
  check(`${name}: cleaned CSS matches baseline (at most 1/255 shadow rounding on 0.5% of pixels)`);
}
let previewFault='',batchFault='';
await page.route(api+'/v1/translation-previews',async route=>{
  const fault=previewFault;previewFault='';
  if(fault==='network')return route.abort('failed');
  const response=await route.fetch();
  if(fault==='rights'||fault==='config'){
    const body=await response.json();if(fault==='rights')body.entitlement_version="changed-entitlement";else body.config_version='internal-version-changed';
    return route.fulfill({response,json:body});
  }
  return route.fulfill({response});
});
await page.route(api+'/v1/translation-batches',async route=>{
  const key=route.request().headers()['idempotency-key'];const fault=batchFault;batchFault='';
  if(fault==='quota')return route.fulfill({status:409,json:{error:{code:'DAILY_QUOTA_EXHAUSTED',message:'测试额度暂不足'}}});
  const response=await route.fetch();batches.push({key,status:response.status()});
  if(fault==='unknown')return route.abort('failed');
  return route.fulfill({response});
});
try{
  await page.goto(web);
  await page.evaluate(({api,auth})=>{
    localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'classic',layout:'single',autoAhead:0}));
    localStorage.setItem('nc-session',JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api}));
  },{api,auth});
  await page.reload();
  await page.getByLabel('外观与设置').click();
  const concurrency=page.getByLabel('本机请求并发');await concurrency.fill('3');await concurrency.blur();
  assert.equal(queueWrites.length,0,'local concurrency must not change account queue');
  assert.equal(await page.getByLabel('账户翻译队列并发').count(),0);
  await compareStyles('preferences-desktop');
  await page.setViewportSize({width:700,height:900});await compareStyles('preferences-narrow');
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  check('local transfer preference is independent of read-only plan concurrency');
  const samples=Array.from({length:12},(_,i)=>path.join(process.env.UI_FIXTURE_DIRECTORY,'pages',`page-${String(i+1).padStart(2,'0')}.png`));
  await page.locator('input[type=file]').setInputFiles(samples);
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-book').first().getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.getByLabel('跳转页码').waitFor();await enabled(false);
  await page.getByLabel('打开目录').click();await page.getByRole('tab',{name:/本话页面/}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.nc-thumb-list img')].length>0&&[...document.querySelectorAll('.nc-thumb-list img')].every(img=>img.complete));
  await compareStyles('thumbnail-directory');await page.getByLabel('关闭面板').click();
  await page.getByRole('switch',{name:'自动翻译',exact:true}).click();await compareStyles('automatic-confirmation');
  if(!process.env.UI_ONLY){
  await page.getByRole('button',{name:'确认',exact:true}).click();
  await waitFor(()=>batches.length===1,'initial submission');await enabled(true);check('first enable confirms once and submits');
  await page.getByRole('button',{name:'AI 重绘本页',exact:true}).click();await page.getByRole('dialog').waitFor();await enabled(true);
  await page.getByLabel('关闭弹窗').click();await enabled(true);check('manual page preview/cancel preserves automatic switch');
  await jump(2);await waitFor(()=>batches.length===2,'next page after manual quote');
  await page.getByLabel('返回我的漫画').click();const count=batches.length;await new Promise(r=>setTimeout(r,1800));assert.equal(batches.length,count);
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-01',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await enabled(true);assert.equal(await page.getByLabel('跳转页码').inputValue(),'2');
  await page.reload();await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-01',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await enabled(true);await jump(3);await waitFor(()=>batches.length===3,'resume after reload');check('back/reopen/reload remembers consent and position');
  previewFault='network';await jump(4);await page.getByText(/自动翻译暂缓：/).waitFor();await enabled(true);
  assert.equal(await page.locator('dialog[open]').count(),0);await page.screenshot({path:path.join(output,'network-pause.png')});
  await waitFor(()=>batches.length===4,'automatic retry after transient quote failure');check('transient quote failure auto-recovers without dialog');
  previewFault='config';await jump(5);await waitFor(()=>batches.length===5,'unchanged-entitlement config change');await enabled(true);check('internal output-config change with unchanged entitlement continues');
  batchFault='quota';await jump(6);await page.getByText(/测试额度暂不足/).waitFor();await enabled(true);assert.equal((await pending()).length,0);
  await waitFor(()=>batches.length===6,'quota retry');check('known quota rejection keeps switch and retries without pending uncertainty');
  batchFault='unknown';await jump(7);await page.getByText(/自动翻译暂缓：提交结果待核实/).waitFor();await enabled(true);
  const saved=(await pending())[0];assert(saved);assert.equal(await page.locator('dialog[open]').count(),0);
  await page.reload();await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-01',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await enabled(true);
  assert.equal(await page.locator('dialog[open]').count(),0);assert.equal((await pending())[0].key,saved.key);
  const unknownCount=batches.length;await jump(8);await new Promise(r=>setTimeout(r,1800));assert.equal(batches.length,unknownCount);
  await page.getByRole('button',{name:'处理并继续'}).click();await page.getByRole('button',{name:/确认并开始/}).click();
  await waitFor(()=>batches.filter(b=>b.key===saved.key).length===2,'same idempotency verification');
  await waitFor(()=>batches.length===unknownCount+2,'continue reading after verification');assert.equal((await pending()).length,0);check('unknown submission blocks new jobs, verifies same key, then resumes');
  previewFault='rights';await jump(9);await page.getByText(/账户权益已变化/).waitFor();await enabled(true);
  const before=batches.length;await new Promise(r=>setTimeout(r,1800));assert.equal(batches.length,before);await page.screenshot({path:path.join(output,'rights-pause.png')});check('entitlement change visibly pauses without switching off or submitting');
  await page.getByRole('switch',{name:'自动翻译',exact:true}).click();await enabled(false);await page.reload();
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-01',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await enabled(false);check('explicit off stays off after reload');
  // Re-enable, then import a different book; no second approval dialog is needed.
  await page.getByRole('switch',{name:'自动翻译',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();
  await waitFor(()=>batches.length===before+1,'re-enable');await page.getByLabel('返回我的漫画').click();
  await page.locator('input[type=file]').setInputFiles(path.join(process.env.UI_FIXTURE_DIRECTORY,'pages','page-24.png'));
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-24',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.getByLabel('跳转页码').waitFor();await enabled(true);await waitFor(()=>batches.length===before+2,'new book automatically translates');
  check('switching books retains approved auto translation');
  await page.waitForFunction(()=>!!document.querySelector('.nc-page-image[data-result-job]:not([data-result-job="original"])'),null,{timeout:30000});
  await page.locator('[aria-label="本页查看方式"] button').filter({hasText:'常规翻译'}).waitFor();
  await page.screenshot({path:path.join(output,'reading-resumed.png')});
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('nc-settings'));s.layout='continuous';localStorage.setItem('nc-settings',JSON.stringify(s));});
  await page.reload();
  previewFault='network';
  await page.locator('input[type=file]').setInputFiles(path.join(process.env.UI_FIXTURE_DIRECTORY,'pages','page-23.png'));
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'page-23',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.getByText(/自动翻译暂缓：/).waitFor();
  await page.locator('.nc-reading-viewport').evaluate(el=>{el.scrollTop=450;el.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>!!document.querySelector('.nc-page-image[data-result-job]:not([data-result-job="original"])'),null,{timeout:35000});
  assert(Math.abs(await page.locator('.nc-reading-viewport').evaluate(el=>el.scrollTop)-450)<4,'continuous reading position survives pause removal and result switch');
  await page.screenshot({path:path.join(output,'continuous-position.png')});check('continuous scroll position survives retry and translated image replacement');
  }else{await page.getByLabel('关闭弹窗').click();}
  await page.getByLabel('返回我的漫画').click();await compareStyles('library');
  assert.deepEqual(errors,[]);check(process.env.UI_ONLY?'UI smoke checks completed without browser exceptions':'translated image displayed and no browser exceptions');
  await writeFile(path.join(output,process.env.UI_ONLY?'ui-results.json':'results.json'),JSON.stringify({checks,errors,batchRequests:batches.length,uniqueSubmissionKeys:new Set(batches.map(b=>b.key)).size,supplier:'synthetic'},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});console.error((await page.locator('body').innerText()).slice(-2200));throw error;}
finally{await browser.close();}
