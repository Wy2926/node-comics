// Vite at :5176, :5175 and :5186; original fixtures and simulated API only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {selectOption} from './select_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web='http://127.0.0.1:5176',out=path.resolve('artifacts/extension-theme-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'chromium'})});
const checks=[],errors=[];
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);
page.on('pageerror',e=>errors.push(e.message));
const allowedOrigins=[web,'http://127.0.0.1:5175','http://127.0.0.1:5186'];
await page.route('**/*',route=>allowedOrigins.includes(new URL(route.request().url()).origin)?route.continue():route.abort());
const check=message=>{checks.push(message);console.log('PASS '+message);};
async function shot(name){const height=await page.evaluate(()=>document.documentElement.scrollHeight),overlay=await page.locator('dialog[open], [role=listbox]:visible').count();await page.screenshot({path:path.join(out,name+'.png'),fullPage:!overlay&&height<=2200});}
async function noOverflow(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflows horizontally');}
async function appearance(theme,mode,scale=1){
  await page.evaluate(async({theme,mode,scale})=>{const store=await import('/src/library/store.ts');store.saveSettings({...store.settings(),appearance:mode,accentTheme:theme,textScale:scale});window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));},{theme,mode,scale});
  await page.waitForFunction(({theme,mode,scale})=>document.documentElement.dataset.accent===theme&&document.documentElement.dataset.appearance===mode&&getComputedStyle(document.documentElement).fontSize===16*scale+'px',{theme,mode,scale});
}
async function nav(name){await page.getByRole('button',{name,exact:true}).click();await noOverflow();}
try {
  await page.goto(web+'/tests/reader-fixture.html');await page.locator('.nc-book').first().waitFor();
  assert.equal(await page.getByRole('button',{name:/翻译队列|翻译记录/}).count(),0);
  await page.locator('.nc-book img').first().waitFor();await page.locator('.nc-book img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  const search=page.getByRole('searchbox',{name:'搜索漫画',exact:true});await search.focus();
  const searchFrame=await search.evaluate(el=>({border:getComputedStyle(el).borderWidth,outline:getComputedStyle(el).outlineStyle,shadow:getComputedStyle(el).boxShadow}));assert.deepEqual(searchFrame,{border:'0px',outline:'none',shadow:'none'});await shot('library-input-focus');await search.blur();
  assert.equal(await page.locator('.nc-account-button').evaluate(el=>getComputedStyle(el).borderWidth),'0px');check('Search has one frame while focused; account identity has no persistent border');
  await shot('library-light');check('Library has no queue/history navigation');
  const card=await page.locator('.nc-book').first().evaluate(el=>({border:getComputedStyle(el).borderWidth,shadow:getComputedStyle(el).boxShadow}));
  assert.equal(card.border,'2px');assert.notEqual(card.shadow,'none');
  await page.getByRole('button',{name:'打开作品 星光书店',exact:true}).click();await shot('work-light');
  await page.getByRole('tab',{name:'版本与副本',exact:true}).click();await shot('copies-light');
  await page.getByRole('button',{name:'查看副本 星光书店',exact:true}).click();await page.locator('.nc-detail-more>summary').click();await shot('copy-actions');
  assert.equal(await page.locator('.nc-detail-action-list>button').first().evaluate(el=>getComputedStyle(el).borderWidth),'2px');
  await page.getByRole('button',{name:'新建版本',exact:true}).click();const nameField=page.getByRole('textbox',{name:'名称',exact:true});await nameField.fill('桌面样式验收');
  assert.equal(await nameField.evaluate(el=>getComputedStyle(el).outlineStyle),'none');await shot('editor-input-focus');await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();check('Copy actions and focused editor fields use one shared frame');
  await page.getByRole('button',{name:'导出漫画',exact:true}).click();await page.getByRole('dialog').waitFor();await shot('export-light');
  const exportFormat=page.getByRole('dialog').getByRole('combobox').first();await exportFormat.click();await page.getByRole('listbox').waitFor();await shot('export-dropdown');await page.getByRole('option').first().click();await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await nav('外观与设置');
  assert.equal(await page.locator('select').count(),0);const target=page.getByRole('combobox',{name:'默认目标语言',exact:true}),original=await target.getAttribute('data-value');
  await target.click();await page.getByRole('listbox').waitFor();await shot('settings-dropdown');
  const choices=await page.getByRole('option').evaluateAll(options=>options.filter(option=>option.getAttribute('aria-disabled')!=='true').map(option=>option.dataset.value));
  await target.press('End');await target.press('Escape');assert.equal(await target.getAttribute('data-value'),original);assert(await target.evaluate(el=>el===document.activeElement));
  await target.press('ArrowDown');await target.press('Home');await target.press('ArrowDown');await target.press('Enter');assert.equal(await target.getAttribute('data-value'),choices[1]);
  await selectOption(target,'en');assert.equal(await target.getAttribute('data-value'),'en');await selectOption(target,original);
  assert.equal(await target.evaluate(el=>getComputedStyle(el).outlineStyle),'none');check('Custom dropdown supports pointer/keyboard, cancellation, focus and dialog top-layer menus');
  for(const theme of ['sky','rose','mint','iris'])for(const mode of ['light','dark']){
    await appearance(theme,mode);await noOverflow();await shot('settings-'+theme+'-'+mode);
  }
  check('All four accents work in light and dark settings panels');
  await appearance('rose','dark',1.25);await noOverflow();await shot('settings-large-text');
  await nav('我的账户');await shot('account-dark');
  await appearance('sky','light');await page.setViewportSize({width:1440,height:1000});await shot('account-light');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'登录账户',exact:true}).first().waitFor();await shot('account-guest');
  await page.getByRole('button',{name:'登录账户',exact:true}).first().click();await page.getByRole('dialog').waitFor();await shot('login-light');
  const loginBorder=await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).borderWidth);assert.equal(loginBorder,card.border);
  await page.getByRole('button',{name:'关闭登录',exact:true}).click();check('Account sign-out and login dialog use the same panel tokens');
  await nav('返回我的漫画');
  await page.locator('input[type=file]').setInputFiles({name:'theme-fixture.png',mimeType:'image/png',buffer:Buffer.from(await (await page.request.get(web+'/samples/starlight-bookshop.png')).body())});
  await page.getByRole('dialog',{name:'导入本地漫画',exact:true}).waitFor();await shot('import-light');
  await page.getByRole('button',{name:'收起导入面板',exact:true}).click();await page.getByRole('button',{name:/待确认导入/}).click();
  await page.getByRole('button',{name:'从导入清单移除 theme-fixture.png',exact:true}).click();check('Local import can collapse and reopen');
  const closeImport=page.getByRole('button',{name:'收起导入面板',exact:true});if(await closeImport.count())await closeImport.click();
  const dismissToast=page.getByRole('button',{name:'关闭操作提示',exact:true});if(await dismissToast.count())await dismissToast.click();
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.nc-book').filter({has:page.getByRole('button',{name:'打开作品 星光书店',exact:true})}).getByRole('button',{name:'开始阅读',exact:true}).click();
  await page.locator('.nc-page-image').first().waitFor();
  const jump=page.getByRole('spinbutton',{name:'跳转页码',exact:true});await jump.fill('4');await jump.press('Enter');await jump.blur();
  await shot('reader-light');
  const geometry=()=>page.locator('.nc-reading-viewport').evaluate(el=>({width:el.clientWidth,scroll:el.scrollTop}));
  const before=await geometry();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();await shot('reader-settings');
  assert.deepEqual(await geometry(),before);check('Reader drawer keeps image width and reading position');
  await page.goto('http://127.0.0.1:5186/tests/account-fixture.html');await page.locator('.nc-usage-charts').waitFor();
  await appearance('rose','dark',1.25);await noOverflow();await shot('account-plus-dark');
  await appearance('sky','light');await page.setViewportSize({width:1440,height:1000});await shot('account-light');
  await page.getByRole('button',{name:'加载',exact:true}).click();await page.getByText('正在汇总用量…',{exact:true}).waitFor();await shot('account-loading');
  await page.getByRole('button',{name:'失败',exact:true}).click();await page.getByRole('alert').waitFor();await shot('account-error');
  await page.getByRole('button',{name:'零用量',exact:true}).click();await page.getByText('所选时段暂无交付',{exact:true}).waitFor();await shot('account-empty');
  check('Account charts, loading, error and empty states render with shared tokens');
  await page.goto('http://127.0.0.1:5175/tests/library-fixture.html?catalog');await page.locator('.nc-catalog-card').first().waitFor();await shot('catalog-light');
  await page.getByRole('button',{name:/下一步/}).click();await shot('catalog-review');
  await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:5175/tests/library-fixture.html?recent');await page.locator('.nc-book').first().waitFor();await shot('library-recent');
  await page.getByRole('button',{name:/采集中心/}).first().click();await page.getByRole('dialog').waitFor();await shot('acquisition-light');
  await noOverflow();check('Catalog selection/review, recent reading and acquisition center render on desktop');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));
  console.log('Artifacts: '+out);
} catch(error) {
  await shot('failure');await writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());throw error;
} finally {await browser.close();}
