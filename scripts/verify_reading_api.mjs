// Real local API + worker + Chromium. Only the image supplier is synthetic.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {completeLocalImport} from './local_import_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=path.resolve(process.env.UI_FIXTURE_DIRECTORY||'');
assert(path.basename(fixture).startsWith('nc-reader-ui-'),'Use a disposable manual_ui_server fixture');
const api=process.env.READER_FIXTURE_URL||'http://127.0.0.1:18093',web='http://127.0.0.1:5176';
assert(new URL(api).hostname==='127.0.0.1');
const out=path.resolve('artifacts/reading-api-validation');await mkdir(out,{recursive:true});
async function request(route,auth,body){const r=await fetch(api+route,{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,`${route}: ${r.status} ${await r.clone().text()}`);return r.json();}
const reader=await request('/v1/auth/dev',null,{username:'reading-api-'+randomUUID().slice(0,8)});
const admin=await request('/v1/auth/dev',null,{username:'admin'});
await request(`/v1/admin/users/${reader.user.id}/membership`,admin,{days:7,monthly_pages:30,note:'Isolated reading API acceptance'});
await writeFile(path.join(fixture,'controls.json'),JSON.stringify({delay:.5,outcome:'success'}));
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'chrome'})});
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(({api,reader})=>{localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'redraw',language:'zh-Hans',layout:'single',fit:'window'}));localStorage.setItem('nc-session',JSON.stringify({token:reader.access_token,user:reader.user,apiOrigin:api}));},{api,reader});
const page=await context.newPage(),errors=[],requests=[],plans=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith(api))requests.push(new URL(r.url()).pathname);});
page.on('response',async r=>{if(new URL(r.url()).pathname==='/v1/translation-plans')plans.push({status:r.status(),body:await r.json()});});
const check=message=>{checks.push(message);console.log('PASS '+message);};
try{
  await page.goto(web);await page.locator('input[type=file]').setInputFiles(path.join(fixture,'cluster-eight.cbz'));await completeLocalImport(page);
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'cluster-eight',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.waitForFunction(()=>!!document.querySelector('.nc-page-image[data-result-job]:not([data-result-job="original"])'),null,{timeout:45000});
  assert(plans.some(p=>p.status===202));assert(plans.every(p=>[200,202].includes(p.status)),JSON.stringify(plans));
  check('actual plans, original upload, worker settlement and result download deliver a translated image');
  await page.getByLabel('跳转页码',{exact:true}).fill('4');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='4');
  await page.waitForTimeout(3500);
  const operations=await request('/v1/translation-operations?limit=100',reader);
  const jobIds=new Set(operations.items.map(i=>i.job.id));assert(jobIds.size>=6,`expected current + 2 across both windows, got ${jobIds.size}`);
  await page.reload();await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:'cluster-eight',exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();await page.getByLabel('跳转页码',{exact:true}).waitFor();assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'4');
  await page.waitForFunction(()=>!!document.querySelector('.nc-page-image[data-result-job]:not([data-result-job="original"])'),null,{timeout:15000});
  const restored=await request('/v1/translation-operations?limit=100',reader);assert.equal(new Set(restored.items.map(i=>i.job.id)).size,jobIds.size);
  check('new reader reload restores the current page and existing result without an extra translation');
  assert(!requests.some(p=>p.includes('/queues')||p.endsWith('/priority')||p.includes('translation-submissions')));
  assert.deepEqual(errors,[]);check('real API reading issues zero removed queue or submission requests');
  await page.screenshot({path:path.join(out,'translated-reading.png')});
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,uniqueJobs:jobIds.size,plans:plans.length,liveProvider:false,realApi:true,realWorker:true},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,errors,checks,plans,requests},null,2));throw error;}
finally{await browser.close();}
