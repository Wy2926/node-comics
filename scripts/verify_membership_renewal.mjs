// Uses the isolated extension billing fixture on port 5192; never opens payment pages.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve('artifacts/membership-renewal');await mkdir(output,{recursive:true});
const browser=await chromium.launch({...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'}),headless:true});
const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
if(process.env.TEST_VITE_ORIGIN){
  const server=new URL(process.env.TEST_VITE_ORIGIN);
  assert.equal(server.protocol,'http:');assert.equal(server.hostname,'127.0.0.1');
  await page.route('http://127.0.0.1:5192/**',async route=>{
    const target=new URL(route.request().url());target.host=server.host;
    await route.fulfill({response:await route.fetch({url:target.href})});
  });
}
const visit=async scenario=>{
  await page.goto('http://127.0.0.1:5192/tests/billing-checkout-fixture.html?scenario='+scenario);
  await page.getByText('赠送会员 30 天',{exact:true}).waitFor();
};
const screenshot=name=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
try{
  for(const scenario of ['gift-pending','gift-scheduled','gift-active']){
    await visit(scenario);
    assert.equal(await page.getByRole('button',{name:'前往安全结账',exact:true}).count(),0);
    assert.equal(await page.getByText(/^下次续费：/).count(),0);
    await page.getByText(scenario==='gift-pending'?'续费延期处理中，请刷新查看。':'赠送期间不扣款，结束后恢复自动续费。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'管理订阅',exact:true}).count(),1);
    await screenshot(scenario);
  }
  await page.getByRole('button',{name:'取消自动续费',exact:true}).click();
  await page.getByRole('button',{name:'保留自动续费',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'确认取消续费',exact:true}).count(),0);
  await page.getByRole('button',{name:'取消自动续费',exact:true}).click();
  await page.getByRole('button',{name:'确认取消续费',exact:true}).click();
  await page.getByText('已关闭自动续费，已付款及赠送权益保留。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'取消自动续费',exact:true}).count(),0);
  await page.getByText('赠送会员 30 天',{exact:true}).waitFor();
  await page.getByRole('button',{name:'刷新权益',exact:true}).click();
  await page.getByText('已关闭自动续费，已付款及赠送权益保留。',{exact:true}).waitFor();
  await screenshot('gift-canceled');
  for(const [scenario,message] of [['gift-canceling','正在取消续费，请刷新查看。'],['gift-resuming','正在恢复续费，请刷新查看。'],['gift-attention','续费安排需要核实，请刷新或联系支持。']]){
    await visit(scenario);await page.getByText(message,{exact:true}).waitFor();assert.equal(await page.getByText(/^预计恢复续费：/).count(),0);
    if(scenario==='gift-canceling')assert.equal(await page.getByRole('button',{name:'取消自动续费',exact:true}).count(),0);
  }
  await visit('gift-cancel-lost');await page.getByRole('button',{name:'取消自动续费',exact:true}).click();await page.getByRole('button',{name:'确认取消续费',exact:true}).click();
  await page.getByRole('alert').waitFor();assert(await page.getByRole('button',{name:'取消自动续费',exact:true}).isEnabled());await screenshot('gift-cancel-lost');
  await page.getByRole('button',{name:'刷新权益',exact:true}).click();await page.getByText('已关闭自动续费，已付款及赠送权益保留。',{exact:true}).waitFor();
  await visit('gift-only');
  assert.equal(await page.getByRole('link',{name:'前往定价页面',exact:true}).getAttribute('href'),'https://comics.nodelane.net/pricing/');
  assert.equal(await page.getByRole('button',{name:'前往安全结账',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'管理订阅',exact:true}).count(),0);
  await screenshot('gift-only');
  await page.setViewportSize({width:390,height:844});await visit('gift-active');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('gift-mobile');
  assert.deepEqual(errors,[]);
  console.log('PASS: pending/scheduled/active gift, deferred billing date, cancellation confirmation and refresh, shared pricing destination, narrow viewport; no external payment requests. Screenshots: '+output);
}finally{await browser.close();}
