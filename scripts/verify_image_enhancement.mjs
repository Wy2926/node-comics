// Vite :5176, synthetic local source / MTU / nunif only. No external model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5176',out=path.resolve('artifacts/image-enhancement');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1360,height:960}}),checks=[],errors=[];
await page.addInitScript(()=>{
  const probe=window.enhancementCacheProbe={reads:[],displays:[]},keys=new WeakMap();
  const get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put,create=URL.createObjectURL;
  IDBObjectStore.prototype.get=function(key){
    const request=get.call(this,key);
    if(this.name==='objects'&&typeof key==='string'){
      probe.reads.push(key);request.addEventListener('success',()=>{if(request.result instanceof Blob)keys.set(request.result,key);});
    }
    return request;
  };
  IDBObjectStore.prototype.put=function(value,...args){if(value instanceof Blob&&typeof args[0]==='string')keys.set(value,args[0]);return put.call(this,value,...args);};
  URL.createObjectURL=function(blob){const key=keys.get(blob);if(key)probe.displays.push(key);return create.call(this,blob);};
});
page.on('pageerror',error=>errors.push(error.message));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const first=(target=page,index=0)=>target.locator(`.nc-manga-page[data-page-index="${index}"]`).first();
const read=(target=page)=>target.evaluate(()=>({translation:window.channelFixture.requests.length,enhancement:window.channelFixture.enhancements,expected:window.channelFixture.outputSha256,official:window.channelFixture.officialTranslations}));
// waitForFunction treats a returned Promise as truthy; explicitly await persisted-state checks.
async function waitForData(target,predicate,arg){
  const deadline=Date.now()+15000;
  while(!await target.evaluate(predicate,arg)){
    assert(Date.now()<deadline,'Timed out waiting for persisted fixture state');
    await target.waitForTimeout(50);
  }
}
const cacheState=()=>page.evaluate(async()=>{
  const {processingCache}=await import('/src/image-processing/storage.ts');
  const {sourceDatabaseName}=await import('/src/storage/database.ts');
  const records=await new Promise((resolve,reject)=>{
    const opening=indexedDB.open(sourceDatabaseName('image-processing-requests'));
    opening.onsuccess=()=>{
      const db=opening.result;
      if(!db.objectStoreNames.contains('records')){db.close();reject(Error('Missing processing records'));return;}
      const tx=db.transaction('records'),request=tx.objectStore('records').count();
      tx.oncomplete=()=>{resolve(request.result);db.close();};tx.onerror=()=>{reject(tx.error);db.close();};
    };opening.onerror=()=>reject(opening.error);
  });
  return {bytes:(await processingCache.usage()).bytes,records};
});
const geometry=(target=page,index=0)=>first(target,index).evaluate(element=>{const box=element.querySelector('.nc-page-picture').getBoundingClientRect(),view=document.querySelector('.nc-reading-viewport');return {height:box.height,top:box.top,scroll:view.scrollTop};});
async function readerSettings(target=page){
  if(await target.locator('.nc-reader').evaluate(element=>element.classList.contains('controls-hidden')))await target.keyboard.press('Escape');
  await target.getByRole('button',{name:'阅读设置',exact:true}).click();
}
async function openMore(target=page){const more=target.getByRole('dialog',{name:'阅读设置',exact:true}).locator('details.nc-reader-more');if(await more.getAttribute('open')===null)await more.locator(':scope > summary').click();}
async function toggle(target=page){await readerSettings(target);await openMore(target);await target.getByRole('switch',{name:'清晰度优化',exact:true}).click();await readerSettings(target);}
async function waitWidth(width,target=page,index=0){await first(target,index).locator('img.nc-page-image').last().waitFor();await target.waitForFunction(({width,index})=>document.querySelector(`.nc-manga-page[data-page-index="${index}"] .nc-comparison-pane:last-child img.nc-page-image`)?.naturalWidth===width,{width,index});}
try {
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/tests/channel-fixture.html#settings');
  await page.locator('.nc-enhancement-settings').waitFor();
  const notes=page.locator('.nc-release-notes[open]');if(await notes.count())await notes.locator('.nc-release-close').click();
  const card=page.locator('.nc-enhancement-settings');
  assert.equal(await card.getByRole('switch').getAttribute('aria-checked'),'false');
  assert.equal(await card.getByRole('switch').isDisabled(),true);
  assert.equal(await card.getByRole('combobox',{name:'增强缓存',exact:true}).innerText(),'10 GB（默认）');
  assert.equal(await card.getByRole('checkbox',{name:'同时清理处理记录',exact:true}).isChecked(),true);
  await card.getByText('已占用 0.0 MB',{exact:true}).waitFor();
  await page.evaluate(()=>{location.hash='library';});
  await page.getByRole('button',{name:/^打开漫画 /}).click();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await openMore();
  assert.equal(await page.getByRole('switch',{name:'清晰度优化',exact:true}).isDisabled(),true);
  await page.getByRole('link',{name:'添加增强渠道',exact:true}).click();
  await card.waitFor();
  check('reader explains unconfigured enhancement with a working settings entry');
  await card.getByRole('button',{name:'添加增强渠道'}).click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByRole('radio',{name:'nunif / waifu2x',exact:true}).isChecked(),true);
  await dialog.screenshot({path:path.join(out,'form-desktop.png')});
  const buttons=await dialog.locator('.nc-channel-form-actions .button').evaluateAll(elements=>elements.map(element=>{
    const {top,bottom,height}=element.getBoundingClientRect();return {top,bottom,height};
  }));
  assert.equal(buttons.length,2);assert.deepEqual(buttons[0],buttons[1]);
  await page.getByLabel('服务地址',{exact:true}).fill('http://user:pass@localhost:8812/');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('服务地址',{exact:true}).inputValue(),'http://user:pass@localhost:8812/');
  assert.equal((await read()).enhancement.length,0);
  await page.getByLabel('名称',{exact:true}).fill('本机 nunif');
  await page.getByLabel('服务地址',{exact:true}).fill(origin+'/fixture-nunif/');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal((await read()).enhancement.length,0);
  assert.equal(await card.getByRole('switch').getAttribute('aria-checked'),'false');
  check('enhancement defaults off; saving a service sends no images and does not enable processing');
  await page.screenshot({path:path.join(out,'settings-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'添加翻译渠道',exact:true}).click();
  await page.getByLabel('名称',{exact:true}).fill('本机 MTU');
  await page.getByLabel('服务地址',{exact:true}).fill(origin+'/fixture-mtu');
  await page.getByLabel('用户名',{exact:true}).fill('fixture');
  await page.getByLabel('密码',{exact:true}).fill('fixture-pass');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{location.hash='library';});
  await page.getByRole('button',{name:/^打开漫画 /}).click();
  await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.waitForFunction(()=>window.channelFixture.requests.length===5);
  await page.waitForFunction(()=>{const image=document.querySelector('.nc-manga-page[data-page-index="0"] img.nc-page-image');return image?.dataset.resultJob!=='original'&&image?.naturalWidth>0;});
  const baseWidth=await first().locator('img.nc-page-image').evaluate(image=>image.naturalWidth),before=await geometry();
  assert.equal((await read()).enhancement.length,0);
  await toggle();
  await waitWidth(baseWidth*2);
  await page.waitForFunction(()=>window.channelFixture.enhancements.length===5);
  await page.waitForTimeout(1000);
  let value=await read();
  assert.equal(value.enhancement.length,5);assert.equal(value.translation,5);assert.equal(value.official,0);
  assert(value.enhancement.every(item=>item.sha256===value.expected));
  for(let i=1;i<value.enhancement.length;i++)assert(value.enhancement[i].startedAt>=value.enhancement[i-1].startedAt+value.enhancement[i-1].duration-2,'A larger reading window must not overlap service calls');
  assert.deepEqual(value.enhancement[0].fields,{style:'art',noise:'-1',scale:'2',format:'0'});
  assert.deepEqual(await geometry(),before);
  check('the same five-page translation window is enhanced; uploaded bytes equal complete MTU output, not source or overlay; position unchanged');
  await page.screenshot({path:path.join(out,'enhanced-reader.png')});
  const shownUrl=await first().locator('img.nc-page-image').last().getAttribute('src');
  await page.evaluate(()=>window.channelFixture.updateProcessingSettings(value=>({...value,cacheLimitMb:128,
    profiles:value.profiles.map(profile=>({...profile,name:'已重命名 nunif'}))})));
  await page.waitForTimeout(500);
  assert.equal(await first().locator('img.nc-page-image').last().getAttribute('src'),shownUrl);
  assert.equal((await read()).enhancement.length,5);
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await openMore();
  await page.getByText('当前渠道 · 已重命名 nunif',{exact:true}).waitFor();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  check('renaming a profile or changing cache budget keeps the displayed enhancement and active channel visible');
  await toggle();await waitWidth(baseWidth);await toggle();await waitWidth(baseWidth*2);
  assert.equal((await read()).enhancement.length,5);
  check('disable restores full translation; re-enable uses cached enhancement without another service call');
  await page.waitForFunction(base=>[...document.querySelectorAll('.nc-manga-page')].slice(0,2).every(page=>page.querySelector('img.nc-page-image')?.naturalWidth===base*2),baseWidth);
  const cachedJobs=await page.locator('.nc-manga-page img.nc-page-image').evaluateAll(images=>images.slice(0,2).map(image=>image.dataset.resultJob));
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.getByRole('button',{name:/^打开漫画 /}).waitFor();
  await page.evaluate(async jobs=>{
    window.channelFixture.parentReads.length=0;window.channelFixture.blockedParentJobs=jobs;
    const probe=window.enhancementCacheProbe;probe.reads.length=0;probe.displays.length=0;probe.pending=[];
    const {processingCache}=await import('/src/image-processing/storage.ts'),read=processingCache.get.bind(processingCache);
    let release;const gate=new Promise(resolve=>{release=resolve;});
    processingCache.get=async(...args)=>{const blob=await read(...args);if(blob){probe.pending.push(args[0]);await gate;}return blob;};
    probe.release=()=>{processingCache.get=read;release();};
  },cachedJobs);
  await page.getByRole('button',{name:/^打开漫画 /}).click();
  await page.waitForFunction(()=>window.enhancementCacheProbe.pending.length>0);
  await page.waitForFunction(()=>[0,1].every(index=>{
    const image=document.querySelector(`.nc-manga-page[data-page-index="${index}"] img.nc-page-image`);
    return image?.dataset.resultJob==='original'&&image.naturalWidth===640;
  }));
  await page.waitForFunction(()=>{
    const image=document.querySelector('.nc-manga-page[data-page-index="2"] img.nc-page-image');
    return image?.dataset.resultJob&&image.dataset.resultJob!=='original'&&image.naturalWidth>0;
  });
  assert.equal((await read()).enhancement.length,5);
  await page.screenshot({path:path.join(out,'pending-cache-keeps-originals.png')});
  await page.evaluate(()=>window.enhancementCacheProbe.release());
  check('a held enhancement cache lookup leaves originals and available translations readable without another processing POST');
  await waitWidth(baseWidth*2);
  await page.waitForFunction(({jobs,width})=>jobs.every(id=>[...document.querySelectorAll('img.nc-page-image')].some(image=>image.dataset.resultJob===id&&image.naturalWidth===width)),{jobs:cachedJobs,width:baseWidth*2});
  const warm=await page.evaluate(()=>({parents:window.channelFixture.parentReads,sourceKeys:window.channelFixture.parentSourceKeys,reads:window.enhancementCacheProbe.reads,displays:window.enhancementCacheProbe.displays}));
  const isParent=key=>warm.sourceKeys.includes(key)||key.startsWith('result:');
  // A pending cache lookup must not hold ordinary pixels. Those independent reads may
  // start, but each selected result is acquired once and unavailable parents cannot
  // prevent the cached enhancement from displaying or trigger another processing POST.
  assert.equal(new Set(warm.parents).size,warm.parents.length,'Reopening must not repeat a selected result read');
  for(const id of cachedJobs)assert(warm.parents.filter(parent=>parent===id).length<=1);
  const preparedParents=warm.displays.filter(isParent);
  assert.equal(new Set(preparedParents).size,preparedParents.length,'Ordinary fallback preparation is not duplicated');
  assert(preparedParents.some(key=>key.startsWith('result:')),'The held lookup exercises translated parent preparation');
  assert(!warm.displays.some(key=>key.startsWith('result:')&&cachedJobs.includes(JSON.parse(key.slice(7))[1])),'Unavailable translated parents never display');
  assert(warm.displays.some(key=>key.startsWith('enhanced:')),'Existing enhancement bytes are displayed');
  for(const index of [0,1])assert.equal(await first(page,index).locator('.nc-image-failure').count(),0);
  assert.equal((await read()).enhancement.length,5);assert.equal((await read()).translation,5);
  assert.deepEqual(await geometry(),before);
  await page.evaluate(()=>{window.channelFixture.blockedParentJobs=[];});
  check('reopening cached enhancements tolerates unavailable translated parents, performs no duplicate parent preparation or POST, and preserves position');
  await page.evaluate(()=>window.channelFixture.clearProcessingCache(false));
  await first().getByRole('button',{name:'重试增强'}).waitFor();await waitWidth(baseWidth);
  assert.equal((await read()).enhancement.length,5);
  await page.evaluate(()=>{window.channelFixture.enhancementFail=true;});
  await first().getByRole('button',{name:'重试增强'}).click();
  await first().getByText('增强失败，保留当前图片。',{exact:true}).waitFor();
  assert.equal((await read()).enhancement.length,6);await waitWidth(baseWidth);
  await page.screenshot({path:path.join(out,'failure-keeps-translation.png')});
  await page.evaluate(()=>{window.channelFixture.enhancementFail=false;});
  await first().getByRole('button',{name:'重试增强'}).click();await waitWidth(baseWidth*2);
  value=await read();assert.equal(value.enhancement.length,7);assert.equal(value.translation,5);
  assert.deepEqual(await geometry(),before);
  check('cache clear never reprocesses automatically; failure retains translation; manual retry changes enhancement only');
  await readerSettings(); await openMore();
  await page.getByRole('switch',{name:'并排对照',exact:true}).click();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nc-manga-page[data-page-index="0"] img.nc-page-image').length===2);
  assert.equal(await first().locator('.nc-comparison-pane').first().locator('img.nc-page-image').evaluate(image=>image.naturalWidth),640);
  await waitWidth(baseWidth*2);
  assert.equal((await read()).enhancement.length,7);
  await page.screenshot({path:path.join(out,'comparison.png')});
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await openMore();
  await page.getByRole('switch',{name:'并排对照',exact:true}).click();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  check('comparison keeps the left original untouched and the enhanced translation on the right');
  await page.getByRole('button',{name:'原图',exact:true}).click();
  await page.waitForFunction(()=>window.channelFixture.enhancements.length===12);
  await waitWidth(baseWidth*2);
  value=await read();assert(value.enhancement.slice(7).every(item=>item.sha256!==value.expected));
  check('translation-off mode enhances source bytes with a separate parent identity');
  await toggle();
  await page.waitForFunction(()=>document.querySelector('.nc-manga-page[data-page-index="0"] img.nc-page-image')?.naturalWidth===640);
  const count=(await read()).enhancement.length;
  await page.getByLabel('跳转页码',{exact:true}).fill('10');
  await page.getByLabel('跳转页码',{exact:true}).press('Enter');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="阅读进度"]')?.value==='10');
  await page.waitForTimeout(1200);assert.equal((await read()).enhancement.length,count);
  check('turning enhancement off prevents new requests while paging');
  await page.evaluate(()=>{location.hash='settings';});await card.waitFor();
  assert.equal(await card.getByRole('combobox',{name:'增强缓存',exact:true}).innerText(),'128 MB');
  const cached=await cacheState();assert(cached.bytes>0);assert(cached.records>0);
  const used=`已占用 ${(cached.bytes/1024**2).toFixed(1)} MB`;
  await card.getByText(used,{exact:true}).waitFor();
  await card.screenshot({path:path.join(out,'cache-used.png')});
  const clearRecords=card.getByRole('checkbox',{name:'同时清理处理记录',exact:true});
  await clearRecords.uncheck();
  await card.getByRole('button',{name:'清理缓存',exact:true}).click();
  await card.getByText('已占用 0.0 MB',{exact:true}).waitFor();
  assert.deepEqual(await cacheState(),{bytes:0,records:cached.records});
  await clearRecords.check();
  await card.getByRole('button',{name:'清理缓存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.nc-enhancement-cache-actions button').disabled);
  assert.deepEqual(await cacheState(),{bytes:0,records:0});
  assert.equal((await read()).enhancement.length,count);
  await card.getByRole('combobox',{name:'增强缓存',exact:true}).click();
  await page.getByRole('option',{name:'10 GB（默认）',exact:true}).click();
  await waitForData(page,async()=>(await window.channelFixture.readProcessingSettings()).cacheLimitMb===10240);
  check('10 GB default, actual byte usage, optional record deletion, and saved budget all work through settings controls');
  await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();
  assert.equal(await card.evaluate(element=>element.scrollWidth>element.clientWidth+1),false);
  await card.locator('.nc-enhancement-cache').screenshot({path:path.join(out,'cache-mobile.png')});
  await card.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('dialog').screenshot({path:path.join(out,'settings-mobile.png')});
  assert.equal(await page.getByRole('dialog').evaluate(element=>element.scrollWidth>element.clientWidth+1),false);
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  for(const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    await clearRecords.uncheck();await clearRecords.check();
    await card.getByRole('button',{name:'清理缓存',exact:true}).click();
    assert.equal(await card.evaluate(element=>element.scrollWidth>element.clientWidth+1),false);
  }
  check('settings and protocol form fit a narrow viewport');
  const waiting=await browser.newPage({viewport:{width:1360,height:960}});
  waiting.on('pageerror',error=>errors.push(error.message));
  try {
    await waiting.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await waiting.goto(origin+'/tests/channel-fixture.html#library');
    await waiting.getByRole('button',{name:/^打开漫画 /}).waitFor();
    const notes=waiting.locator('.nc-release-notes[open]');if(await notes.count())await notes.locator('.nc-release-close').click();
    await waiting.evaluate(async()=>{
      const {connectChannel,selectChannel}=await import('/src/translation/channels/index.ts');
      const {saveProcessingProfile}=await import('/src/image-processing/settings.ts');
      const channel=await connectChannel('manga-translator-ui','受控 MTU',{settings:{baseUrl:location.origin+'/fixture-mtu',username:'fixture'},secrets:{password:'fixture-pass'}});
      await selectChannel(channel.id);
      await saveProcessingProfile('nunif','受控 nunif',{url:location.origin+'/fixture-nunif/',style:'art',noise:'-1',scale:'2'});
    });
    await waiting.getByRole('button',{name:/^打开漫画 /}).click();
    await waiting.getByRole('button',{name:'翻译',exact:true}).click();
    await waiting.waitForFunction(()=>window.channelFixture.requests.length===5);
    await waitWidth(baseWidth,waiting);
    await waiting.getByRole('button',{name:'阅读设置',exact:true}).click();
    await waiting.getByRole('button',{name:'单页',exact:true}).click();
    await waiting.getByRole('button',{name:'阅读设置',exact:true}).click();
    const preparedPages=await waiting.evaluate(async()=>1+(await import('/src/reading-window.ts')).MAX_READING_TARGETS);
    const expandWindow=()=>waiting.locator('.nc-reading-viewport').evaluate(view=>{
      view.scrollTop=view.scrollHeight;view.dispatchEvent(new Event('scroll'));
    });
    // Warm both navigation windows, including their scroll expansion, before measuring retranslation.
    await waiting.getByRole('button',{name:'下一页',exact:true}).click();
    await waitWidth(baseWidth,waiting,1);
    await expandWindow();
    await waitForData(waiting,async count=>{
      const {readEntryDirectOperations}=await import('/src/translation/channels/transport/operations.ts');
      const operations=await readEntryDirectOperations(document.querySelector('.nc-stream-chapter').dataset.copyId);
      return window.channelFixture.requests.length===count&&operations.length===count&&operations.every(({job})=>job.status==='succeeded');
    },preparedPages);
    await waiting.getByRole('button',{name:'上一页',exact:true}).click();
    await waitWidth(baseWidth,waiting);
    const beforeWaiting=await geometry(waiting),translations=(await read(waiting)).translation;
    assert.equal(translations,preparedPages,'Both reading windows must finish translation before enhancement starts');
    await waiting.evaluate(()=>{window.channelFixture.holdEnhancements=true;});
    await toggle(waiting);
    await waiting.waitForFunction(()=>window.channelFixture.heldEnhancements===1);
    const activeTransfer=()=>waiting.evaluate(async()=>{
      const {hashFile}=await import('/src/importers/hash.ts');
      const {readServiceLane}=await import('/src/image-processing/storage.ts');
      const {readTransferReceipt}=await import('/src/image-transfer/receipts.ts');
      const lane=await readServiceLane(await hashFile(new Blob([location.origin+'/fixture-nunif/api'])));
      const receipt=await readTransferReceipt(lane.requestId);return {id:receipt.id,state:receipt.state};
    });
    const transfer=await activeTransfer();
    assert.equal(transfer.state,'running');
    await waiting.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    await waiting.getByRole('button',{name:/^打开漫画 /}).click();
    await first(waiting).locator('[data-enhancement-state="running"]').waitFor();
    await waitWidth(baseWidth,waiting);
    assert.deepEqual(await geometry(waiting),beforeWaiting);
    assert.equal(await first(waiting).getByText('正在读取译图',{exact:true}).count(),0);
    assert.equal(await waiting.evaluate(()=>window.channelFixture.heldEnhancements),1);
    assert.equal((await read(waiting)).enhancement.length,1);
    assert.equal((await read(waiting)).translation,translations);
    assert.deepEqual(await activeTransfer(),transfer);
    await waiting.screenshot({path:path.join(out,'running-reopen-keeps-translation.png')});
    check('reopening a running enhancement shows the existing translation before the controlled HTTP response is released, with no duplicate POST');
    await waiting.getByRole('button',{name:'下一页',exact:true}).click();
    await first(waiting,1).locator('[data-enhancement-state="queued"]').waitFor();
    await waitWidth(baseWidth,waiting,1);
    await expandWindow();
    const queuedGeometry=await geometry(waiting,1);
    assert.equal(await waiting.evaluate(()=>window.channelFixture.heldEnhancements),1);
    assert.equal((await read(waiting)).enhancement.length,1);
    assert.equal((await read(waiting)).translation,translations);
    assert.deepEqual(await activeTransfer(),transfer);
    assert.equal(await first(waiting,1).getByText('正在读取译图',{exact:true}).count(),0);
    await waiting.screenshot({path:path.join(out,'queued-keeps-translation.png')});
    await waiting.evaluate(()=>window.channelFixture.releaseEnhancements());
    await waitWidth(baseWidth*2,waiting,1);
    assert.deepEqual(await geometry(waiting,1),queuedGeometry);
    await waiting.waitForFunction(count=>window.channelFixture.enhancements.length===count&&window.channelFixture.enhancements.every(item=>item.duration>0),preparedPages);
    const recovered=await waiting.evaluate(async id=>{
      const {readTransferReceipt}=await import('/src/image-transfer/receipts.ts');
      const receipt=await readTransferReceipt(id);return {id:receipt.id,state:receipt.state};
    },transfer.id);
    assert.deepEqual(recovered,{id:transfer.id,state:'succeeded'});
    await waiting.getByRole('button',{name:'上一页',exact:true}).click();
    await waitWidth(baseWidth*2,waiting);
    assert.deepEqual(await geometry(waiting),beforeWaiting);
    assert.equal((await read(waiting)).enhancement.length,preparedPages);
    assert.equal((await read(waiting)).translation,translations);
    check('another page displays its translation while the old service request is held; completion replaces it in place and preserves the original request UUID without retranslating');
  }catch(error){await waiting.screenshot({path:path.join(out,'waiting-failed.png')});throw error;}
  finally{await waiting.close();}
  const single=await browser.newPage({viewport:{width:1360,height:960}});
  single.on('pageerror',error=>errors.push(error.message));
  try {
    await single.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await single.goto(origin+'/tests/reader-fixture.html?auto=enhancement-prefetch&enhancement=1&long=1#library');
    await single.getByRole('button',{name:/^打开漫画 /}).waitFor();
    const notes=single.locator('.nc-release-notes[open]');if(await notes.count())await notes.locator('.nc-release-close').click();
    await single.getByRole('button',{name:/^打开漫画 /}).click();
    await single.getByRole('button',{name:'阅读设置',exact:true}).click();
    await single.getByRole('button',{name:'单页',exact:true}).click();
    await single.getByRole('button',{name:'阅读设置',exact:true}).click();
    const before=await geometry(single);
    await toggle(single);
    await single.waitForFunction(()=>window.readerFixture.enhancements.length===4);
    await waitWidth(1280,single);
    const ordinals=()=>single.evaluate(()=>window.readerFixture.enhancements.map(item=>window.readerFixture.imageOrdinals[item.sha256]));
    assert.deepEqual(await ordinals(),[0,1,2,3]);
    assert.equal(await single.locator('.nc-manga-page').count(),1);
    assert.equal(await single.locator('.nc-reading-viewport').getAttribute('data-decoded-pages'),'1');
    assert.deepEqual(await geometry(single),before);
    await single.screenshot({path:path.join(out,'single-page-prefetch.png')});
    await single.getByRole('button',{name:'下一页',exact:true}).click();
    await single.waitForFunction(()=>document.querySelector('.nc-manga-page[data-page-index="1"] img.nc-page-image')?.naturalWidth===1280);
    await single.waitForFunction(()=>window.readerFixture.enhancements.length===5);
    assert.deepEqual(await ordinals(),[0,1,2,3,4]);
    await single.locator('.nc-reading-viewport').evaluate(view=>{
      const height=view.querySelector('.nc-page-picture').getBoundingClientRect().height;
      view.scrollTop=Math.max(0,Math.min(height/3,height-view.clientHeight))+2;
    });
    await single.waitForFunction(()=>window.readerFixture.enhancements.length===6);
    assert.deepEqual(await ordinals(),[0,1,2,3,4,5]);
    assert.equal(await single.getByLabel('跳转页码',{exact:true}).inputValue(),'2');
    assert.equal(await single.locator('.nc-manga-page').count(),1);
    assert.equal(await single.evaluate(()=>window.readerFixture.translationRequests.length),0);
    check('single-page mode prefetches the next three without mounting them, reuses the next result, and expands once at the shared scroll threshold');
  } finally {await single.close();}
  for(const completion of ['no_text','unchanged']){
    const resultPage=await browser.newPage({viewport:{width:1360,height:960}});
    resultPage.on('pageerror',error=>errors.push(error.message));
    try{
      await resultPage.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      await resultPage.goto(origin+'/tests/reader-fixture.html?auto=enhancement-original&enhancement=1#library');
      await resultPage.getByRole('button',{name:/^打开漫画 /}).waitFor();
      const releaseNotes=resultPage.locator('.nc-release-notes[open]');if(await releaseNotes.count())await releaseNotes.locator('.nc-release-close').click();
      await resultPage.getByRole('button',{name:/^打开漫画 /}).click();
      const image=first(resultPage);
      await resultPage.getByRole('button',{name:'翻译',exact:true}).click();
      await resultPage.waitForFunction(()=>window.readerFixture.submitted.length>=4);
      await toggle(resultPage);
      assert.equal(await resultPage.evaluate(()=>window.readerFixture.enhancements.length),0);
      const beforeOriginal=await geometry(resultPage);
      await resultPage.evaluate(kind=>{
        window.readerFixture.enhancementFail=true;
        window.readerFixture.finishNext(kind);
      },completion);
      await image.getByRole('button',{name:'重试增强',exact:true}).waitFor();
      assert.equal(await image.locator('img.nc-page-image').last().evaluate(element=>element.naturalWidth),640);
      assert.deepEqual(await geometry(resultPage),beforeOriginal);
      const requests=await resultPage.evaluate(()=>window.readerFixture.translationRequests.length);
      await resultPage.evaluate(()=>{window.readerFixture.enhancementFail=false;});
      await image.getByRole('button',{name:'重试增强',exact:true}).click();
      await waitWidth(1280,resultPage);
      const outcome=await resultPage.evaluate(()=>({
        enhancements:window.readerFixture.enhancements,requests:window.readerFixture.translationRequests.length,
        originalSha:Object.entries(window.readerFixture.imageOrdinals).find(([,index])=>index===0)[0],
      }));
      assert.equal(outcome.enhancements.length,2);
      assert(outcome.enhancements.every(item=>item.sha256===outcome.originalSha));
      assert.equal(outcome.requests,requests);assert.deepEqual(await geometry(resultPage),beforeOriginal);
      await toggle(resultPage);
      await waitWidth(640,resultPage);
      await toggle(resultPage);
      await waitWidth(1280,resultPage);
      assert.equal(await resultPage.evaluate(()=>window.readerFixture.enhancements.length),2);
      await resultPage.screenshot({path:path.join(out,completion+'-enhanced.png')});
      check(completion+' original result enhances only after completion, keeps source on failure, retries without translation and restores from enhancement cache');
    }catch(error){await resultPage.screenshot({path:path.join(out,completion+'-failed.png')});throw error;}
    finally{await resultPage.close();}
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors,before,warmCache:{resultReadAttempts:warm.parents.length,preparedParents:preparedParents.length},requests:await read()},null,2));
} catch(error) {
  await page.screenshot({path:path.join(out,'failed.png'),fullPage:true}).catch(()=>{});
  console.error('page errors',errors);throw error;
} finally {await browser.close();}
