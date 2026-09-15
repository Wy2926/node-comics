// Chrome + isolated real API/worker check. Requires tests/manual_ui_server.py and Vite :5174.
// Synthetic supplier only. The quota preload touches only that fixture's temporary SQLite file.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {completeLocalImport} from './local_import_helpers.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const api='http://127.0.0.1:18089',web='http://127.0.0.1:5174';
const fixture=path.resolve(process.env.UI_FIXTURE_DIRECTORY||'');
assert(path.basename(fixture).startsWith('nc-reader-ui-'),'Use the isolated UI fixture directory');
const out=path.resolve('artifacts/membership-validation');await mkdir(out,{recursive:true});
const checks=[],errors=[],batches=[];
const check=text=>{checks.push(text);console.log('PASS '+text);};
async function request(route,auth,body){
  const response=await fetch(api+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
    ...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(body?{'Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert(response.ok,await response.clone().text());return response.json();
}
const auth=await request('/v1/auth/dev',null,{username:'membership-'+randomUUID().slice(0,8)});
const admin=await request('/v1/auth/dev',null,{username:'admin'});
const rights=()=>request('/v1/me/entitlements',auth);
const gift=(mode,pages)=>request(`/v1/admin/users/${auth.user.id}/quota-grants`,admin,
  {mode,pages,expires_at:new Date(Date.now()+3600000).toISOString(),note:'isolated browser acceptance'});
await writeFile(path.join(fixture,'controls.json'),JSON.stringify({delay:.3,outcome:'success'}));
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'})});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.url()===api+'/v1/translation-batches'&&response.status()===202)batches.push(response);});
const screenshot=async name=>{const close=page.locator('.toast button');if(await close.count())await close.click();return page.screenshot({path:path.join(out,name+'.png'),animations:'disabled',fullPage:true});};
async function waitFor(predicate,label){const end=Date.now()+45000;while(!await predicate()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,200));}}
async function jump(number){const input=page.getByLabel('跳转页码');await input.fill(String(number));await input.press('Enter');await input.blur();}
async function refresh(){await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}
async function openBook(){await page.locator('.nc-book').first().getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await page.getByLabel('跳转页码').waitFor();}
try{
  await page.goto(web);
  await page.evaluate(({api,auth})=>{
    localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'classic',layout:'single',autoAhead:2}));
    localStorage.setItem('nc-session',JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api}));
  },{api,auth});
  await page.reload();await page.locator('.nc-account-button').click();
  await page.locator('.nc-stat b').filter({hasText:'100'}).waitFor();
  assert.equal((await rights()).modes.redraw.allowed,false);await screenshot('ordinary-account');
  check('Ordinary account: 100 daily pages, no baseline redraw, shared concurrency 2');
  await page.getByLabel('外观与设置').click();
  assert.equal(await page.getByLabel('账户翻译队列并发').count(),0);
  const transfer=page.getByLabel('本机请求并发');await transfer.fill('3');await transfer.blur();
  assert.equal((await request('/v1/me/queue',auth)).concurrency,2);await screenshot('plan-concurrency');
  check('Server concurrency is read-only; local transfer preference remains independent');
  // Two pages remain in this ordinary user's daily bucket, without running 98 synthetic jobs.
  const bucket=(await rights()).modes.classic.quota.buckets[0];
  const preload=spawnSync(process.env.TEST_PYTHON||'backend/.venv/Scripts/python.exe',['-c',
    "import sqlite3,sys,json; b=json.loads(sys.argv[2]); c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO quota_periods (id,owner_id,kind,mode,source,source_key,note,grants_access,starts_at,ends_at,granted,used,reserved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(b['id'],sys.argv[3],'classic_daily','classic','daily','classic_daily:'+b['starts_at'],'isolated preload',0,b['starts_at'].replace('T',' ').rstrip('Z'),b['expires_at'].replace('T',' ').rstrip('Z'),100,98,0)); c.commit()",
    path.join(fixture,'test.sqlite'),JSON.stringify(bucket),auth.user.id],{encoding:'utf8'});
  assert.equal(preload.status,0,preload.stderr);
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles([1,2,3,4].map(n=>path.join(fixture,'pages',`page-${String(n).padStart(2,'0')}.png`)));
  await completeLocalImport(page);await openBook();
  await page.getByRole('button',{name:'翻译本页',exact:true}).click();
  await waitFor(()=>batches.length===1,'single classic submit');
  assert.equal(await page.getByRole('dialog').count(),0);
  await waitFor(async()=>(await rights()).modes.classic.quota.used===99,'single classic settlement');
  assert.equal(await page.getByLabel('跳转页码').inputValue(),'1');
  check('Single classic page starts immediately and settles one page without a confirmation modal');
  await page.getByRole('switch',{name:'自动翻译',exact:true}).click();
  await page.getByRole('button',{name:'确认',exact:true}).click();
  await waitFor(()=>batches.length===2,'automatic window trimmed to the last available page');
  await page.getByText(/翻译额度已用完/).waitFor({timeout:45000});
  assert.equal((await rights()).modes.classic.quota.available,0);
  assert.equal(await page.getByRole('switch',{name:'自动翻译',exact:true}).getAttribute('aria-checked'),'true');
  await screenshot('automatic-exhausted');check('Automatic window trims to quota and pauses without switching off or creating extra work');
  await gift('classic',2);await refresh();
  await waitFor(()=>batches.length===3,'new gift resumes the previously approved window before daily reset');
  await page.getByRole('switch',{name:'自动翻译',exact:true}).click();
  assert.equal(await page.getByLabel('跳转页码').inputValue(),'1');
  check('New valid classic gift resumes the paused reader and preserves its page position');
  await gift('redraw',1);await refresh();
  await page.getByRole('button',{name:'AI 重绘本页',exact:true}).click();
  await page.getByRole('dialog').waitFor();await screenshot('gift-redraw-preview');
  assert.match(await page.getByRole('dialog').innerText(),/最多 1 页额度/);
  await page.getByRole('button',{name:/确认并开始/}).click();
  await waitFor(async()=>(await rights()).modes.redraw.quota.used===1,'gift redraw success');
  assert.equal((await rights()).plan,'free');
  check('Ordinary user can explicitly confirm a one-page redraw using a temporary gift');
  await page.getByLabel('返回我的漫画').click();await page.locator('.nc-account-button').click();
  await page.getByText('查看赠送额度与到期时间').last().click();await screenshot('gift-account');
  await request(`/v1/admin/users/${auth.user.id}/membership`,admin,{months:12,note:'isolated annual membership'});await refresh();
  await page.getByRole('heading',{name:'PLUS 会员',exact:true}).waitFor();
  const plus=await rights();assert.equal(plus.modes.classic.unlimited,true);
  assert.equal(plus.modes.redraw.quota.buckets.find(b=>b.source==='membership').granted,300);
  await screenshot('plus-account');await page.setViewportSize({width:700,height:1000});await screenshot('plus-account-narrow');await page.setViewportSize({width:1440,height:1000});
  check('Annual PLUS exposes unlimited classic and a 300-page monthly bucket, including narrow layout');
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await openBook();await jump(4);
  await page.getByRole('button',{name:'翻译本页',exact:true}).click();
  await waitFor(async()=>{const jobs=await request('/v1/jobs',auth);return jobs.items.some(j=>j.mode==='classic'&&j.settlement==='included'&&j.status==='succeeded');},'PLUS included delivery');
  await page.getByLabel('返回我的漫画').click();await page.getByRole('button',{name:'用量统计',exact:true}).click();
  await page.getByRole('heading',{name:'用量统计',exact:true}).waitFor();
  await waitFor(async()=>(await request('/v1/me/usage/summary',auth)).included_delivered>=1,'included page counted');await screenshot('usage');
  check('Unlimited classic successes appear in actual delivery statistics without reducing redraw quota');
  await page.evaluate(({api,admin})=>{localStorage.setItem('nc-session',JSON.stringify({token:admin.access_token,user:admin.user,apiOrigin:api}));},{api,admin});
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
  await screenshot('admin-membership');
  check('Administrator can renew membership in the UI; resubmitting the same operation does not grant another month');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,supplier:'synthetic',backend:'isolated SQLite/API/worker',preloadedDailyUsed:98},null,2));
}catch(error){await screenshot('failure');console.error((await page.locator('body').innerText()).slice(-3500));throw error;}
finally{await browser.close();}
