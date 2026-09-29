// Start extension Vite on :5176. Real reader/hooks, isolated account and simulated API only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/reader-retry-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const checks=[],errors=[];let page;
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function open(offline=false){
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  const scenario=offline?'connection':'retry';
  await page.goto(web+'/tests/reader-fixture.html?auto='+scenario+(offline?'&offline':''));
  await page.locator('article.nc-book').filter({has:page.getByRole('button',{name:'打开漫画 自动翻译 · '+scenario,exact:true})}).getByRole('button',{name:/^打开漫画 /}).click();
  await page.locator('.nc-page-image').waitFor();
  await page.getByRole('button',{name:'常规翻译',exact:true}).click();
}
async function geometry(){return page.locator('.nc-page-picture').first().evaluate(i=>({width:i.clientWidth,height:i.clientHeight,scroll:document.querySelector('.nc-reading-viewport').scrollTop}));}
async function waitSubmitted(count){await page.waitForFunction(count=>window.readerFixture.submitted.length===count,count,{timeout:15000});}
try{
  await open();
  const failed=page.getByRole('button',{name:'翻译失败 · 重试',exact:true});await failed.waitFor();
  assert.equal(await failed.innerText(),'翻译失败\n重试');assert((await failed.getAttribute('title')).includes('模拟文字识别失败'));
  const before=await geometry();await page.evaluate(()=>window.readerFixture.delay=800);
  await failed.click();const busy=page.getByRole('button',{name:'重试中',exact:true});await busy.waitFor();assert(await busy.isDisabled());
  await page.screenshot({path:path.join(out,'retry-pending.png')});check('retry immediately shows a spinner and disables repeat clicks');
  await busy.waitFor({state:'hidden'});await page.evaluate(()=>window.readerFixture.delay=0);await waitSubmitted(1);assert.deepEqual(await geometry(),before);check('failed-page retry submits once and preserves reading position');
  await page.waitForFunction(()=>window.readerFixture.jobs.some(job=>['queued','running'].includes(job.status)));
  await page.evaluate(()=>window.readerFixture.failDownloads=true);await page.getByRole('button',{name:'模拟完成',exact:true}).click();
  const downloadFailure=page.getByRole('button',{name:'加载失败 · 重试',exact:true});await downloadFailure.waitFor({timeout:15000});
  await page.evaluate(()=>{window.readerFixture.failDownloads=false;window.readerFixture.delay=500;});await downloadFailure.click();await page.getByRole('button',{name:'重试中',exact:true}).waitFor();
  await page.locator('.nc-page-image[data-result-job]:not([data-result-job="original"])').waitFor({timeout:15000});assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),1);check('download retry displays the existing result without regenerating or billing a new job');
  await page.close();
  await open(true);const offline=page.getByRole('button',{name:'连接失败 · 重试',exact:true});await offline.waitFor();
  await page.evaluate(()=>window.readerFixture.delay=700);await offline.click();await page.getByRole('button',{name:'重试中',exact:true}).waitFor();await offline.waitFor();
  assert.equal(await page.evaluate(()=>window.readerFixture.submitted.length),0);check('retry before capabilities/rights load gives visible feedback and remains a concise error while offline');
  await page.setViewportSize({width:390,height:844});const badge=await offline.boundingBox();assert(badge.width<220&&badge.height<46,JSON.stringify(badge));await page.screenshot({path:path.join(out,'offline-mobile.png')});check('failure notice remains one compact row on mobile; details are hover-only');
  const recoveringAt=Date.now();await page.evaluate(()=>{window.readerFixture.offline=false;window.readerFixture.delay=0;});await offline.click();await waitSubmitted(1);
  assert(Date.now()-recoveringAt<8000,'manual retry should bypass the existing eight-second network backoff');check('one retry restores service configuration and resumes work immediately after network recovery');
  await page.close();
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/reader-fixture.html?auto=connection');
  await page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true}).waitFor();
  const legacyId=await page.evaluate(async()=>{
    const {catalog}=await import('/src/comics/repositories/index.ts');
    const {API_ORIGIN}=await import('/src/service.ts');
    const document=(await catalog.list('entries'))[0],descriptor=(await catalog.listPages(document.contentId,{limit:1}))[0];
    const sha=Object.keys(window.readerFixture.imageOrdinals)[0],requestId=crypto.randomUUID();
    const old={id:'legacy-local-operation',requestId,scope:JSON.stringify([API_ORIGIN,'fixture-connection']),entryId:document.id,pageId:descriptor.pageId,mode:'redraw',language:'zh-Hans',state:'uncertain',pageRef:{entryId:document.id,contentId:document.contentId,pageId:descriptor.pageId,renderProfileId:'original-v1-gif-first-frame'},result:{id:requestId,state:'needs_input'}};
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('node-comics-reading-v2-translation-requests',1);
      request.onupgradeneeded=()=>{request.result.createObjectStore('operations',{keyPath:'id'}).createIndex('scope','scope');request.result.createObjectStore('sync',{keyPath:'id'});};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    await new Promise((resolve,reject)=>{const tx=db.transaction('operations','readwrite');tx.objectStore('operations').put(old);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    const fallback=window.fetch.bind(window);window.upgradeFixture={state:'needs_input',executionResolved:false,requests:[]};
    window.fetch=async(input,init={})=>{
      const url=new URL(String(input),API_ORIGIN);
      if(url.pathname.startsWith('/v1/translations'))window.upgradeFixture.requests.push({path:url.pathname,method:init.method??'GET',protocol:new Headers(init.headers).get('X-Translation-Protocol')});
      if(url.pathname==='/v1/translations'&&url.searchParams.get('ids')?.split(',').includes(requestId)){
        const fixture=window.upgradeFixture;
        return Response.json({items:[{id:requestId,state:fixture.state,mode:'redraw',target_language:'zh-Hans',image_sha256:sha,execution_resolved:fixture.executionResolved,...(fixture.state==='failed'?{error:{code:'TRANSLATION_UNAVAILABLE',message:'翻译访问已撤销'}}:{})}],missing_ids:[]});
      }
      return fallback(input,init);
    };
    return requestId;
  });
  await page.getByRole('button',{name:'打开漫画 自动翻译 · connection',exact:true}).click();
  await page.locator('.nc-page-image').waitFor();
  await page.getByRole('button',{name:'AI 重绘',exact:true}).click();
  const unresolved=page.getByRole('button',{name:'结果待核实 · 重试',exact:true});await unresolved.waitFor();
  const upgradeGeometry=await geometry();await unresolved.click();await unresolved.waitFor();
  assert.equal(await page.evaluate(()=>window.readerFixture.translationRequests.length),0);
  assert.deepEqual(await geometry(),upgradeGeometry);
  check('upgrading a persisted old request queries its UUID without replaying old input or creating a paid retry');
  await page.evaluate(()=>window.upgradeFixture.state='failed');await unresolved.click();await unresolved.waitFor();
  assert.equal(await page.evaluate(()=>window.readerFixture.translationRequests.length),0);
  assert.deepEqual(await geometry(),upgradeGeometry);
  check('revoked old redraw remains blocked until the server explicitly confirms its execution is resolved');
  await page.evaluate(()=>window.upgradeFixture.executionResolved=true);await unresolved.click();await waitSubmitted(1);
  const upgraded=await page.evaluate(async()=>{
    const {readOperations,translationScope}=await import('/src/translation/channels/adapters/nodelane/store.ts');
    const {API_ORIGIN}=await import('/src/service.ts');
    const records=await readOperations(translationScope(API_ORIGIN,'fixture-connection'));
    return {record:records[0],requests:window.upgradeFixture.requests};
  });
  assert.notEqual(upgraded.record.requestId,legacyId);
  assert.equal(upgraded.record.pageRef.renderProfileId,'original-v2-static-srgb');
  assert.deepEqual(JSON.parse(upgraded.record.scope).slice(1),['fixture-connection','overlay-v1']);
  assert(upgraded.requests.every(request=>request.protocol==='overlay-v1'));
  assert(!upgraded.requests.some(request=>request.method==='PUT'&&request.path.includes(legacyId)));
  assert.deepEqual(await geometry(),upgradeGeometry);
  await page.screenshot({path:path.join(out,'protocol-upgrade-recovery.png')});
  check('explicit retry after old terminal confirmation uses the new scope, current source profile and one new UUID without moving the reader');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));console.log('Artifacts: '+out);
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser.close();}
