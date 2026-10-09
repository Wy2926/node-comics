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
await page.route('**/*',route=>{
 const url=new URL(route.request().url());
 if(url.origin!==new URL(origin).origin){errors.push('Blocked external request: '+url.origin);return route.abort();}
 return route.continue();
});
const settled=async()=>page.waitForFunction(()=>document.querySelector('.website-account')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.account-subscription[aria-busy="true"]'));
const visit=async query=>{await page.goto(origin+query);await settled();};
const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});};
const pricingLink=async()=>{
 assert.equal(await page.locator('.account-upgrade,.billing-plan-picker,[data-purchase-link]').count(),0);
 assert.equal(await page.locator('.account-purchase-link a').getAttribute('href'),'/pricing/');
};
const observation=async()=>JSON.parse(await page.locator('#account-fixture-observation').innerText());
const requests=async(path,count,finished=false)=>page.waitForFunction(({path,count,finished})=>{
 const raw=document.getElementById('account-fixture-observation')?.textContent;
 if(!raw)return false;
 const rows=JSON.parse(raw).requests.filter(row=>row.path===path);
 return rows.length>=count&&(!finished||rows.every(row=>typeof row.finishedMs==='number'));
},{path,count,finished});
try{
 await visit('');assert.equal(await page.locator('.account-stats,.account-detail').count(),0);await pricingLink();await shot('free');
 await visit('?price=fixture-year');await pricingLink();assert.equal(await page.getByRole('checkbox').count(),0);
 await visit('?pending=1');await pricingLink();assert.equal(await page.getByRole('checkbox').count(),0);
 await visit('?scenario=quota');await pricingLink();assert.match(await page.locator('.account-gift').innerText(),/90/);
 await visit('?pending=1&scenario=quota');await pricingLink();assert.match(await page.locator('.account-gift').innerText(),/90/);
 await visit('?scenario=active');assert.equal(await page.locator('.account-upgrade').count(),0);await page.getByText('订阅生效中',{exact:true}).waitFor();await shot('plus');await page.getByRole('button',{name:/管理订阅/}).click();await page.getByRole('alert').filter({hasText:'已验证订阅管理：stripe'}).waitFor();
 await visit('?scenario=lite');assert.equal(await page.locator('.account-plan').innerText(),'Lite');assert.match(await page.locator('.account-rate-limit').innerText(),/1,200/);assert.match(await page.locator('.account-subscription').innerText(),/59.99/);assert(!/300|PLUS/.test(await page.locator('.account-subscription').innerText()));await shot('lite');
 await visit('?scenario=canceling');assert.equal(await page.getByText('下次计费',{exact:true}).count(),0);await page.getByText('已安排取消续费',{exact:true}).waitFor();await shot('canceling');
 for(const scenario of ['gift-pending','gift-scheduled','gift-active']){
  await visit('?scenario='+scenario);assert.equal(await page.locator('.account-upgrade').count(),0);await page.getByText('赠送 PLUS 30 天',{exact:true}).waitFor();
  assert.equal(await page.getByText(/^下次续费：/).count(),0);
  await page.getByText(scenario==='gift-pending'?'续费延期处理中，请刷新查看。':'赠送期间不扣款，结束后恢复自动续费。',{exact:true}).waitFor();
  await shot(scenario);
 }
 await page.getByRole('button',{name:'取消自动续费',exact:true}).click();await page.getByRole('button',{name:'保留自动续费',exact:true}).click();assert.equal(await page.getByRole('button',{name:'确认取消续费',exact:true}).count(),0);
 await page.getByRole('button',{name:'取消自动续费',exact:true}).click();await page.getByRole('button',{name:'确认取消续费',exact:true}).click();await page.getByText('已关闭自动续费，已付款及赠送权益保留。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'取消自动续费',exact:true}).count(),0);await page.getByText('赠送 PLUS 30 天',{exact:true}).waitFor();await shot('gift-canceled');
 await visit('?scenario=gift-only');assert.equal(await page.locator('.account-upgrade').count(),0);await page.getByText('赠送结束后可开通订阅。',{exact:true}).waitFor();await shot('gift-only');
 for(const [scenario,message] of [['gift-canceling','正在取消续费，请刷新查看。'],['gift-resuming','正在恢复续费，请刷新查看。'],['gift-attention','续费安排需要核实，请刷新或联系支持。']]){
  await visit('?scenario='+scenario);await page.getByText(message,{exact:true}).waitFor();assert.equal(await page.getByText(/^预计恢复续费：/).count(),0);
  if(scenario==='gift-canceling')assert.equal(await page.getByRole('button',{name:'取消自动续费',exact:true}).count(),0);
 }
 await visit('?scenario=gift-cancel-lost');await page.getByRole('button',{name:'取消自动续费',exact:true}).click();await page.getByRole('button',{name:'确认取消续费',exact:true}).click();
 await page.getByRole('alert').waitFor();assert(await page.getByRole('button',{name:'取消自动续费',exact:true}).isEnabled());await shot('gift-cancel-lost');
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('已关闭自动续费，已付款及赠送权益保留。',{exact:true}).waitFor();
 for(const scenario of ['expired','revoked']){await visit('?scenario='+scenario);await pricingLink();}
 await visit('?scenario=disabled');await page.getByText(/订阅服务当前不可用/).waitFor();
 await visit('?scenario=error');assert(await page.locator('.account-summary').isVisible());await page.getByRole('alert').waitFor();await shot('error');
 await visit('?scenario=active&perf&meDelay=50&statusDelay=400&syncDelay=4000');
 await requests('/v1/billing/status',1,true);
 const initial=await observation(),meRead=initial.requests.find(row=>row.path==='/v1/me'),statusRead=initial.requests.find(row=>row.path==='/v1/billing/status');
 assert.deepEqual(initial.requests.map(row=>row.path).sort(),['/v1/billing/status','/v1/me']);
 assert(statusRead.startedMs<meRead.finishedMs,'Account and local billing reads must run in parallel');
 assert.equal(typeof initial.accountVisibleMs,'number');
 assert(initial.accountVisibleMs<statusRead.finishedMs,'Account must render before the delayed local billing response');
 await page.locator('.account-refresh').evaluate(button=>{button.click();button.click();});
 await requests('/v1/billing/sync',1);
 assert(await page.locator('.account-summary').isVisible(),'Manual sync must preserve the account card');
 assert(await page.locator('.account-refresh').isDisabled());
 assert(await page.getByRole('button',{name:'取消自动续费',exact:true}).isDisabled(),'Cancel must not race a manual sync');
 await requests('/v1/billing/sync',1,true);await settled();
 assert.equal((await observation()).requests.filter(row=>row.path==='/v1/billing/sync').length,1,'One user refresh produces one sync');
 await shot('account-fast-load');
 await page.locator('.account-refresh').click();await requests('/v1/billing/sync',2);
 await page.getByRole('button',{name:'模拟切换账户',exact:true}).click();
 await page.locator('.account-identity h2').filter({hasText:'界面验收 2'}).waitFor();
 await requests('/v1/billing/sync',2,true);await requests('/v1/billing/status',2,true);await settled();
 assert.equal(await page.locator('.account-identity h2').innerText(),'界面验收 2');
 assert.equal(await page.getByRole('alert').count(),0,'A stale sync failure must not clear the replacement account');
 assert.equal((await observation()).requests.filter(row=>row.path==='/v1/billing/sync').length,2,'Account switch does not automatically sync');
 await page.locator('.account-refresh').click();await requests('/v1/billing/sync',3);
 await page.getByRole('button',{name:'模拟其他标签页退出',exact:true}).click();
 await page.getByRole('button',{name:/登录 \/ 注册/}).waitFor();await requests('/v1/billing/sync',3,true);await settled();
 assert.equal(await page.locator('.account-summary').count(),0,'A stale sync cannot restore a signed-out account');
 assert.equal(await page.getByRole('alert').count(),0);
 await visit('?scenario=quota&perf&meDelay=50&statusDelay=400&syncDelay=4000&syncFail');
 await requests('/v1/billing/status',1,true);await page.locator('.account-refresh').click();
 await page.getByRole('alert').filter({hasText:'模拟支付同步超时'}).waitFor();
 assert(await page.locator('.account-summary').isVisible());assert.match(await page.locator('.account-gift').innerText(),/90/);
 assert.equal((await observation()).requests.filter(row=>row.path==='/v1/billing/sync').length,1,'Failed writes are not automatically retried');await shot('sync-failed-account-preserved');
 for(const locale of ['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id','ar']){
  for(const scenario of ['active','lite','free','gift-active','gift-pending']){
   await visit(`?locale=${locale}&scenario=${scenario}`);
   for(const width of [1200,760,390,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${locale} ${scenario} ${width} overflow`);}
  }
 }
 await page.setViewportSize({width:390,height:850});await visit('?scenario=active');await shot('mobile-plus');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:/登录 \/ 注册/}).waitFor();await shot('signed-out');
 assert.deepEqual(errors,[]);console.log('PASS: Free/Lite and existing PLUS, gifts/cancellation/recovery, disabled/error, pricing-only purchase entry, pending quote, parallel local reads/early account rendering, one manual sync, stale switch/logout responses, 17 locales/4 widths; isolated fixtures only. Screenshots: '+out);
}finally{await browser.close();}
