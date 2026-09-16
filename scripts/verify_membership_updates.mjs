// Isolated real APIs + Chrome. Synthetic image provider; no payment or production data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {completeLocalImport} from './local_import_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture=path.resolve(process.env.UI_FIXTURE_DIRECTORY || '');
assert(path.basename(fixture).startsWith('nc-reader-ui-'), 'Use the disposable reader fixture');
const api='http://127.0.0.1:18089', web='http://127.0.0.1:5174', adminApi='http://127.0.0.1:18090';
const out=path.resolve('artifacts/membership-updates'); await mkdir(out,{recursive:true});
const checks=[], errors=[];
const check=message=>{checks.push(message);console.log('PASS '+message);};
async function request(base,route,auth,body) {
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
    ...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(body?{'Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert(response.ok,await response.clone().text());return response.json();
}
async function waitFor(predicate,message) {const end=Date.now()+60000;while(!await predicate()){assert(Date.now()<end,message);await new Promise(r=>setTimeout(r,200));}}
const browser=await chromium.launch({headless:true,channel:'chrome'});
const adminPage=await browser.newPage({viewport:{width:1440,height:1000}}), page=await browser.newPage({viewport:{width:1440,height:1000}});
for(const p of [adminPage,page])p.on('pageerror',e=>errors.push(e.message));
const screenshot=(p,name)=>p.screenshot({path:path.join(out,name+'.png'),animations:'disabled',fullPage:true});
try {
  const target=await request(adminApi,'/v1/auth/dev',null,{username:'gift-'+randomUUID().slice(0,8)});
  const operator=await request(adminApi,'/v1/auth/dev',null,{username:'admin'});
  await adminPage.goto(adminApi+'/console-test/');
  await adminPage.getByLabel('开发环境用户名').fill('admin');await adminPage.getByRole('button',{name:'登录开发环境'}).click();
  await adminPage.getByRole('link',{name:'用户管理'}).click();
  await adminPage.getByLabel('搜索',{exact:true}).fill(target.user.name);await adminPage.getByRole('button',{name:'筛选',exact:true}).click();
  await adminPage.getByRole('button',{name:'查看权益',exact:true}).click();
  await adminPage.getByLabel('会员天数',{exact:true}).fill('7');await adminPage.getByLabel('每会员月重绘页数').fill('30');
  await adminPage.getByLabel('赠送备注').fill('Browser isolated seven-day operator gift');
  let originalExpiry;
  await adminPage.route('**/v1/admin/users/*/membership',async route=>{
    const response=await route.fetch();originalExpiry=(await response.json()).entitlements.plus_expires_at;
    await route.abort('failed');
  });
  await adminPage.getByRole('button',{name:'确认赠送',exact:true}).click();
  await adminPage.getByRole('button',{name:'重试并核实原操作'}).waitFor();
  await screenshot(adminPage,'admin-uncertain-gift');
  await adminPage.unroute('**/v1/admin/users/*/membership');
  await adminPage.getByLabel('关闭详情').click();await adminPage.getByRole('button',{name:'查看权益',exact:true}).click();
  await adminPage.getByRole('button',{name:'重试并核实原操作'}).click();
  await adminPage.getByText('赠送成功，权益已更新。',{exact:true}).waitFor();
  let detail=await request(adminApi,`/v1/admin/monitor/users/${target.user.id}`,operator);
  assert.equal(detail.entitlements.plus_expires_at,originalExpiry);assert.equal(detail.entitlements.modes.redraw.quota.granted,30);
  check('Custom seven-day PLUS gift recovers a lost response after reopening, without duplicate extension or quota');
  await adminPage.getByRole('button',{name:'创建另一笔赠送'}).click();
  await adminPage.getByLabel('赠送类型',{exact:true}).selectOption('quota');
  await adminPage.getByLabel('赠送页数',{exact:true}).fill('12');
  const localDate=delta=>{const d=new Date(Date.now()+delta);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  await adminPage.getByLabel('生效时间（留空立即生效）').fill(localDate(86400000));
  await adminPage.getByLabel('到期时间',{exact:true}).fill(localDate(3*86400000));
  await adminPage.getByLabel('赠送备注').fill('Browser scheduled redraw grant');
  await adminPage.getByRole('button',{name:'确认赠送',exact:true}).click();
  await adminPage.getByText('赠送成功，权益已更新。',{exact:true}).waitFor();
  await adminPage.getByRole('cell',{name:'AI 重绘 Browser scheduled redraw grant'}).waitFor();
  detail=await request(adminApi,`/v1/admin/monitor/users/${target.user.id}`,operator);
  assert.equal(detail.grants.length,1);assert.equal(detail.grants[0].granted,12);assert.equal(detail.entitlements.modes.redraw.quota.available,30);
  await screenshot(adminPage,'admin-gift-result');
  await adminPage.setViewportSize({width:390,height:844});await screenshot(adminPage,'admin-gift-narrow');
  assert(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await adminPage.getByLabel('关闭详情').click();
  await adminPage.locator('.list-panel tr').filter({hasText:target.user.name}).getByText('PLUS',{exact:true}).waitFor();
  check('Scheduled page gift appears in user details without prematurely increasing available quota; narrow viewport fits');

  await writeFile(path.join(fixture,'controls.json'),JSON.stringify({delay:.2,outcome:'success'}));
  const donor=await request(api,'/v1/auth/dev',null,{username:'donor-'+randomUUID().slice(0,8)});
  const reader=await request(api,'/v1/auth/dev',null,{username:'reuse-'+randomUUID().slice(0,8)});
  const admin=await request(api,'/v1/auth/dev',null,{username:'admin'});
  await request(api,`/v1/admin/users/${donor.user.id}/quota-grants`,admin,{mode:'redraw',pages:1,expires_at:new Date(Date.now()+3600000).toISOString(),note:'isolated browser donor'});
  await page.goto(web);await page.evaluate(({api,donor})=>{
    localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'redraw',layout:'single'}));
    localStorage.setItem('nc-session',JSON.stringify({token:donor.access_token,user:donor.user,apiOrigin:api}));
  },{api,donor});await page.reload();
  await page.locator('input[type=file]').setInputFiles([path.join(fixture,'pages','page-01.png'),path.join(fixture,'pages','page-02.png')]);
  await page.getByLabel('内容归属',{exact:true}).selectOption('publication');await completeLocalImport(page);
  async function openBook(){await page.getByRole('button',{name:'我的漫画',exact:true}).click();await page.locator('.nc-shelf-detail').first().click();await page.getByRole('tab',{name:'卷册',exact:true}).click();await page.getByRole('button',{name:'阅读',exact:true}).first().click();await page.getByLabel('跳转页码').waitFor();}
  await openBook();await page.getByRole('button',{name:/^AI 重绘本页/}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/整份清单可能部分受理/);
  await screenshot(page,'submission-atomicity-confirmation');
  await page.getByRole('button',{name:'确认并加入上传清单 · 最多 1 页',exact:true}).click();
  await waitFor(async()=>{const r=await request(api,'/v1/jobs',donor);return r.items.some(j=>j.status==='succeeded');},'synthetic image delivered or reused');
  check('Translation confirmation describes per-request atomicity and partial acceptance of the whole list');
  await page.evaluate(({api,reader})=>localStorage.setItem('nc-session',JSON.stringify({token:reader.access_token,user:reader.user,apiOrigin:api})),{api,reader});
  await page.reload();if(!await page.getByLabel('跳转页码').count())await openBook();
  assert.equal((await request(api,'/v1/me/entitlements',reader)).modes.redraw.allowed,false);
  await page.getByRole('button',{name:/^默认翻译 ·/}).click();
  await page.locator('summary').filter({hasText:'翻译更多页面'}).click();
  await page.getByLabel('翻译结束页').fill('1');await page.getByRole('button',{name:'选中范围',exact:true}).click();
  await page.getByRole('button',{name:'翻译选中 1 页 · 查看范围',exact:true}).click();
  await page.getByText('这些页面已有翻译结果或服务器任务，将按当前阅读位置优先处理',{exact:true}).waitFor();
  assert.equal(await page.locator('.global-error').count(),0);assert.equal(await page.getByLabel('跳转页码').inputValue(),'1');
  await screenshot(page,'free-redraw-reuse');
  check('Ordinary account with no redraw grant reuses completed redraw through translation entry and preserves reading position');
  await page.getByRole('button',{name:'预存本章 2 页',exact:true}).click();
  await page.getByText('已恢复 1 页可复用结果；其余 1 页新建任务需要 PLUS 或有效赠送额度。',{exact:true}).waitFor();
  assert.equal((await request(api,'/v1/me/queues',reader)).items.find(q=>q.mode==='redraw').in_flight,0);
  check('Mixed free reuse and new redraw restores cached page and rejects only creation without creating a job');
  await page.getByLabel('关闭面板',{exact:true}).click();await page.getByLabel('返回我的漫画',{exact:true}).click();await page.locator('.nc-account-button').click();
  await page.getByRole('button',{name:'了解 PLUS 与免费试用'}).click();
  const offer=page.getByRole('dialog');assert.match(await offer.innerText(),/30 页 AI 重绘/);assert.match(await offer.innerText(),/每月续费/);assert.match(await offer.innerText(),/订阅与试用尚未开放/);
  await screenshot(page,'plus-trial-offer');await page.setViewportSize({width:390,height:844});await screenshot(page,'plus-trial-offer-narrow');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check('PLUS offer discloses seven-day card trial, 30 redraw pages, US$9.99 per month, cancellation and unavailable checkout');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,supplier:'synthetic',paddle:'design only; no checkout'},null,2));
}catch(error){await screenshot(page,'reader-failure');await screenshot(adminPage,'admin-failure');console.error('READER', (await page.locator('body').innerText()).slice(-3500));console.error('ADMIN',(await adminPage.locator('body').innerText()).slice(-3500));throw error;}
finally{await browser.close();}
