// Chrome + isolated real API/control worker. Synthetic redraw only; no external supplier calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {completeLocalImport} from './local_import_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const api='http://127.0.0.1:18089',web='http://127.0.0.1:5174';
const fixture=path.resolve(process.env.UI_FIXTURE_DIRECTORY||'');
assert(path.basename(fixture).startsWith('nc-reader-ui-'),'Use the isolated UI fixture directory');
const out=path.resolve('artifacts/membership-validation');await mkdir(out,{recursive:true});
const checks=[],errors=[],submissions=[];
const check=text=>{checks.push(text);console.log('PASS '+text);};
async function request(route,auth,body){
  const response=await fetch(api+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
    ...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(body?{'Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert(response.ok,await response.clone().text());return response.json();
}
const auth=await request('/v1/auth/dev',null,{username:'membership-'+randomUUID().slice(0,8)});
const admin=await request('/v1/auth/dev',null,{username:'admin'});
const rights=()=>request('/v1/me/entitlements',auth);
const queues=async()=>(await request('/v1/me/queues',auth)).items;
await writeFile(path.join(fixture,'controls.json'),JSON.stringify({delay:.3,outcome:'success'}));
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'})});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.url()===api+'/v1/translation-submissions'&&response.request().method()==='POST'&&response.status()===202)submissions.push(response);});
const screenshot=async name=>page.screenshot({path:path.join(out,name+'.png'),animations:'disabled',fullPage:true});
async function waitFor(predicate,label){const end=Date.now()+45000;while(!await predicate()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,200));}}
async function refresh(){await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}
async function openBook(){
  await page.getByRole('button',{name:'我的漫画',exact:true}).click();
  await page.locator('.nc-shelf-detail').first().click();
  await page.getByRole('tab',{name:'卷册',exact:true}).click();
  await page.getByRole('button',{name:'阅读',exact:true}).first().click();
  await page.getByLabel('跳转页码').waitFor();
}
try{
  await page.goto(web);
  await page.evaluate(({api,auth})=>{
    localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'redraw',layout:'single'}));
    localStorage.setItem('nc-session',JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api}));
  },{api,auth});
  await page.reload();await page.locator('.nc-account-button').click();
  await page.getByRole('heading',{name:'普通用户',exact:true}).waitFor();
  const ordinary=await rights();
  assert.equal(ordinary.modes.classic.quota.available,100);assert.equal(ordinary.modes.redraw.allowed,false);
  assert((await queues()).every(queue=>queue.capacity===10&&queue.realtime_limit===2));
  await screenshot('ordinary-account');check('Ordinary account: 100 daily classic pages, independent 10/2 mode queues');
  await page.getByLabel('外观与设置').click();
  const transfer=page.getByLabel('本机请求并发');await transfer.fill('3');await transfer.blur();
  assert((await queues()).every(queue=>queue.capacity===10&&queue.realtime_limit===2));
  await screenshot('plan-queues');check('Local transfer preference leaves server queue capacity and realtime slots unchanged');

  await request(`/v1/admin/users/${auth.user.id}/quota-grants`,admin,{mode:'redraw',pages:1,
    expires_at:new Date(Date.now()+3600000).toISOString(),note:'isolated browser acceptance'});
  await refresh();
  assert.equal((await rights()).plan,'free');assert.equal((await rights()).modes.redraw.allowed,true);
  assert((await queues()).every(queue=>queue.realtime_limit===2));
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles(path.join(fixture,'pages','page-01.png'));
  await page.getByLabel('内容归属',{exact:true}).selectOption('publication');
  await completeLocalImport(page);await openBook();
  await page.getByRole('button',{name:/^AI 重绘本页/}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.match(await dialog.innerText(),/本次最多新建 1 页任务/);
  await screenshot('gift-redraw-confirm');
  await page.getByRole('button',{name:'确认并加入上传清单 · 最多 1 页',exact:true}).click();
  await waitFor(()=>submissions.length===1,'one durable submission');
  await waitFor(async()=>(await rights()).modes.redraw.quota.used===1,'gift redraw settlement');
  assert.equal(await page.getByLabel('跳转页码').inputValue(),'1');
  assert((await queues()).every(queue=>queue.in_flight===0));
  check('Explicitly confirmed gift redraw uploads durably, settles once, releases capacity and preserves reading position');

  await page.getByLabel('返回我的漫画',{exact:true}).click();await page.locator('.nc-account-button').click();
  await request(`/v1/admin/users/${auth.user.id}/membership`,admin,{months:12,note:'isolated annual membership'});
  await refresh();await page.getByRole('heading',{name:'PLUS 会员',exact:true}).waitFor();
  const plus=await rights();assert.equal(plus.modes.classic.unlimited,true);
  assert.equal(plus.modes.redraw.quota.buckets.find(bucket=>bucket.source==='membership').granted,300);
  assert((await queues()).every(queue=>queue.capacity===500&&queue.realtime_limit===10));
  assert(plus.scheduler_weight>ordinary.scheduler_weight);
  await screenshot('plus-account');await page.setViewportSize({width:390,height:844});await screenshot('plus-account-narrow');await page.setViewportSize({width:1440,height:1000});
  check('PLUS exposes unlimited classic, monthly 300 redraw pages, independent 500/10 queues and configured higher weight');

  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.getByRole('button',{name:'用量统计',exact:true}).click();
  await page.getByRole('heading',{name:'用量统计',exact:true}).waitFor();
  assert.equal((await request('/v1/me/usage/summary',auth)).delivered,1);
  await screenshot('usage');check('Successful gift delivery remains visible after membership upgrade');
  await page.evaluate(({api,admin})=>localStorage.setItem('nc-session',JSON.stringify({token:admin.access_token,user:admin.user,apiOrigin:api})),{api,admin});
  await page.goto(web+'/#admin');await page.reload();
  await page.getByRole('button',{name:'用户与额度',exact:true}).click();
  await page.locator('.setting-row').filter({hasText:auth.user.name}).getByRole('button',{name:'管理会员与额度'}).click();
  await page.getByLabel('会员月数').fill('1');await page.getByLabel('操作备注').fill('Browser renewal verification');
  const previous=(await rights()).plus_expires_at;
  await page.getByRole('button',{name:'确认操作',exact:true}).click();
  await page.getByText('操作已记录；相同操作编号重试不会重复发放。',{exact:true}).waitFor();
  const renewed=(await rights()).plus_expires_at;assert(renewed>previous);
  await page.getByRole('button',{name:'确认操作',exact:true}).click();
  await waitFor(async()=>(await rights()).plus_expires_at===renewed,'idempotent admin renewal');
  await screenshot('admin-membership');check('Administrator renewal remains idempotent through the UI');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,supplier:'synthetic redraw',backend:'isolated SQLite/API/control worker'},null,2));
}catch(error){await screenshot('failure');console.error((await page.locator('body').innerText()).slice(-3500));throw error;}
finally{await browser.close();}
