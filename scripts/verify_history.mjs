// Isolated Chrome UI check. Start Vite on :5176; no backend, R2 or supplier calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',output=path.resolve('artifacts/history-validation');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html');
  await page.getByRole('button',{name:'翻译记录',exact:true}).waitFor();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now()+1000));
  await page.evaluate(()=>{
    const original=window.fetch;
    const state={status:'running',deleted:false,fail:false,hold:false,pending:undefined,calls:[]};
    window.historyFixture=state;
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    window.fetch=async(input,init)=>{
      const url=new URL(String(input),location.origin);
      if(init?.method==='DELETE'&&url.pathname==='/v1/images/output-0'){state.deleted=true;return json({deleted:true});}
      if(url.pathname!=='/v1/translation-operations')return original(input,init);
      state.calls.push(url.pathname);
      if(state.hold)await new Promise(resolve=>{state.pending=resolve;});
      if(state.fail)return new Response(JSON.stringify({error:{message:'隔离测试：记录服务暂不可用'}}),{status:503});
      const offset=Number(url.searchParams.get('offset')||0);
      return json({items:Array.from({length:13},(_,i)=>({operation_key:`history-${i}`,disposition:i===0&&state.status==='running'?'pending':'ready',created_at:'2026-09-15T00:00:00Z',job:{id:`fixture-job-${i}`,input_asset_id:`asset-${i}`,output_asset_id:(i!==0||state.status==='succeeded')&&!(i===0&&state.deleted)?`output-${i}`:null,result_available:!state.deleted,result_expired:i===0&&state.deleted,mode:'classic',target_language:'zh-Hans',status:i===0?state.status:'succeeded',phase:'translating_text',quota_pages:1,quota_kind:'classic_daily',settlement:i===0&&state.status==='running'?'reserved':'settled',version:1,cache_hit:false,created_at:'2026-09-15T00:00:00Z'}})).slice(offset,offset+12),total:13,next_offset:offset===0?12:null});
    };
  });
  const calls=()=>page.evaluate(()=>window.historyFixture.calls.length);
  await page.evaluate(()=>{window.historyFixture.hold=true;});
  await page.getByRole('button',{name:'翻译记录',exact:true}).click();
  await page.getByText('正在读取翻译记录…').waitFor();
  await page.evaluate(()=>{window.historyFixture.hold=false;window.historyFixture.pending();});
  await page.locator('.nc-history-card').first().waitFor();
  assert.equal(await page.locator('.nc-history-card').count(),12);
  const first=await calls();
  await page.clock.runFor(14_999);
  assert.equal(await calls(),first);
  await page.evaluate(()=>{window.historyFixture.status='succeeded';});
  await page.clock.runFor(1);
  await page.waitForFunction(()=>document.querySelector('.nc-history-card .nc-state')?.textContent==='翻译完成');
  assert.equal(await calls(),first+1);
  await page.clock.runFor(120_000);
  assert.equal(await calls(),first+1);
  checks.push('loading, 15-second active polling, single operations request and stop on completion');
  await page.screenshot({path:path.join(output,'history-completed.png'),fullPage:false});
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nc-history-card').length===1);
  assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nc-history-card').length===12);
  checks.push('next/previous page and retained total');
  await page.evaluate(()=>{window.historyFixture.fail=true;});
  await page.getByRole('button',{name:'刷新记录',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.screenshot({path:path.join(output,'history-error.png')});
  await page.evaluate(()=>{window.historyFixture.fail=false;});
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.locator('.nc-history-card').first().waitFor();
  checks.push('visible failure and manual recovery');
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const beforeHidden=await calls();
  await page.clock.runFor(120_000);
  assert.equal(await calls(),beforeHidden);
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(expected=>window.historyFixture.calls.length===expected,beforeHidden+1);
  checks.push('hidden page idle and refresh on visibility return');
  await page.getByRole('button',{name:'删除服务器译图',exact:true}).first().click();
  await page.getByRole('button',{name:'确认',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.nc-history-card')?.querySelector('button[aria-label="删除服务器译图"]'));
  checks.push('successful deletion refreshes completed records immediately');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,errors}));
} finally {
  await browser.close();
}
