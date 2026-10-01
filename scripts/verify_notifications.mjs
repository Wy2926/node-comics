/** Desktop Chrome regression; isolated Vite fixtures and synthetic identity/API only. */
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.NOTIFICATION_FIXTURE_URL||'http://127.0.0.1:5187';
assert.equal(new URL(base).origin,'http://127.0.0.1:5187','Fixture origin must remain isolated.');
const output=path.join(root,'artifacts/notifications');await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-')),checks=[],errors=[],external=[];
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chrome'})});
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',colorScheme:'light'});
await context.route(/^https?:\/\//,route=>{
 const url=new URL(route.request().url());
 if(url.origin===base)return route.continue();
 external.push(url.origin);return route.abort();
});
await context.addInitScript(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light',layout:'single'})));
let page=await context.newPage(),phase='shared component';
page.on('pageerror',error=>errors.push(error.message));
const notice=()=>page.locator('.nc-notification');
const screenshot=name=>page.screenshot({path:path.join(run,name+'.png')});
async function advance(ms){await page.clock.runFor(ms);}
async function show(label){await page.getByRole('button',{name:label,exact:true}).click();await notice().waitFor();await page.mouse.move(1,1);}
try{
 await page.goto(base+'/tests/notifications-fixture.html');await page.clock.install();
 await show('错误提示');assert.equal(await notice().getAttribute('role'),'alert');
 await advance(11900);assert.equal(await notice().count(),1);await advance(200);assert.equal(await notice().count(),0);
 checks.push('普通错误提示 12 秒后自动收起，使用 alert 可访问性角色');
 await show('成功提示');assert.equal(await notice().getAttribute('role'),'status');
 await advance(5900);assert.equal(await notice().count(),1);await advance(200);assert.equal(await notice().count(),0);
 checks.push('成功提示 6 秒后自动收起，使用 status 可访问性角色');
 await show('信息提示');await notice().hover();await advance(13000);assert.equal(await notice().count(),1);
 await page.mouse.move(1,1);await advance(11900);assert.equal(await notice().count(),1);await advance(200);assert.equal(await notice().count(),0);
 checks.push('悬停期间暂停，移开后完整 12 秒收起');
 await show('信息提示');await notice().locator('.nc-notification-action').focus();await advance(13000);assert.equal(await notice().count(),1);
 await page.getByRole('textbox',{name:'提示之外的焦点'}).focus();await advance(12100);assert.equal(await notice().count(),0);
 checks.push('提示内键盘焦点暂停，焦点离开后计时');
 await show('信息提示');await page.getByRole('button',{name:'切换模拟页面隐藏'}).click();await advance(13000);assert.equal(await notice().count(),1);
 await page.getByRole('button',{name:'切换模拟页面隐藏'}).click();await advance(12100);assert.equal(await notice().count(),0);
 checks.push('模拟 document.hidden 与 visibilitychange 暂停和恢复计时');
 await show('信息提示');await notice().locator('.nc-notification-close').focus();await page.keyboard.press('Escape');assert.equal(await notice().count(),0);
 await show('信息提示');await notice().getByRole('button',{name:'重新登录'}).click();assert.equal(await notice().count(),0);assert.match(await page.getByTestId('metrics').innerText(),/登录入口 1 次/);
 checks.push('关闭按钮、Escape 和重新登录动作均能移除提示；动作只执行一次');
 for(const appearance of ['light','dark']){
  await page.evaluate(value=>document.documentElement.dataset.appearance=value,appearance);
  await show('长文本提示');
  const bounds=await notice().boundingBox(),body=await notice().locator('p').evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth}));
  assert(bounds.width<=420&&bounds.height<300);assert(bounds.x>=0&&bounds.x+bounds.width<=1440);assert(body.scrollHeight>body.height);assert(body.scrollWidth<=body.width+1);
  await screenshot('shared-long-'+appearance);
  await notice().locator('.nc-notification-close').click();
 }
 checks.push('桌面浅色 / 深色长文本宽度受限、内容可滚动、长链接不横向撑开');
 phase='reader image notices';await page.close();page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/tests/notifications-fixture.html?reader=1');
 const translation=page.getByTestId('translation-picture'),picture=page.getByTestId('blob-picture');
 await page.waitForFunction(()=>document.querySelector('[data-testid="blob-picture"] .nc-page-image')?.naturalWidth>0);
 for(const [label,metric] of [['设为登录错误','登录 1'],['设为额度错误','升级 1'],['设为可重试错误','重试 1']]){
  await page.getByRole('button',{name:label,exact:true}).click();
  await translation.locator('.nc-image-translation-dismiss').click();
  const compact=translation.locator('.is-collapsed');await compact.waitFor();
  const bounds=await compact.boundingBox();assert.equal(bounds.width,30);assert.equal(bounds.height,30);assert.equal(await compact.locator('.nc-translation-message').count(),0);
  await page.getByRole('button',{name:'重发同一状态',exact:true}).click();assert.equal(await compact.count(),1);
  await compact.click();assert((await page.getByTestId('reader-metrics').innerText()).includes(metric));
 }
 await page.getByRole('button',{name:'设为不可重试错误',exact:true}).click();await translation.locator('.nc-image-translation-dismiss').click();
 await translation.locator('.is-collapsed').click();await translation.locator('.is-dismissible').waitFor();
 await translation.locator('.nc-image-translation-dismiss').click();
 await page.getByRole('button',{name:'新图片读取失败',exact:true}).click();await picture.locator('.nc-image-failure.over-image').waitFor();
 const retained=await picture.locator('.nc-page-image').getAttribute('src');
 await picture.locator('.nc-image-failure-dismiss').click();await picture.locator('.nc-image-failure-retry').waitFor();assert.equal(await picture.locator('.nc-image-failure').count(),0);assert.equal(await picture.locator('.nc-page-image').getAttribute('src'),retained);
 await screenshot('reader-notices-collapsed');
 await picture.locator('.nc-image-failure-retry').click();await picture.locator('.nc-image-failure.over-image').waitFor();
 await picture.locator('.nc-image-failure-dismiss').click();await page.getByRole('button',{name:'新图片再次失败',exact:true}).click();await picture.locator('.nc-image-failure.over-image').waitFor();
 await page.getByRole('button',{name:'补回缺失图片',exact:true}).click();await page.locator('[data-testid="cache-restore"][data-state="complete"]').waitFor();await picture.getByRole('button',{name:'重试',exact:true}).click();await picture.locator('.nc-image-failure').waitFor({state:'hidden'});
 await picture.locator('.nc-page-image').waitFor();assert.notEqual(await picture.locator('.nc-page-image').getAttribute('src'),retained);
 await page.getByRole('button',{name:'空图片失败',exact:true}).click();await picture.locator('.nc-image-failure:not(.over-image)').waitFor();assert.equal(await picture.locator('.nc-image-failure-dismiss').count(),0);assert.equal(await picture.getByRole('button',{name:'重新导入',exact:true}).count(),1);
 checks.push('阅读图片登录 / 额度 / 错误提示可收成 30px 图标，原动作保留；相同状态不重现，新状态展开');
 checks.push('新图片读取失败可关闭并保留旧原图，小图标可重试；新失败重新展开、恢复缓存成功、无图时保留空状态');
 phase='real App auth lifecycle';await page.close();page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/tests/auth-lifecycle-fixture.html');
 await page.getByRole('button',{name:'打开漫画 会话过期时继续阅读',exact:true}).click();
 const jump=page.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('2');await jump.press('Enter');
 await page.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
 const workspaceBefore=await page.locator('#nc-workspace').boundingBox();
 await page.getByRole('button',{name:'模拟授权撤销',exact:true}).click();
 await notice().filter({hasText:'登录已过期'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
 assert.equal(await page.locator('.global-error').count(),0);assert.equal(await jump.inputValue(),'2');
 assert.equal((await page.locator('#nc-workspace').boundingBox()).y,workspaceBefore.y);
 await screenshot('auth-expired-reader-light');
 await notice().locator('.nc-notification-close').click();assert.equal(await notice().count(),0);assert.equal(await jump.inputValue(),'2');
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
 for(const label of ['外观与设置','我的账户','我的漫画']){await page.getByRole('button',{name:label,exact:true}).click();assert.equal(await notice().filter({hasText:'登录已过期'}).count(),0);}
 checks.push('真实 App 撤权后显示可关闭共享提示，不挤压阅读布局；关闭后跨页面不重复出现');
 await page.getByRole('button',{name:'打开漫画 会话过期时继续阅读',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='2');
 await page.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
 checks.push('会话失效与关闭提示后，原图仍解码显示并恢复第 2 页');
 await page.getByRole('button',{name:'登录账户 B',exact:true}).click();await page.getByRole('button',{name:'模拟授权撤销',exact:true}).click();
 await notice().filter({hasText:'登录已过期'}).waitFor();
 await notice().getByRole('button',{name:'重新登录',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await notice().filter({hasText:'登录已过期'}).count(),0);
 await page.getByRole('textbox',{name:'测试用户名'}).fill('fixture-notification-reader');
 await page.getByRole('button',{name:'连接测试账户',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nc-auth')??'{}').session?.user.name==='fixture-notification-reader');
 assert.equal(await jump.inputValue(),'2');assert.equal(await notice().filter({hasText:'登录已过期'}).count(),0);
 if(await notice().count())await notice().locator('.nc-notification-close').click();
 await page.getByRole('button',{name:'模拟授权撤销',exact:true}).click();await notice().filter({hasText:'登录已过期'}).waitFor();
 await page.evaluate(()=>{const value=JSON.parse(localStorage.getItem('nc-settings'));localStorage.setItem('nc-settings',JSON.stringify({...value,appearance:'dark'}));window.dispatchEvent(new StorageEvent('storage',{key:'nc-settings'}));});
 await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');await page.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);await screenshot('auth-expired-reader-dark');
 await page.mouse.move(1,1);await page.getByRole('button',{name:'读取账户',exact:true}).focus();await page.clock.install();await advance(12100);assert.equal(await notice().filter({hasText:'登录已过期'}).count(),0);
 checks.push('重新登录入口可用且登录成功清理过期提醒；新会话再次失效会重新提示，并在 12 秒后收起');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const results={checks,browser:browser.version(),viewport:{width:1440,height:1000},pageErrors:errors,externalRequests:external,liveServices:false,realTranslation:false,artifacts:run};
 await writeFile(path.join(run,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await screenshot('failure').catch(()=>{});await writeFile(path.join(run,'failure.json'),JSON.stringify({phase,message:error.message,stack:error.stack,pageErrors:errors,externalRequests:external},null,2));console.error({phase,message:error.message,artifacts:run});process.exitCode=1;}
finally{await context.close();await browser.close();}
