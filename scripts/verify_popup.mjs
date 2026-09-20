// Run against a built MV3 extension in an isolated Chromium profile, never a personal browser.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const out=path.resolve('artifacts/popup-validation',randomUUID());await mkdir(out,{recursive:true});
const extension=path.join(out,'extension');await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
// Native permission prompts are not covered: pregrant only this copied test extension.
manifest.host_permissions.push('http://*/*','https://*/*');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
await writeFile(path.join(extension,'popup-fixture.js'),`
const request=chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.runtime.sendMessage=async message=>{
 const {fixtureMessages=[]}=await chrome.storage.session.get('fixtureMessages');
 await chrome.storage.session.set({fixtureMessages:[...fixtureMessages,message]});
 if(message.type==='NC_TRANSLATE_TAB'&&globalThis.fixtureTranslateFailure)return {ok:false,error:'验收：页面不允许注入脚本。'};
 if(message.type==='NC_DISCOVER_TAB')await new Promise(resolve=>setTimeout(resolve,250));
 return request(message);
};
chrome.permissions.request=permissions=>globalThis.fixtureDenyPermission?Promise.resolve(false):chrome.permissions.contains(permissions);
`);
const htmlPath=path.join(extension,'popup.html');await writeFile(htmlPath,(await readFile(htmlPath,'utf8')).replace('<head>','<head><script src="/popup-fixture.js"></script>'));
const bgPath=path.join(extension,'background.js');await writeFile(bgPath,`chrome.permissions.request=p=>chrome.permissions.contains(p);const register=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=fn=>{globalThis.fixtureMenu=fn;register(fn)};\n`+await readFile(bgPath,'utf8'));
let image;
const server=createServer((req,res)=>{
 if(req.url.startsWith('/image.png')){res.setHeader('Content-Type','image/png');res.end(image);return;}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>星之旅 · 第 12 话 — 下一页的约定</title><style>body{margin:0}img{display:block;width:600px;height:900px;margin:0 auto}</style>'+[1,2,3].map(i=>`<img src="/image.png?${i}" width="600" height="900">`).join(''));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,channel:'chromium',...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),viewport:{width:1200,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(15000);
const checks=[],errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const origin='chrome-extension://'+new URL(worker.url()).hostname;
const languageOptions=[['zh-Hans','简体中文'],['zh-Hant','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['fr','Français']];
await context.route('https://**/*',route=>{const url=route.request().url();return route.fulfill({json:url.includes('/capabilities')?{modes:[{id:'classic',enabled:true},{id:'redraw',enabled:true}],languages:languageOptions.map(([id,label])=>({id,label})),limits:{},entitlements:null}:url.includes('/auth/config')?{dev_auth:true}:{}});});
const source=await context.newPage();
const tabId=async url=>worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,url);
let popup;
async function openPopup(target=source){
 await worker.evaluate(async id=>chrome.tabs.update(id,{active:true}),await tabId(target.url()));
 const event=context.waitForEvent('page');await worker.evaluate(async origin=>chrome.tabs.create({url:origin+'/popup.html',active:false}),origin);popup=await event;await popup.setViewportSize({width:420,height:600});await popup.waitForLoadState();
 await popup.getByRole('combobox',{name:'默认目标语言'}).waitFor();
 await popup.waitForFunction(()=>!document.body.textContent.includes('正在读取当前标签页'));
 return popup;
}
const messages=()=>worker.evaluate(async()=>(await chrome.storage.session.get('fixtureMessages')).fixtureMessages??[]);
const preferences=()=>worker.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']);
const screenshot=async name=>{await popup.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));await popup.screenshot({path:path.join(out,name+'.png'),clip:{x:0,y:0,width:420,height:Math.min(600,await popup.locator('main').evaluate(el=>el.offsetHeight))}});};
try{
 await source.setContent('<body style="margin:0;width:600px;height:900px;background:#eaf3ff"><div style="margin:30px;border:5px solid #202d43;height:750px;font:40px sans-serif">HELLO!<br>TEST COMIC</div></body>');image=await source.screenshot({clip:{x:0,y:0,width:600,height:900}});
 await source.goto(site);await source.locator('img').first().evaluate(image=>image.decode());await source.evaluate(()=>scrollTo(0,80));
 await openPopup();assert.equal((await messages()).length,0);assert.equal(await popup.locator('.nc-image-picker').count(),0);await screenshot('popup-light');check('打开 Popup 不发现图片、不启动翻译、不加载缩略图');
 // Reader and popup use real shared extension storage in both directions.
 const reader=await context.newPage();await reader.goto(origin+'/reader.html#settings');await reader.getByRole('combobox',{name:'默认目标语言'}).selectOption('ja');
 await popup.waitForFunction(()=>document.querySelector('select').value==='ja');assert.equal((await preferences()).language,'ja');
 await popup.getByRole('combobox',{name:'默认目标语言'}).selectOption('en');await reader.waitForFunction(()=>document.querySelector('[aria-label="默认目标语言"]').value==='en');assert.equal((await preferences()).language,'en');check('Popup 与已打开的设置页面双向同步同一默认语言');
 await reader.evaluate(()=>{const value=JSON.parse(localStorage.getItem('nc-settings'));value.translationMode='redraw';value.direction='ltr';value.cacheLimitMb=512;localStorage.setItem('nc-settings',JSON.stringify(value));window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));});
 await popup.waitForFunction(()=>JSON.parse(localStorage.getItem('nc-settings')).translationMode==='redraw');await popup.getByRole('combobox',{name:'默认目标语言'}).selectOption('fr');
 await popup.waitForFunction(()=>!document.querySelector('select').disabled);const saved=await preferences();assert.equal(saved.translationMode,'classic');assert.equal(saved.direction,'ltr');assert.equal(saved.cacheLimitMb,512);check('新增语言回退常规模式，保留其他设置');
 await popup.close();await openPopup();assert.equal(await popup.getByRole('combobox').inputValue(),'fr');assert.equal((await messages()).length,0);check('重新打开保留语言且仍不自动发现');
 await popup.evaluate(()=>globalThis.fixtureDenyPermission=true);await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'未获得'}).waitFor();assert.equal((await messages()).length,0);await screenshot('popup-permission-denied');check('权限拒绝保留 Popup 和可重试提示');
 await popup.evaluate(()=>{globalThis.fixtureDenyPermission=false;globalThis.fixtureTranslateFailure=true;});await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'不允许注入'}).waitFor();check('启动失败保留语言和重试入口');
 await popup.evaluate(()=>globalThis.fixtureTranslateFailure=false);const scrollBefore=await source.evaluate(()=>scrollY);await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.waitForEvent('close');
 await source.waitForFunction(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));assert.equal(await source.evaluate(()=>scrollY),scrollBefore);check('Popup 启动真实网页翻译入口并关闭，原网页滚动位置保持');
 await source.goto(site);await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await globalThis.fixtureMenu({menuItemId:'nc-translate-page'},tab);},source.url());await source.waitForFunction(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));check('右键入口继续使用同一网页内翻译功能');
 await openPopup();await popup.getByRole('button',{name:'发现网页图片'}).click();await popup.getByRole('status').waitFor();await popup.getByRole('checkbox',{name:'选择网页图片 1',exact:true}).waitFor();await popup.getByRole('checkbox',{name:'选择网页图片 1',exact:true}).uncheck();await screenshot('popup-manual-discovery');await popup.close();
 await openPopup();assert.equal(await popup.locator('.nc-image-picker').count(),0);await popup.getByRole('button',{name:'发现网页图片'}).click();await popup.getByRole('checkbox',{name:'选择网页图片 1',exact:true}).waitFor();assert.equal(await popup.getByRole('checkbox',{name:'选择网页图片 1',exact:true}).isChecked(),false);check('手动发现和刷新正常，重新发现恢复选择');
 const importedEvent=context.waitForEvent('page');await popup.getByRole('button',{name:/^加入漫画/}).click();const imported=await importedEvent;await imported.waitForLoadState();const manifestId=new URL(imported.url()).searchParams.get('manifest');assert(manifestId);const selected=await worker.evaluate(async id=>(await chrome.storage.local.get('manifest:'+id))['manifest:'+id],manifestId);assert.equal(selected.items.length,2);assert(selected.items[0].url.endsWith('?2'));await imported.close();check('选中的图片按顺序交给阅读器导入');
await source.goto(site+'/new');await openPopup();await source.goto(site+'/changed');await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'网页已变化'}).waitFor();check('标签页导航后不误启动旧页面翻译');await popup.close();
 await source.goto('about:blank');await openPopup();assert(await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).isDisabled());assert(await popup.getByRole('button',{name:'发现网页图片'}).isDisabled());assert(await popup.getByRole('button',{name:'漫画管理器',exact:false}).last().isEnabled());await screenshot('popup-unavailable');check('浏览器内部页禁用网页操作，保留管理器和设置');await popup.close();
 await source.goto(site);await openPopup();
 for(const theme of ['sky','rose','mint','iris'])for(const appearance of ['light','dark']){
  await worker.evaluate(async({theme,appearance})=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],accentTheme:theme,appearance,textScale:1}});},{theme,appearance});
  await popup.waitForFunction(({theme,appearance})=>document.documentElement.dataset.accent===theme&&document.documentElement.dataset.appearance===appearance,{theme,appearance});
  assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth),420);await screenshot('popup-'+theme+'-'+appearance);
 }
 await worker.evaluate(async()=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],textScale:1.25}});});await popup.waitForFunction(()=>getComputedStyle(document.documentElement).fontSize==='20px');assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth),420);await screenshot('popup-large-text');check('四种主题亮暗外观及大字体无横向溢出');
 const popupButton=await popup.locator('.nc-comic-action').evaluate(el=>({border:getComputedStyle(el).borderWidth,radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow}));assert.equal(popupButton.border,'2px');assert.equal(popupButton.radius,'5px');
 await reader.getByRole('button',{name:'我的账户',exact:true}).click();await reader.getByRole('button',{name:'登录账户',exact:true}).first().click();await reader.getByRole('dialog').waitFor();const loginButton=await reader.locator('.nc-login-submit').evaluate(el=>({border:getComputedStyle(el).borderWidth,radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow}));assert.deepEqual(loginButton,popupButton);await reader.screenshot({path:path.join(out,'login-shared-tokens.png')});check('登录模态框与 Popup 共用描边、圆角和硬阴影令牌');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,scope:'Built MV3 in isolated Chromium; permission pregrant and no live translation provider'},null,2));console.log('Artifacts: '+out);
}finally{await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
