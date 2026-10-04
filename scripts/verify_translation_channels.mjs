// Real desktop Chromium UI; synthetic HTTP responses only, no live MTU/official account.
// Start extension Vite on :5176. Uses a fresh browser context and synthetic source files.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/translation-channels-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1360,height:960}}),checks=[],errors=[];
let readingWindow;
page.on('pageerror',error=>errors.push(error.message));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const read=()=>page.evaluate(async()=>({requests:window.channelFixture.requests,official:window.channelFixture.officialTranslations,auth:!!(await window.channelFixture.readAuth()).session,channels:await window.channelFixture.listChannels(),pageReads:window.channelFixture.pageReads,chapterContentIds:window.channelFixture.chapterContentIds}));
async function openBook(){await page.getByRole('button',{name:/^打开漫画 /}).click();await page.getByLabel('跳转页码',{exact:true}).waitFor();}
const guideUrl='https://comics.nodelane.net/guides/local-translation/';
const channelSettings=()=>page.locator('.nc-channel-settings');
const channelCard=name=>page.locator('.nc-channel-card').filter({has:page.getByRole('radio',{name,exact:true})});
async function assertGuide(scope){
  const link=scope.getByRole('link',{name:'使用教程',exact:true});
  assert.equal(await link.count(),1);assert.equal(await link.getAttribute('href'),guideUrl);
  assert.equal(await link.getAttribute('target'),'_blank');
  const rel=(await link.getAttribute('rel')).split(/\s+/);assert(rel.includes('noopener')&&rel.includes('noreferrer'));
}
async function waitChannel(id){
  await page.waitForFunction(async id=>{const channels=await window.channelFixture.listChannels(),radio=document.querySelector('.nc-channel-settings input[name="translation-channel"]:checked');return channels.activeId===id&&radio?.getAttribute('aria-label')===channels.profiles.find(profile=>profile.id===id)?.name;},id);
  await page.waitForFunction(()=>!document.querySelector('.nc-channel-list')?.disabled);
  await page.waitForFunction(()=>document.querySelectorAll('.nc-channel-settings input[name="translation-channel"]:checked').length===1);
  assert.equal(await channelSettings().locator('input[name="translation-channel"]:checked').count(),1);
}
async function dismissReleaseNotes(){
  await channelSettings().waitFor();
  const release=page.locator('.nc-release-notes[open]');
  if(await release.count()){await release.locator('.nc-release-close').click();await release.waitFor({state:'hidden'});}
}
const scrollState=element=>{const result=[];for(let node=element.parentElement;node;node=node.parentElement)result.push([node.tagName,node.className,node.scrollTop,node.scrollLeft]);return {ancestors:result,x:scrollX,y:scrollY};};
async function assertNoHorizontalOverflow(scope){
  const layout=await scope.evaluate(element=>({viewport:innerWidth,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,overflow:[element,...element.querySelectorAll('.nc-channel-grid,.nc-channel-card,.nc-channel-choice,.nc-channel-footer,.nc-channel-services,.nc-channel-service,.nc-channel-form,.nc-modal-body')].filter(item=>item.scrollWidth>item.clientWidth+1).map(item=>({className:item.className,width:item.clientWidth,scrollWidth:item.scrollWidth}))}));
  assert(layout.left>=-1&&layout.right<=layout.viewport+1,JSON.stringify(layout));assert.deepEqual(layout.overflow,[],JSON.stringify(layout));
}
try{
  await page.route('**/*',route=>new URL(route.request().url()).origin===web?route.continue():route.abort());
  await page.goto(web+'/tests/channel-fixture.html#settings');
  await dismissReleaseNotes();
  assert.equal(await channelSettings().getByRole('radio').count(),1);
  assert.equal(await channelSettings().getByRole('radio',{name:'NodeLane',exact:true}).isChecked(),true);
  assert.equal(await channelCard('NodeLane').getByRole('link',{name:'使用教程',exact:true}).count(),0);
  assert.equal(await channelCard('NodeLane').getByRole('button',{name:'重新连接',exact:true}).count(),0);
  check('built-in NodeLane starts selected and does not show an MTU tutorial or reconnect action');
  await page.getByRole('button',{name:'添加翻译渠道',exact:true}).click();
  await assertGuide(page.getByRole('dialog'));
  assert.equal(await page.getByRole('dialog').getByRole('radio',{name:'manga-translator-ui',exact:true}).isChecked(),true);
  check('add dialog identifies MTU and opens its matching tutorial safely in a new tab');
  await page.getByLabel('名称',{exact:true}).fill('我的本机 MTU');
  await page.getByLabel('服务地址',{exact:true}).fill(web+'/fixture-mtu');
  await page.getByLabel('用户名',{exact:true}).fill('fixture');
  await page.getByLabel('密码',{exact:true}).fill('incorrect');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'登录失败'}).waitFor();
  assert.equal((await read()).channels.profiles.length,1);
  check('failed login stays in the dialog and does not save a channel');
  await page.getByLabel('密码',{exact:true}).fill('fixture-pass');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  const connected=await read();assert.equal(connected.auth,false);assert.equal(connected.channels.profiles.length,2);
  assert(!JSON.stringify(connected.channels).includes('synthetic-local-token'));assert(!JSON.stringify(connected.channels).includes('fixture-pass'));
  await assertGuide(channelCard('我的本机 MTU'));
  await page.screenshot({path:path.join(out,'channel-settings.png'),fullPage:true});
  check('connects local service without official login and keeps token/password out of channel metadata');
  await page.evaluate(()=>{location.hash='library';});await openBook();
  readingWindow=await page.evaluate(()=>{const viewport=document.querySelector('.nc-reading-viewport'),picture=document.querySelector('.nc-manga-page[data-page-index="0"] .nc-page-picture');return {viewportHeight:viewport.clientHeight,pageHeight:picture.getBoundingClientRect().height,pageTop:picture.getBoundingClientRect().top-viewport.getBoundingClientRect().top};});
  // Fit-window pages are shorter than the viewport. ReadingProgress expands them at their top.
  assert(readingWindow.pageHeight<=readingWindow.viewportHeight&&readingWindow.pageTop<readingWindow.viewportHeight,JSON.stringify(readingWindow));
  await page.getByRole('button',{name:'常规翻译',exact:true}).click();
  await page.waitForFunction(()=>window.channelFixture.requests.length===5);
  await page.waitForFunction(()=>document.querySelector('.nc-reading-viewport img')?.getAttribute('src')?.startsWith('blob:'));
  await page.waitForTimeout(1600);
  let current=await read();const initialRequests=5;assert.equal(current.official,0);assert.equal(current.requests.length,initialRequests);
  assert(current.requests.every(r=>r.language==='CHS'&&r.token&&r.hasImage));
  assert.equal(await page.getByRole('button',{name:'AI 重绘',exact:true}).count(),0);
  await page.screenshot({path:path.join(out,'local-reading.png')});
  check('a fit-window short page expands the current window to exactly 5 local requests with image/config/token and no official calls');
  const localId=current.channels.activeId;
  await page.evaluate(()=>{window.channelFixture.pageReads.length=0;});
  await page.evaluate(()=>window.channelFixture.selectChannel('nodelane'));
  await page.getByRole('button',{name:'登录后翻译',exact:true}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'AI 重绘',exact:true}).count(),0);
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'1');
  await page.evaluate(id=>window.channelFixture.selectChannel(id),localId);
  await page.waitForTimeout(1200);
  assert.equal(await page.getByRole('button',{name:'常规翻译',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal((await read()).requests.length,initialRequests);
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'1');
  check('switching channels preserves reading position, isolates official login, and reuses local results');
  current=await read();
  assert.equal(current.chapterContentIds.length,100);
  assert.deepEqual([...new Set(current.pageReads)].sort(),current.chapterContentIds.slice(0,2).sort(),'channel switching must only reload the two loaded chapters, not the full 100-chapter sequence');
  check('channel switching reads only the loaded chapters in a fully indexed 100-chapter sequence');
  await page.evaluate(()=>{location.hash='settings';});
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await assertGuide(page.getByRole('dialog'));
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await page.screenshot({path:path.join(out,'reconnected-settings.png'),fullPage:true});
  check('reconnect UI keeps the saved password out of the input');
  await page.locator('.setting-row').filter({has:page.locator('b',{hasText:/^译图缓存$/})}).getByRole('button',{name:'清理',exact:true}).click();
  await page.waitForTimeout(400);
  await page.evaluate(()=>{location.hash='library';});await openBook();
  const missingResult=page.getByTitle('本地译图缓存已清理，请手动重新翻译。',{exact:true}).first().getByRole('button',{name:'翻译失败 · 重新翻译',exact:true});
  await missingResult.waitFor();
  assert.equal((await read()).requests.length,initialRequests);
  await missingResult.click();
  await page.waitForFunction(count=>window.channelFixture.requests.length===count,initialRequests+1);
  await page.waitForTimeout(1200);
  assert.equal((await read()).requests.length,initialRequests+1);
  check('clearing local images does not submit requests; explicit retranslation submits once');
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false}));
  await page.getByLabel('跳转页码',{exact:true}).fill('10');
  await page.waitForFunction(count=>window.channelFixture.requests.length===count,initialRequests+6);
  await page.waitForTimeout(1200);
  assert.equal((await read()).requests.length,initialRequests+6);
  check('an Internet-offline status does not block an accessible local translation service');
  await page.getByRole('button',{name:'原图',exact:true}).click();
  await page.getByRole('button',{name:'打开目录',exact:true}).click();
  await page.getByRole('button').filter({hasText:'合成章节 100'}).click();
  await page.waitForFunction(()=>window.channelFixture.pageReads.includes(window.channelFixture.chapterContentIds[99]));
  await page.waitForFunction(()=>{const image=document.querySelector('.nc-stream-chapter[data-copy-id$=":chapter:99"] img.nc-page-image');return image?.complete&&image.naturalWidth>0;});
  assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'1');
  await page.screenshot({path:path.join(out,'distant-chapter.png')});
  check('an unloaded distant chapter remains readable when explicitly opened');

  // Add settings-only coverage after the existing reader scenarios to retain their request counts.
  await page.evaluate(()=>{location.hash='settings';});await channelSettings().waitFor();
  const add=page.getByRole('button',{name:'添加翻译渠道',exact:true});
  await add.scrollIntoViewIfNeeded();await add.focus();
  const beforeCancel=await add.evaluate(scrollState),beforeCancelChannels=(await read()).channels;
  await add.click();await page.getByLabel('名称',{exact:true}).fill('取消的配置');
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await add.evaluate(element=>document.activeElement===element),true);
  assert.deepEqual(await add.evaluate(scrollState),beforeCancel);
  assert.deepEqual((await read()).channels,beforeCancelChannels);
  check('cancel restores trigger focus and page scroll without saving a channel');

  const savedPasswordPlaceholder='已保存，留空继续使用';
  const savedPasswordReady=()=>page.waitForFunction(placeholder=>document.querySelector('.nc-channel-form input[type="password"]')?.placeholder===placeholder,savedPasswordPlaceholder);
  let beforeReconnect=(await read()).channels;
  let beforeLoginCount=await page.evaluate(()=>window.channelFixture.loginCount);
  await channelCard('我的本机 MTU').getByRole('button',{name:'重新连接',exact:true}).click();await savedPasswordReady();
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.required),false);
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await waitChannel(localId);
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeLoginCount+1);
  let reconnected=(await read()).channels;
  assert.equal(reconnected.profiles.length,beforeReconnect.profiles.length);
  assert.deepEqual(reconnected.profiles.find(profile=>profile.id===localId),beforeReconnect.profiles.find(profile=>profile.id===localId));
  assert(!JSON.stringify(reconnected).includes('fixture-pass'));
  check('same-service reconnect succeeds with an empty password and reuses the saved credential');

  beforeReconnect=reconnected;beforeLoginCount=await page.evaluate(()=>window.channelFixture.loginCount);
  const savedSettings=beforeReconnect.profiles.find(profile=>profile.id===localId).settings;
  await channelCard('我的本机 MTU').getByRole('button',{name:'重新连接',exact:true}).click();await savedPasswordReady();
  await page.getByLabel('用户名',{exact:true}).fill('fixture-changed');
  await page.waitForFunction(()=>document.querySelector('.nc-channel-form input[type="password"]')?.required===true);
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.validity.valueMissing),true);
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  assert.equal(await page.getByRole('dialog').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeLoginCount);
  assert.deepEqual((await read()).channels,beforeReconnect);
  await page.getByLabel('用户名',{exact:true}).fill(savedSettings.username);await savedPasswordReady();
  await page.getByLabel('服务地址',{exact:true}).fill(web+'/fixture-mtu-changed/');
  await page.waitForFunction(()=>document.querySelector('.nc-channel-form input[type="password"]')?.required===true);
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.validity.valueMissing),true);
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  assert.equal(await page.getByRole('dialog').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeLoginCount);
  await page.getByLabel('服务地址',{exact:true}).fill(savedSettings.baseUrl);await savedPasswordReady();
  check('changing the username or service address requires a password and blocks empty-password submission');

  await page.getByLabel('密码',{exact:true}).fill('incorrect');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'登录失败'}).waitFor();
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeLoginCount+1);
  assert.deepEqual((await read()).channels,beforeReconnect);
  await page.getByLabel('用户名',{exact:true}).fill('fixture-changed');
  await page.getByLabel('用户名',{exact:true}).fill(savedSettings.username);
  await page.getByLabel('密码',{exact:true}).fill('');await savedPasswordReady();
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await waitChannel(localId);
  reconnected=(await read()).channels;
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeLoginCount+2);
  assert.deepEqual(reconnected.profiles.find(profile=>profile.id===localId),beforeReconnect.profiles.find(profile=>profile.id===localId));
  assert(!JSON.stringify(reconnected).includes('fixture-pass'));
  check('a failed replacement keeps the original saved password usable after restoring the username and leaving password empty');

  const beforeInterruptedWrite=(await read()).channels;
  const beforeInterruptedLoginCount=await page.evaluate(()=>window.channelFixture.loginCount);
  const destinationB=web+'/fixture-mtu-interrupted/';
  let destinationBLogins=0;
  await page.route(destinationB+'auth/login',route=>{
    destinationBLogins++;
    return route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({success:true,token:'synthetic-interrupted-config-token'}),
    });
  });
  await channelCard('我的本机 MTU').getByRole('button',{name:'重新连接',exact:true}).click();
  await savedPasswordReady();
  await page.getByLabel('服务地址',{exact:true}).fill(destinationB);
  await page.getByLabel('密码',{exact:true}).fill('fixture-destination-b-pass');
  await page.evaluate(()=>{
    const originalSetItem=Storage.prototype.setItem;
    window.channelFixture.configurationWriteFailures=0;
    Storage.prototype.setItem=function(key,value){
      if(key==='nc-translation-channels'){
        Storage.prototype.setItem=originalSetItem;
        window.channelFixture.configurationWriteFailures++;
        throw new Error('synthetic channel configuration write failed');
      }
      return originalSetItem.call(this,key,value);
    };
  });
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'synthetic channel configuration write failed'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.nc-channel-form button[type="submit"]')?.disabled===false);
  assert.equal(destinationBLogins,1);
  assert.equal(await page.evaluate(()=>window.channelFixture.configurationWriteFailures),1);
  assert.deepEqual((await read()).channels,beforeInterruptedWrite);
  await page.getByLabel('服务地址',{exact:true}).fill(savedSettings.baseUrl);
  await page.getByLabel('密码',{exact:true}).fill('');
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.required),true);
  assert.notEqual(await page.getByLabel('密码',{exact:true}).getAttribute('placeholder'),savedPasswordPlaceholder);
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.validity.valueMissing),true);
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  assert.equal(await page.getByRole('dialog').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeInterruptedLoginCount);
  assert.equal(destinationBLogins,1);
  check('an interrupted destination change refreshes saved-password UI and blocks empty-password reuse at the old address');

  await page.getByLabel('密码',{exact:true}).fill('fixture-pass');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await waitChannel(localId);
  assert.equal(await page.evaluate(()=>window.channelFixture.loginCount),beforeInterruptedLoginCount+1);
  assert.deepEqual((await read()).channels,beforeInterruptedWrite);
  await channelCard('我的本机 MTU').getByRole('button',{name:'重新连接',exact:true}).click();
  await savedPasswordReady();
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('密码',{exact:true}).evaluate(input=>input.required),false);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.unroute(destinationB+'auth/login');
  check('an explicit password reconnect restores the old address credential and its saved-password placeholder');

  const secondName='备用 MTU · 同一服务的独立配置';
  await add.click();await page.getByLabel('名称',{exact:true}).fill(secondName);
  await page.getByLabel('服务地址',{exact:true}).fill(web+'/fixture-mtu');
  await page.getByLabel('用户名',{exact:true}).fill('fixture');await page.getByLabel('密码',{exact:true}).fill('fixture-pass');
  await page.getByRole('button',{name:'连接并使用',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const multiple=(await read()).channels,secondId=multiple.profiles.find(profile=>profile.name===secondName).id;
  assert.equal(multiple.profiles.length,3);assert.equal(multiple.activeId,secondId);await assertGuide(channelCard(secondName));
  for(const [id,name] of [[localId,'我的本机 MTU'],[secondId,secondName],['nodelane','NodeLane']]){
    await channelSettings().getByRole('radio',{name,exact:true}).click();await waitChannel(id);
    await page.reload();await dismissReleaseNotes();await waitChannel(id);
    assert.equal(await channelSettings().getByRole('radio',{name,exact:true}).isChecked(),true);
    assert.equal((await read()).channels.profiles.length,3);
  }
  check('multiple MTU configurations and NodeLane select individually and survive page reload');

  const officialRadio=channelSettings().getByRole('radio',{name:'NodeLane',exact:true});
  await officialRadio.focus();await page.keyboard.press('ArrowRight');await waitChannel(localId);
  assert.equal(await channelSettings().getByRole('radio',{name:'我的本机 MTU',exact:true}).isChecked(),true);
  assert.equal(await channelSettings().getByRole('radio',{name:'我的本机 MTU',exact:true}).evaluate(element=>document.activeElement===element),true,'keyboard channel selection must retain focus on the selected radio');
  await page.keyboard.press('ArrowLeft');await waitChannel('nodelane');
  assert.equal(await officialRadio.evaluate(element=>document.activeElement===element),true,'a second arrow key must switch without manually restoring focus');
  await channelSettings().getByRole('radio',{name:secondName,exact:true}).focus();await page.keyboard.press('Space');await waitChannel(secondId);
  check('native radio keyboard arrow and Space choose exactly one current channel');

  for(const appearance of ['light','dark']){
    await page.setViewportSize({width:360,height:800});
    await page.getByRole('combobox',{name:'亮暗外观',exact:true}).click();
    await page.getByRole('option',{name:appearance==='light'?'浅色':'深色',exact:true}).click();
    await page.waitForFunction(value=>document.documentElement.dataset.appearance===value,appearance);
    await channelSettings().scrollIntoViewIfNeeded();await assertNoHorizontalOverflow(channelSettings());
    await channelSettings().screenshot({path:path.join(out,`channel-settings-narrow-${appearance}.png`)});
    await channelCard(secondName).getByRole('button',{name:'重新连接',exact:true}).click();
    const dialog=page.getByRole('dialog');await assertGuide(dialog);await assertNoHorizontalOverflow(dialog);
    assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
    await page.screenshot({path:path.join(out,`channel-dialog-narrow-${appearance}.png`)});
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    check(`360px ${appearance} cards and reconnect dialog fit without horizontal overflow`);
  }

  await page.setViewportSize({width:1360,height:960});
  await channelCard(secondName).getByRole('button',{name:'移除',exact:true}).click();await waitChannel('nodelane');
  assert.equal((await read()).channels.profiles.length,2);assert.equal(await channelSettings().getByRole('radio',{name:secondName,exact:true}).count(),0);
  assert.equal(await channelSettings().getByRole('radio',{name:'NodeLane',exact:true}).isChecked(),true);
  await page.reload();await dismissReleaseNotes();await waitChannel('nodelane');assert.equal((await read()).channels.profiles.length,2);
  check('removing the current MTU configuration falls back to NodeLane and persists');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,readingWindow,liveProvider:false},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,checks,errors,state:await read().catch(()=>null)},null,2));throw error;}
finally{await browser.close();}
