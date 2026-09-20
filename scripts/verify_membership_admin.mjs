// Isolated real APIs + Chrome. Synthetic image provider; no payment or production data.
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const adminApi=process.env.ADMIN_FIXTURE_URL||'http://127.0.0.1:18094';
const out=path.resolve('artifacts/membership-updates'); await mkdir(out,{recursive:true});
const checks=[], errors=[];
const check=message=>{checks.push(message);console.log('PASS '+message);};
async function request(base,route,auth,body) {
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
    ...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(body?{'Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert(response.ok,await response.clone().text());return response.json();
}
const browser=await chromium.launch({headless:true,channel:'chrome'});
const adminPage=await browser.newPage({viewport:{width:1440,height:1000}});
for(const p of [adminPage])p.on('pageerror',e=>errors.push(e.message));
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
  await selectOption(adminPage.getByLabel('赠送类型',{exact:true}),'quota');
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

  await adminPage.setViewportSize({width:1440,height:1000});
  await adminPage.getByRole('link',{name:'系统设置',exact:true}).click();
  await adminPage.locator('#free_images_per_minute').waitFor();
  assert.equal(await adminPage.locator('#free_images_per_minute').inputValue(),'30');
  assert.equal(await adminPage.locator('#plus_images_per_minute').inputValue(),'100');
  await adminPage.locator('#free_images_per_minute').fill('31');
  await adminPage.locator('#plus_images_per_minute').fill('101');
  await adminPage.getByRole('button',{name:'保存系统设置',exact:true}).click();
  await adminPage.locator('.settings-notice').waitFor();
  await adminPage.reload();
  await adminPage.locator('#free_images_per_minute').waitFor();
  assert.equal(await adminPage.locator('#free_images_per_minute').inputValue(),'31');
  assert.equal(await adminPage.locator('#plus_images_per_minute').inputValue(),'101');
  assert.equal((await request(adminApi,'/v1/me/entitlements',target)).image_rate_limit.limit,101);
  await screenshot(adminPage,'minute-settings');
  check('Minute limits save durably in admin and immediately apply to user entitlements');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));
}catch(error){await screenshot(adminPage,'admin-failure');throw error;}
finally{await browser.close();}
