// New source baseline: Vite at TEST_READER_URL (default :5175), isolated fresh context.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {selectOption} from './select_helpers.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web=process.env.TEST_READER_URL||'http://127.0.0.1:5175',out=path.resolve('artifacts/extension-theme-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const checks=[],errors=[],page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
page.on('pageerror',error=>errors.push(error.message));
await page.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
async function shot(name){await page.screenshot({path:path.join(out,name+'.png')});}
async function noOverflow(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflows horizontally');}
try{
 await page.goto(web);await page.locator('input[type=file]').waitFor({state:'attached'});
 await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light'})));await page.reload();
 await page.locator('input[type=file]').setInputFiles({name:'主题验收.cbz',mimeType:'application/zip',buffer:await readFile('artifacts/import-validation/pages.cbz')});
 await page.locator('.nc-page-image').first().waitFor({timeout:60000});await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.locator('.nc-book img').waitFor();await shot('library-light');
 const search=page.getByRole('searchbox',{name:'搜索漫画'});await search.focus();await shot('library-input-focus');await search.blur();
 await page.getByRole('button',{name:'更多操作 · 主题验收',exact:true}).click();await shot('comic-menu');await page.getByRole('menuitem',{name:'导出漫画',exact:true}).click();await page.getByRole('dialog').getByRole('combobox').first().click();await shot('export-dropdown');await page.keyboard.press('Escape');await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();checks.push('单来源书架、简短菜单与导出弹窗');
 await page.getByRole('button',{name:'外观与设置',exact:true}).click();
 const target=page.getByRole('combobox',{name:'默认目标语言',exact:true}),original=await target.getAttribute('data-value');await target.click();await page.getByRole('listbox').waitFor();await shot('settings-dropdown');await target.press('End');await target.press('Escape');assert.equal(await target.getAttribute('data-value'),original);assert(await target.evaluate(el=>el===document.activeElement));
 for(const [theme,label] of [['sky','晴空蓝'],['rose','樱花粉'],['mint','薄荷绿'],['iris','鸢尾紫'],['amber','琥珀橙'],['slate','石墨灰']])for(const mode of ['light','dark']){
  await page.getByRole('button',{name:label,exact:true}).click();await selectOption(page.getByRole('combobox',{name:'亮暗外观',exact:true}),mode);await noOverflow();await shot('settings-'+theme+'-'+mode);
 }
 await selectOption(page.getByRole('combobox',{name:'界面文字大小',exact:true}),'1.25');await noOverflow();await shot('settings-large-text');checks.push('6种主题色×亮暗外观、大字体、下拉键盘取消与焦点');
 await selectOption(page.getByRole('combobox',{name:'界面文字大小',exact:true}),'1');await selectOption(page.getByRole('combobox',{name:'亮暗外观',exact:true}),'light');
 await page.getByRole('button',{name:'我的账户',exact:true}).click();await shot('account-guest');await page.getByRole('button',{name:'登录账户',exact:true}).first().click();await page.getByRole('dialog').waitFor();await shot('login-light');await page.getByRole('button',{name:'关闭登录',exact:true}).click();
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.getByRole('button',{name:'继续阅读',exact:true}).click();await page.locator('.nc-page-image').first().waitFor();await shot('reader-light');
 const geometry=()=>page.locator('.nc-reading-viewport').evaluate(el=>({width:el.clientWidth,scroll:el.scrollTop})),before=await geometry();await page.getByRole('button',{name:'阅读设置',exact:true}).click();await shot('reader-settings');assert.deepEqual(await geometry(),before);checks.push('阅读设置浮层保留视口宽度与位置');
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await page.setViewportSize({width:390,height:844});await noOverflow();await shot('library-narrow');assert(await page.locator('.nc-page-heading .button').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height<90)));checks.push('窄屏来源按钮文字可读');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,liveProvider:false},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){await shot('failure');throw error;}finally{await browser.close();}
