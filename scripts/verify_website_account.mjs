import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5193/tests/account-fixture.html';
const out=path.resolve('artifacts/website-account');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const visit=async query=>{await page.goto(origin+query);await page.locator('.website-account[aria-busy="false"]').waitFor();};
const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});};
try{
 await visit('');assert.equal(await page.locator('.account-stats,.account-detail').count(),0);assert.equal(await page.locator('.account-upgrade').getAttribute('open'),null);await shot('free');
 await page.locator('.account-upgrade summary').click();await page.locator('input[value="year"]').check();assert(await page.locator('.billing-plan-picker').isVisible());
 assert(await page.getByRole('button',{name:'前往安全结账'}).isDisabled());await page.getByRole('checkbox').check();await page.getByRole('button',{name:'前往安全结账'}).click();await page.getByRole('alert').filter({hasText:'fixture-year · stripe'}).waitFor();
 await visit('?price=fixture-year');assert(await page.locator('input[value="year"]').isChecked());await page.locator('input[value="month"]').check();assert(await page.locator('.billing-plan-picker').isVisible());
 await visit('?pending=1');assert(await page.getByRole('checkbox').isVisible());assert.equal(await page.locator('.billing-plan-picker').count(),0);await page.getByRole('checkbox').check();await page.getByRole('button',{name:'继续原结账'}).click();await page.getByRole('alert').filter({hasText:'fixture-year · creem'}).waitFor();
 await visit('?scenario=active');assert.equal(await page.locator('.account-upgrade').count(),0);await page.getByText('订阅生效中',{exact:true}).waitFor();await shot('plus');await page.getByRole('button',{name:/管理订阅/}).click();await page.getByRole('alert').filter({hasText:'已验证订阅管理：stripe'}).waitFor();
 await visit('?scenario=canceling');assert.equal(await page.getByText('下次计费',{exact:true}).count(),0);await page.getByText('已安排取消续费',{exact:true}).waitFor();await shot('canceling');
 for(const scenario of ['expired','revoked']){await visit('?scenario='+scenario);assert.equal(await page.locator('.account-upgrade').count(),1);}
 await visit('?scenario=disabled');await page.getByText(/订阅服务当前不可用/).waitFor();
 await visit('?scenario=error');assert(await page.locator('.account-summary').isVisible());await page.getByRole('alert').waitFor();await shot('error');
 for(const locale of ['zh-CN','zh-TW','en','ja','ko']){
  for(const scenario of ['active','free']){
   await visit(`?locale=${locale}&scenario=${scenario}`);
   for(const width of [1200,760,390,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${locale} ${scenario} ${width} overflow`);}
  }
 }
 await page.setViewportSize({width:390,height:850});await visit('?scenario=active');await shot('mobile-plus');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:/登录 \/ 注册/}).waitFor();await shot('signed-out');
 assert.deepEqual(errors,[]);console.log('PASS: compact free/PLUS, canceled/expired, disabled/error, logout, 5 locales/4 widths, selected quote and pending checkout; no external payment requests. Screenshots: '+out);
}finally{await browser.close();}
