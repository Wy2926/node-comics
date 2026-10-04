// Run against a built MV3 extension in an isolated Chromium profile, never a personal browser.
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const out=path.resolve('artifacts/popup-validation',randomUUID());await mkdir(out,{recursive:true});
const extension=path.join(out,'extension');await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(manifest.host_permissions.includes('http://*/*')&&manifest.host_permissions.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
await writeFile(path.join(extension,'popup-fixture.js'),`
const request=chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.runtime.sendMessage=async message=>{
 const {fixtureMessages=[]}=await chrome.storage.session.get('fixtureMessages');
 await chrome.storage.session.set({fixtureMessages:[...fixtureMessages,message]});
 if(message.type==='NC_TRANSLATE_TAB'&&globalThis.fixtureTranslateFailure)return {ok:false,error:'验收：页面不允许注入脚本。'};
 if(message.type==='NC_DISCOVER_TAB')await new Promise(resolve=>setTimeout(resolve,250));
 return request(message);
};
const contains=chrome.permissions.contains.bind(chrome.permissions);
chrome.permissions.contains=permissions=>globalThis.fixtureDenyPermission?Promise.resolve(false):contains(permissions);
`);
const htmlPath=path.join(extension,'popup.html');await writeFile(htmlPath,(await readFile(htmlPath,'utf8')).replace('<head>','<head><script src="/popup-fixture.js"></script>'));
const bgPath=path.join(extension,'background.js');await writeFile(bgPath,`globalThis.fixturePermissionRequests=0;chrome.permissions.request=()=>{globalThis.fixturePermissionRequests++;throw Error('Unexpected host permission request')};const register=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=fn=>{globalThis.fixtureMenu=fn;register(fn)};\n`+await readFile(bgPath,'utf8'));
let image;
const server=createServer((req,res)=>{
 if(req.url.startsWith('/image.png')){res.setHeader('Content-Type','image/png');res.end(image);return;}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>星之旅 · 第 12 话 — 下一页的约定</title><style>body{margin:0}img{display:block;width:600px;height:900px;margin:0 auto}</style>'+[1,2,3].map(i=>`<img src="/image.png?${i}" width="600" height="900">`).join(''));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,channel:'chromium',...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),locale:'zh-CN',viewport:{width:1200,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(15000);
let permissionRequests=0;
await context.exposeBinding('fixturePermissionRequest',()=>{permissionRequests++;});
await context.addInitScript(()=>{if(location.protocol==='chrome-extension:')chrome.permissions.request=()=>{void window.fixturePermissionRequest();throw Error('Unexpected host permission request');};});
const checks=[],errors=[];let supportSubmissions=0;context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
const check=message=>{checks.push(message);console.log('PASS '+message);};
const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const origin='chrome-extension://'+new URL(worker.url()).hostname;
const languageOptions=[['zh-Hans','简体中文'],['zh-Hant','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['fr','Français']];
await context.route('https://**/*',route=>{const request=route.request(),url=request.url();if(url.includes('/v1/support-requests')&&request.method()==='POST')supportSubmissions++;if(request.isNavigationRequest())return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><title>ADAPTED SOURCE TITLE</title><body>Isolated popup fixture</body>'});return route.fulfill({json:url.includes('/capabilities')?{result_protocol:'overlay-v1',modes:[{id:'classic',enabled:true}],languages:languageOptions.map(([id,label])=>({id,label})),limits:{},entitlements:null}:url.includes('/auth/config')?{dev_auth:true}:{}});});
// Installation opens a welcome tab asynchronously; it must not steal popup/source selection.
const welcome=context.pages().find(page=>page.url()===origin+'/reader.html')??await context.waitForEvent('page',{predicate:page=>page.url()===origin+'/reader.html'});
await welcome.close();
const source=await context.newPage();
const tabId=async url=>worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,url);
let popup;
async function openPopup(target=source,{locale='zh-CN'}={}){
 await worker.evaluate(async id=>chrome.tabs.update(id,{active:true}),await tabId(target.url()));
 const event=context.waitForEvent('page',{predicate:page=>page.url()===origin+'/popup.html'});await worker.evaluate(async origin=>chrome.tabs.create({url:origin+'/popup.html',active:false}),origin);popup=await event;await popup.setViewportSize({width:420,height:600});await popup.waitForLoadState();
 await popup.locator('.nc-popup-language [role="combobox"]').waitFor();
 await popup.waitForFunction(locale=>document.documentElement.lang===locale,locale);
 await popup.waitForFunction(()=>!document.body.textContent.includes('正在读取当前标签页'));
 return popup;
}
const messages=()=>worker.evaluate(async()=>((await chrome.storage.session.get('fixtureMessages')).fixtureMessages??[])
 .filter(message=>['NC_DISCOVER_TAB','NC_TRANSLATE_TAB','NC_SEARCH_TAB'].includes(message.type)));
const preferences=()=>worker.evaluate(async()=>(await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings']);
const screenshot=async name=>{await popup.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));await popup.screenshot({path:path.join(out,name+'.png'),clip:{x:0,y:0,width:420,height:Math.min(600,await popup.locator('main').evaluate(el=>el.offsetHeight))}});};
const shortcutTexts=selector=>popup.locator(selector+' kbd').allTextContents();
async function assertPopupLayout(){
 const geometry=await popup.evaluate(()=>{
  const main=document.querySelector('main'),header=document.querySelector('.nc-popup-header'),grid=document.querySelector('.nc-popup-tool-grid');
  return {width:document.documentElement.scrollWidth,height:main.getBoundingClientRect().height,header:header.getBoundingClientRect().height,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
   tools:[...grid.children].map(el=>{const rect=el.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,overflow:el.scrollWidth>el.clientWidth};}),
   overflow:[...main.querySelectorAll('button,[role="combobox"],kbd')].filter(el=>{const rect=el.getBoundingClientRect();return rect.x<-.5||rect.right>420.5;}).map(el=>el.textContent)};
 });
 assert.equal(geometry.width,420);assert(geometry.height<=600.5);assert(geometry.header<=70,'Compact header exceeded 70 px');assert.equal(geometry.columns,2);assert.equal(geometry.tools.length,4);
 const [region,library,settings,keyboard]=geometry.tools;assert.equal(region.y,library.y);assert.equal(settings.y,keyboard.y);assert.equal(region.x,settings.x);assert.equal(library.x,keyboard.x);assert(settings.y>=region.y+region.height);assert(library.x>=region.x+region.width);
 assert(geometry.tools.every(tool=>!tool.overflow),'Tool content overflows its card');assert.deepEqual(geometry.overflow,[]);return geometry;
}
try{
 await source.setContent('<body style="margin:0;width:600px;height:900px;background:#eaf3ff"><div style="margin:30px;border:5px solid #202d43;height:750px;font:40px sans-serif">HELLO!<br>TEST COMIC</div></body>');image=await source.screenshot({clip:{x:0,y:0,width:600,height:900}});
 await source.goto(site);await source.locator('img').first().evaluate(image=>image.decode());await source.evaluate(()=>scrollTo(0,80));
 await worker.evaluate(async()=>{await chrome.storage.local.set({'nc-reader-settings':{uiLanguage:'zh-CN'}});});
 await openPopup();assert.equal((await messages()).length,0);assert.equal(await popup.locator('.nc-image-picker').count(),0);await screenshot('popup-light');console.log('Preview: '+path.join(out,'popup-light.png'));check('打开 Popup 不发现图片、不启动翻译、不加载缩略图');
 assert(!(await popup.locator('main').innerText()).includes(await source.title()));assert(!(await popup.locator('main').innerText()).includes(new URL(source.url()).hostname));assert.equal(await popup.locator('.nc-popup-cover,.nc-popup-footer').count(),0);await assertPopupLayout();check('移除网页标题和地址，顶栏不超过 70 px，四项工具为两列两行');
 const tools=popup.locator('.nc-popup-tool-grid > button');assert.deepEqual(await tools.locator(':scope > span:not(.nc-popup-shortcut)').allTextContents(),['划图翻译','我的漫画','设置','键盘快捷键']);
 await popup.waitForFunction(()=>document.querySelector('.nc-comic-action kbd')?.textContent==='Alt + Shift + T');assert.deepEqual(await shortcutTexts('.nc-comic-action'),['Alt + Shift + T']);assert.deepEqual(await shortcutTexts('.nc-popup-library'),['Alt + 1']);assert.deepEqual(await tools.nth(2).locator('kbd').allTextContents(),['Alt + ,']);assert.deepEqual(await tools.nth(3).locator('kbd').allTextContents(),['Alt + Shift + K']);
 const nativeShortcut=await worker.evaluate(async()=>(await chrome.commands.getAll()).find(command=>command.name==='nc-translate-region')?.shortcut);
 if(nativeShortcut){const display=nativeShortcut.split('+').map(value=>value.trim()==='Command'?'⌘':value.trim()).join(' + ');await popup.waitForFunction(display=>document.querySelector('.nc-popup-region kbd')?.textContent===display,display);assert.deepEqual(await shortcutTexts('.nc-popup-region'),[display]);}else assert.deepEqual(await shortcutTexts('.nc-popup-region'),[]);
 check('主操作、漫画库、设置和快捷键显示默认组合键，划图取浏览器 commands.getAll 的实际配置');
 const customShortcuts={'web.translate':['Alt+Shift+KeyY','Ctrl+Alt+KeyT'],'app.library':[],'app.settings':['Alt+KeyB'],'web.shortcuts':['Alt+Shift+KeyU','Ctrl+Alt+KeyK']};
 await worker.evaluate(async overrides=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides}}),customShortcuts);await popup.waitForFunction(()=>document.querySelector('.nc-comic-action kbd')?.textContent==='Alt + Shift + Y');
 assert.deepEqual(await shortcutTexts('.nc-comic-action'),['Alt + Shift + Y','Ctrl + Alt + T']);assert.deepEqual(await shortcutTexts('.nc-popup-library'),[]);assert.deepEqual(await tools.nth(2).locator('kbd').allTextContents(),['Alt + B']);assert.deepEqual(await tools.nth(3).locator('kbd').allTextContents(),['Alt + Shift + U','Ctrl + Alt + K']);await assertPopupLayout();await screenshot('popup-custom-shortcuts');check('快捷键跟随当前偏好，显示两个替代键，禁用的组合键不显示');
 await worker.evaluate(async()=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides:{}}}));await popup.waitForFunction(()=>document.querySelector('.nc-comic-action kbd')?.textContent==='Alt + Shift + T');
 await popup.close();
 for(const fixture of [{url:'https://mangapill.com/',name:'adapted-home',importable:false,notice:true},{url:'https://manga-one.com/',name:'adapted-inline-only',importable:false,notice:false},{url:'https://mangapill.com/manga/1/one-piece',name:'adapted-comic',importable:true,notice:false}]){
  await source.goto(fixture.url);await openPopup();assert.equal(await popup.locator('.nc-popup-adapted').innerText(),'已适配');assert.equal(await popup.getByRole('button',{name:'开始阅读',exact:true}).count(),fixture.importable?1:0);assert.equal(await popup.getByText('进入漫画详情页或章节页后，可开始阅读。',{exact:true}).count(),fixture.notice?1:0);
  const text=await popup.locator('main').innerText();assert(!text.includes('ADAPTED SOURCE TITLE'));assert(!text.includes(new URL(fixture.url).hostname));assert.equal((await messages()).length,0);const geometry=await assertPopupLayout();if(fixture.importable){const scroll=await popup.locator('.nc-popup-scroll').boundingBox();assert(geometry.tools.every(tool=>tool.y>=scroll.y&&tool.y+tool.height<=scroll.y+scroll.height+.5),'Adapted comic tools must all be visible before scrolling at the default text scale');}await screenshot('popup-'+fixture.name);await popup.close();
 }
 check('专门适配的主页、仅网页翻译网站和漫画详情页均有文字标志，按页面能力提供阅读入口');
 await source.goto(site);await openPopup();const requestSize=await popup.locator('.nc-popup-request').boundingBox();assert(requestSize.height<40);assert(requestSize.width<180);const requestPageEvent=context.waitForEvent('page'),requestClosing=popup.waitForEvent('close');await popup.getByRole('button',{name:'申请适配网站',exact:true}).evaluate(button=>{button.click();button.click();button.click();});await requestClosing;const requestPage=await requestPageEvent;
 await requestPage.waitForURL(origin+'/reader.html#sites/request');await requestPage.getByRole('textbox',{name:'网站名称',exact:true}).waitFor();await requestPage.waitForFunction(()=>document.activeElement===document.querySelector('.nc-site-request .nc-support-form fieldset input'));
 const requestRect=await requestPage.locator('.nc-site-request').boundingBox();assert(requestRect.y<900&&requestRect.y+requestRect.height>0);assert.equal(await requestPage.locator('dialog[open]').count(),0);assert.equal(supportSubmissions,0);assert.equal(context.pages().filter(page=>page.url()===origin+'/reader.html#sites/request').length,1);await requestPage.screenshot({path:path.join(out,'site-request-focused.png')});await requestPage.close();check('小型申请入口重复点击只打开一份现有网站表单并关闭 Popup，滚动定位并聚焦网站名称，无额外弹窗且未提交申请');await openPopup();
 for(const {binding,destination} of [{binding:'Alt+1',destination:'library'},{binding:'Alt+,',destination:'settings'},{binding:'Alt+Shift+K',destination:'shortcuts'}]){
  const openedEvent=context.waitForEvent('page'),closing=popup.waitForEvent('close');const [opened]=await Promise.all([openedEvent,closing,popup.keyboard.press(binding).catch(error=>{if(!popup.isClosed())throw error;})]);
  if(destination==='library')await opened.waitForURL(origin+'/reader.html');
  else if(destination==='shortcuts'){await opened.waitForURL(origin+'/reader.html#settings/shortcuts');await opened.locator('.nc-shortcut-panel[open]').waitFor();assert.equal(await opened.locator('.nc-shortcut-group[data-shortcut-scope="web"]').count(),1);}
  else {await opened.waitForURL(url=>url.href.startsWith('chrome://extensions/')&&url.search.includes('options='));}
  await opened.close();await openPopup();
 }
 check('实际按显示的快捷键可打开漫画库、扩展设置和网页快捷键面板，并关闭 Popup');
 await worker.evaluate(async()=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides:{'app.library':['Alt+Shift+KeyT']}}}));await popup.waitForFunction(()=>document.querySelector('.nc-popup-library kbd')?.textContent==='Alt + Shift + T');assert.deepEqual(await shortcutTexts('.nc-comic-action'),[]);
 const collisionPageEvent=context.waitForEvent('page'),collisionClosing=popup.waitForEvent('close');const [collisionPage]=await Promise.all([collisionPageEvent,collisionClosing,popup.keyboard.press('Alt+Shift+T').catch(error=>{if(!popup.isClosed())throw error;})]);await collisionPage.waitForURL(origin+'/reader.html');assert.equal((await messages()).length,0);await collisionPage.close();await worker.evaluate(async()=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides:{}}}));await openPopup();check('漫画库与网页翻译使用同键时，仅显示实际可执行的库入口，按键确实打开漫画库');
 if(nativeShortcut==='Alt+Shift+R'){
  await worker.evaluate(async()=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides:{'app.library':['Alt+Shift+KeyR']}}}));await popup.waitForFunction(()=>!document.querySelector('.nc-popup-library kbd'));assert.deepEqual(await shortcutTexts('.nc-popup-region'),['Alt + Shift + R']);await worker.evaluate(async()=>chrome.storage.local.set({'nc-shortcuts':{version:1,overrides:{}}}));await popup.waitForFunction(()=>document.querySelector('.nc-popup-library kbd')?.textContent==='Alt + 1');check('本机快捷键撞浏览器划图快捷键时隐藏不可执行提示，保留真实划图组合键');
 }
 await worker.evaluate(async()=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],textScale:1.25},'nc-shortcuts':{version:1,overrides:{'app.settings':['Ctrl+Alt+Shift+Meta+PageDown','Ctrl+Alt+Shift+Meta+ArrowRight']}}});});await popup.waitForFunction(()=>getComputedStyle(document.documentElement).fontSize==='20px'&&document.querySelectorAll('.nc-popup-tool-grid > button:nth-child(3) kbd').length===2);await assertPopupLayout();await screenshot('popup-long-shortcuts-large-text');check('两个长替代键在 1.25 字号下完整换行，卡片内部和 Popup 均无横向溢出');
 await worker.evaluate(async()=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],textScale:1},'nc-shortcuts':{version:1,overrides:{}}});});await popup.waitForFunction(()=>getComputedStyle(document.documentElement).fontSize==='16px'&&document.querySelector('.nc-popup-tool-grid > button:nth-child(3) kbd')?.textContent==='Alt + ,');
 // Reader and popup use real shared extension storage in both directions.
 const reader=await context.newPage();await reader.goto(origin+'/reader.html#settings');await reader.getByRole('button',{name:'知道了',exact:true}).click();await selectOption(reader.getByRole('combobox',{name:'默认目标语言'}),'ja');
 await popup.waitForFunction(()=>document.querySelector('[role="combobox"][aria-label="默认目标语言"]')?.getAttribute('data-value')==='ja');assert.equal((await preferences()).language,'ja');
 await selectOption(popup.getByRole('combobox',{name:'默认目标语言'}),'en');await reader.waitForFunction(()=>document.querySelector('[role="combobox"][aria-label="默认目标语言"]')?.getAttribute('data-value')==='en');assert.equal((await preferences()).language,'en');check('Popup 与已打开的设置页面双向同步同一默认语言');
 await reader.evaluate(()=>{const value=JSON.parse(localStorage.getItem('nc-settings'));value.direction='ltr';value.cacheLimitMb=512;localStorage.setItem('nc-settings',JSON.stringify(value));window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));});
 await popup.waitForFunction(()=>JSON.parse(localStorage.getItem('nc-settings')).cacheLimitMb===512);await selectOption(popup.getByRole('combobox',{name:'默认目标语言'}),'fr');
 await popup.waitForFunction(()=>{const trigger=document.querySelector('[role="combobox"][aria-label="默认目标语言"]');return trigger&&!trigger.matches(':disabled,[aria-disabled="true"]');});const saved=await preferences();assert(!Object.hasOwn(saved,'translationMode'));assert.equal(saved.direction,'ltr');assert.equal(saved.cacheLimitMb,512);check('切换目标语言保留其他偏好，不持久化已移除的模式设置');
 await popup.close();await openPopup();assert.equal(await popup.getByRole('combobox').getAttribute('data-value'),'fr');assert.equal((await messages()).length,0);check('重新打开保留语言且仍不自动发现');
 await popup.evaluate(()=>globalThis.fixtureDenyPermission=true);await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'网站访问权限已被浏览器关闭'}).waitFor();assert.equal((await messages()).length,0);await screenshot('popup-permission-denied');check('模拟网站访问受限阻止启动，保留 Popup 和扩展设置提示');
 await popup.evaluate(()=>{globalThis.fixtureDenyPermission=false;globalThis.fixtureTranslateFailure=true;});await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'不允许注入'}).waitFor();check('启动失败保留语言和重试入口');
 await popup.evaluate(()=>globalThis.fixtureTranslateFailure=false);const scrollBefore=await source.evaluate(()=>scrollY);await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.waitForEvent('close');
 await source.waitForFunction(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));assert.equal(await source.evaluate(()=>scrollY),scrollBefore);check('Popup 启动真实网页翻译入口并关闭，原网页滚动位置保持');
 await source.goto(site);await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await globalThis.fixtureMenu({menuItemId:'nc-translate-page'},tab);},source.url());await source.waitForFunction(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));check('右键入口继续使用同一网页内翻译功能');
 await openPopup();assert.equal(await popup.getByRole('button',{name:'发现网页图片'}).count(),0);assert.equal(await popup.getByRole('button',{name:'开始阅读',exact:true}).count(),0);const rejected=await popup.evaluate(tabId=>chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId}),await tabId(source.url()));assert.equal(rejected.ok,false);check('未适配网页没有导入入口，直接消息调用也拒绝导入');await popup.close();
await source.goto(site+'/new');await openPopup();await source.goto(site+'/changed');await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.getByRole('alert').filter({hasText:'网页已变化'}).waitFor();check('标签页导航后不误启动旧页面翻译');await popup.close();
 await source.goto('about:blank');await openPopup();assert(await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).isDisabled());assert.equal(await popup.getByRole('button',{name:'开始阅读',exact:true}).count(),0);assert(await popup.getByRole('button',{name:'我的漫画',exact:false}).last().isEnabled());await screenshot('popup-unavailable');check('浏览器内部页禁用网页操作，保留管理器和设置');await popup.close();
 await source.goto(site);await openPopup();
 for(const theme of ['sky','rose','mint','iris','amber','slate'])for(const appearance of ['light','dark']){
  await worker.evaluate(async({theme,appearance})=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],accentTheme:theme,appearance,textScale:1}});},{theme,appearance});
  await popup.waitForFunction(({theme,appearance})=>document.documentElement.dataset.accent===theme&&document.documentElement.dataset.appearance===appearance,{theme,appearance});
  assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth),420);await screenshot('popup-'+theme+'-'+appearance);
 }
 await worker.evaluate(async()=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],textScale:1.25}});});await popup.waitForFunction(()=>getComputedStyle(document.documentElement).fontSize==='20px');await assertPopupLayout();await screenshot('popup-large-text');check('六种主题亮暗外观及 1.25 字号无横向溢出');
 for(const locale of ['en','de']){
  await popup.close();await worker.evaluate(async locale=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],uiLanguage:locale,textScale:1.25}});},locale);await openPopup(source,{locale});await popup.waitForFunction(()=>getComputedStyle(document.documentElement).fontSize==='20px');await assertPopupLayout();await screenshot('popup-'+locale+'-large-text');
 }
 await popup.close();await worker.evaluate(async()=>{const key='nc-reader-settings',data=await chrome.storage.local.get(key);await chrome.storage.local.set({[key]:{...data[key],uiLanguage:'zh-CN'}});});await openPopup();await reader.waitForFunction(()=>document.documentElement.lang==='zh-CN');check('英文和德文在 1.25 字号仍保持两列工具布局，无横向溢出');
 await popup.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));const popupButton=await popup.locator('.nc-comic-action').evaluate(el=>({border:getComputedStyle(el).borderWidth,radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow}));assert.equal(popupButton.border,'2px');assert.equal(popupButton.radius,'5px');
 await reader.getByRole('button',{name:'我的账户',exact:true}).click();await reader.getByRole('button',{name:'登录账户',exact:true}).first().click();await reader.getByRole('dialog').waitFor();await reader.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));const loginButton=await reader.locator('.nc-login-submit').evaluate(el=>({border:getComputedStyle(el).borderWidth,radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow}));assert.deepEqual(loginButton,popupButton);await reader.screenshot({path:path.join(out,'login-shared-tokens.png')});check('登录模态框与 Popup 共用描边、圆角和硬阴影令牌');

 // Automatic translation stays opt-in, shares the reader preference, and respects page controls.
 await reader.getByRole('button',{name:'关闭登录',exact:true}).click();await reader.getByRole('button',{name:'外观与设置',exact:true}).click();
 await popup.close();await source.goto(site+'/automatic');await openPopup();
 const autoSwitch=page=>page.getByRole('switch',{name:'标签页自动翻译',exact:true});
 assert.equal(await autoSwitch(popup).getAttribute('aria-checked'),'false');
 await popup.evaluate(()=>globalThis.fixtureDenyPermission=true);await autoSwitch(popup).click();await popup.getByRole('alert').filter({hasText:'网站访问权限已被浏览器关闭'}).waitFor();assert.equal((await preferences()).autoTranslateTabs,false);check('模拟网站访问受限时自动翻译保持关闭');
 await popup.evaluate(()=>globalThis.fixtureDenyPermission=false);await autoSwitch(popup).click();await reader.waitForFunction(()=>document.querySelector('[role="switch"][aria-label="标签页自动翻译"]').getAttribute('aria-checked')==='true');await source.bringToFront();
 const hostVisible=()=>source.waitForFunction(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));
 const hostHidden=()=>source.waitForFunction(()=>![...document.documentElement.children].some(el=>el.style.zIndex==='2147483646'));
 await hostVisible();assert.equal((await preferences()).autoTranslateTabs,true);await autoSwitch(popup).scrollIntoViewIfNeeded();await screenshot('popup-auto-enabled');await autoSwitch(reader).scrollIntoViewIfNeeded();await reader.screenshot({path:path.join(out,'settings-auto-enabled.png')});check('Popup 开启自动翻译同步设置，并自动启动当前网页');
 const sourceCDP=await context.newCDPSession(source);
 async function inlineButton(name,click=false){
  const {nodes}=await sourceCDP.send('Accessibility.getFullAXTree');const node=nodes.find(node=>node.role?.value==='button'&&node.name?.value===name);assert(node,'Missing inline button '+name);
  if(click){const {model}=await sourceCDP.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId}),q=model.content;await source.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);}
 }
 await inlineButton('暂停',true);await reader.bringToFront();await source.bringToFront();await inlineButton('继续');
 await inlineButton('关闭',true);await hostHidden();await reader.bringToFront();await source.bringToFront();
 const identity=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);return chrome.tabs.sendMessage(tab.id,{type:'NC_INLINE_IDENTITY'});},source.url());assert.equal(identity.enabled,false);assert.equal(identity.dismissedUrl,source.url());check('自动启动不覆盖同页的暂停和关闭选择');
 await source.reload();await hostVisible();check('刷新网页自动恢复候选图片识别');
 await source.evaluate(()=>history.pushState({},'', '/automatic-next'));await source.waitForFunction(()=>location.pathname==='/automatic-next');
 // Observe the durable activation rather than assuming a SPA navigation has completed.
 for(let attempts=0;attempts<100;attempts++){const active=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);return (await chrome.storage.session.get('nc-inline:'+tab.id))['nc-inline:'+tab.id];},source.url());if(active?.url===source.url())break;if(attempts===99)throw Error('SPA activation did not follow navigation');await new Promise(resolve=>setTimeout(resolve,30));}
 await hostVisible();check('同文档跳转后按新网页范围继续自动翻译');
 await autoSwitch(reader).click();await popup.waitForFunction(()=>document.querySelector('[role="switch"][aria-label="标签页自动翻译"]').getAttribute('aria-checked')==='false');await hostHidden();check('设置关闭同步 Popup，并停止已自动启动的网页');
 await source.reload();assert.equal(await source.evaluate(()=>[...document.documentElement.children].some(el=>el.style.zIndex==='2147483646')),false);
 await popup.close();await openPopup();assert.equal(await autoSwitch(popup).getAttribute('aria-checked'),'false');await popup.getByRole('button',{name:'翻译当前标签页',exact:true}).click();await popup.waitForEvent('close');await hostVisible();check('关闭自动翻译后，手动翻译按钮仍可使用');
 assert.equal(permissionRequests,0);assert.equal(await worker.evaluate(()=>globalThis.fixturePermissionRequests),0);check('Popup、设置和后台全流程没有申请网站访问权限');
 assert.equal(supportSubmissions,0);assert.deepEqual(errors,[]);await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,permissionRequests,supportSubmissions,nativeShortcut,scope:'Built MV3 in isolated Chromium; local image fixture, intercepted adapted-site navigation and API responses, simulated access restrictions and no live translation provider'},null,2));console.log('Artifacts: '+out);console.log('Checks: '+checks.length);
}catch(failure){
 if(popup&&!popup.isClosed()){await popup.screenshot({path:path.join(out,'popup-failure.png')}).catch(()=>{});await writeFile(path.join(out,'popup-failure.html'),await popup.content().catch(()=>''));}
 await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,permissionRequests,supportSubmissions,failure:{message:failure.message,stack:failure.stack},pages:context.pages().map(page=>page.url()),scope:'Built MV3 in isolated Chromium; fixture and simulated API responses'},null,2));console.log('Failed artifacts: '+out);throw failure;
}finally{await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
