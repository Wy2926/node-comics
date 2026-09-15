// Real Chrome + isolated API/control worker. Only the image supplier is synthetic.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {completeLocalImport} from './local_import_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const api='http://127.0.0.1:18089',web='http://127.0.0.1:5174',out=path.resolve('artifacts/cluster-validation');
assert(process.env.UI_FIXTURE_DIRECTORY,'Start the isolated manual_ui_server first');
await mkdir(out,{recursive:true});
async function request(url,body,token,method=body?'POST':'GET',key){const r=await fetch(api+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,`${url}: ${r.status} ${await r.clone().text()}`);return r.json();}
const auth=await request('/v1/auth/dev',{username:'cluster-ui-'+randomUUID().slice(0,8)});
const admin=await request('/v1/auth/dev',{username:'admin'});
await request(`/v1/admin/users/${auth.user.id}/membership`,{months:1,note:'Isolated browser test'},admin.access_token,'POST',randomUUID());
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function openReader(){await page.getByRole('button',{name:'我的漫画',exact:true}).click();await page.locator('.nc-shelf-detail').first().click();await page.getByRole('tab',{name:'卷册',exact:true}).click();await page.getByRole('button',{name:/^(阅读|继续阅读)$/}).first().click();await page.getByLabel('跳转页码').waitFor();}
try{
 await page.goto(web);await page.evaluate(({api,auth})=>{localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'redraw',layout:'single',autoShowTranslation:true}));localStorage.setItem('nc-session',JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api}));},{api,auth});await page.reload();
 await page.getByRole('button',{name:'翻译队列',exact:true}).click();await page.getByRole('tab',{name:/AI 重绘/}).click();await page.getByRole('button',{name:'暂停服务器队列',exact:true}).click();await page.getByText('服务器队列已暂停',{exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'queue-plus-paused.png')});
 const q=(await request('/v1/me/queues',null,auth.access_token)).items;assert(q.every(x=>x.capacity===500&&x.realtime_limit===10));assert(q.find(x=>x.mode==='redraw').paused&&!q.find(x=>x.mode==='classic').paused);check('PLUS 500/10 and independent mode pause');
 await page.getByRole('button',{name:'我的漫画',exact:true}).click();await page.locator('input[type=file]').setInputFiles(path.join(process.env.UI_FIXTURE_DIRECTORY,'cluster-eight.cbz'));await page.getByLabel('内容归属',{exact:true}).selectOption('publication');await completeLocalImport(page);await openReader();
 await page.getByRole('button',{name:/默认翻译/}).click();await page.getByRole('button',{name:'预存本章 8 页',exact:true}).click();await page.getByRole('dialog').waitFor();await page.screenshot({path:path.join(out,'submission-confirm.png')});await page.getByRole('button',{name:'确认并加入上传清单 · 最多 8 页',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByLabel('关闭面板',{exact:true}).click();
 const until=Date.now()+45000;let queued;while(Date.now()<until){queued=(await request('/v1/me/queues',null,auth.access_token)).items.find(x=>x.mode==='redraw');if(queued.in_flight>=8){const rows=(await request('/v1/me/queues/redraw/items',null,auth.access_token)).items;if(rows.length===8&&rows.every(j=>j.status!=='awaiting_upload'))break;}await page.waitForTimeout(300);}assert(queued.in_flight>=8);assert((await request('/v1/me/queues/redraw/items',null,auth.access_token)).items.every(j=>j.status!=='awaiting_upload'));check('eight-page manifest durably uploads while server queue is paused');
 const jump=page.getByLabel('跳转页码');await jump.fill('3');await jump.press('Enter');await jump.blur();await page.getByRole('button',{name:'翻译队列',exact:true}).click();await page.getByRole('tab',{name:/AI 重绘/}).click();await page.screenshot({path:path.join(out,'queue-uploaded.png')});await page.getByRole('button',{name:'恢复服务器队列',exact:true}).click();
 await page.goto('about:blank');const deadline=Date.now()+75000;let submitted;while(Date.now()<deadline){submitted=(await request('/v1/translation-submissions',null,auth.access_token)).items;if(submitted.reduce((n,s)=>n+(s.counts.succeeded||0),0)>=8)break;await page.waitForTimeout(500);}assert.equal(submitted.reduce((n,s)=>n+(s.counts.succeeded||0),0),8);check('server completes all eight tasks with the reader closed');
 await page.goto(web);await openReader();assert.equal(await page.getByLabel('跳转页码').inputValue(),'3');await page.waitForFunction(()=>[...document.querySelectorAll('.nc-page-image')].some(i=>i.complete&&i.naturalWidth>0));await page.waitForTimeout(1500);await page.screenshot({path:path.join(out,'reader-restored.png')});check('reopening restores reading position and completed translation');
 await page.getByRole('group',{name:'本页查看方式'}).getByRole('button',{name:'原图',exact:true}).click();assert.equal(await page.getByLabel('跳转页码').inputValue(),'3');await page.getByRole('group',{name:'本页查看方式'}).getByRole('button',{name:'AI 重绘',exact:true}).click();
 await writeFile(path.join(process.env.UI_FIXTURE_DIRECTORY,'controls.json'),JSON.stringify({delay:1,outcome:'failed'}));
 await page.getByRole('button',{name:/默认翻译/}).click();await page.getByRole('button',{name:'重新翻译 · 查看范围',exact:true}).click();await page.getByRole('button',{name:'确认并加入上传清单 · 最多 1 页',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByLabel('关闭面板',{exact:true}).click();
 await page.getByText('本页翻译失败',{exact:true}).waitFor({timeout:30000});assert.equal(await page.getByLabel('跳转页码').inputValue(),'3');await page.screenshot({path:path.join(out,'reader-failed-rerun.png')});check('failed rerun preserves previous translation and reading position');
 await writeFile(path.join(process.env.UI_FIXTURE_DIRECTORY,'controls.json'),JSON.stringify({delay:6,outcome:'success'}));

 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'翻译队列',exact:true}).click();await page.getByRole('tab',{name:/AI 重绘/}).click();await page.screenshot({path:path.join(out,'queue-mobile.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check('queue is usable at 390px without horizontal overflow');
 const free=await request('/v1/auth/dev',{username:'cluster-free-'+randomUUID().slice(0,8)});await page.evaluate(({api,auth})=>localStorage.setItem('nc-session',JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api})),{api,auth:free});await page.reload();await page.getByRole('button',{name:'翻译队列',exact:true}).click();await page.getByRole('tab',{name:/常规翻译/}).waitFor();const fq=(await request('/v1/me/queues',null,free.access_token)).items;assert(fq.every(x=>x.capacity===10&&x.realtime_limit===2));await page.screenshot({path:path.join(out,'queue-free.png')});check('free account exposes independent 10/2 limits');
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByText(/当前长期保留，未设自动清理/).waitFor();await page.getByText(/当前长期保留，未设自动清理/).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'settings-retention.png')});check('privacy settings display indefinite original and result retention');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'browser-results.json'),JSON.stringify({checks,pageErrors:errors,realApi:true,realChrome:true,liveProvider:false},null,2));
}catch(e){await page.screenshot({path:path.join(out,'browser-failure.png')});await writeFile(path.join(out,'browser-failure.txt'),await page.locator('body').innerText());throw e;}finally{await writeFile(path.join(process.env.UI_FIXTURE_DIRECTORY,'controls.json'),JSON.stringify({delay:6,outcome:'success'}));await browser.close();}
