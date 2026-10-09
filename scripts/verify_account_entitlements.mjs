/** Read-only account UI acceptance. Vite 5186, synthetic data, no external requests. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5186';
const output=path.resolve('artifacts/account-entitlements');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(10000);
const requests=()=>page.evaluate(()=>window.accountFixture.requests);
const purchases=()=>page.locator('.nc-purchase-card');
async function visit(query='scenario=member'){
  await page.goto(`${origin}/tests/account-fixture.html?${query}#account`);
  await page.getByRole('button',{name:'刷新权益',exact:true}).waitFor();
  await page.getByText('免费额度',{exact:true}).waitFor();
  const release=page.getByRole('button',{name:'关闭版本更新',exact:true});
  if(await release.isVisible())await release.click();
}
async function open(){
  await page.getByRole('button',{name:'查看额度包',exact:true}).click();
  await purchases().first().waitFor();
  await page.waitForFunction(()=>document.querySelector('.nc-purchases')?.getAttribute('aria-busy')==='false');
}
async function shot(name){await page.screenshot({path:path.join(output,`${name}.png`)});}
async function checkStyle(){
  assert(await page.evaluate(()=>{
    const card=getComputedStyle(document.querySelector('.nc-purchase-card'));
    const balance=getComputedStyle(document.querySelector('.nc-rights-card'));
    return ['borderTopWidth','borderTopColor','borderRadius','boxShadow','backgroundColor'].every(key=>card[key]===balance[key])
      &&getComputedStyle(document.querySelector('.nc-purchase-card dl')).borderTopStyle==='dashed';
  }),'Pack cards must use the same surface tokens as balance cards.');
  assert(await page.locator('.nc-account-toolbar button svg').evaluate(icon=>getComputedStyle(icon).stroke===getComputedStyle(icon.closest('button')).color),'Refresh outline must follow the readable control color.');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}
async function checkRelease(){
  const checkArtwork=async()=>assert(await page.locator('.nc-release-featured').evaluateAll(cards=>cards.every(card=>{
    const text=card.querySelector('.nc-release-feature-text').getBoundingClientRect();
    const art=card.querySelector('.nc-release-feature-art').getBoundingClientRect();
    return text.right+8<=art.left;
  })),'Release text and artwork must not overlap.');
  await page.goto(`${origin}/tests/account-fixture.html?scenario=member#account`);
  await page.evaluate(()=>localStorage.setItem('nc-release-notes-version','0.10.3'));
  await page.reload();
  const dialog=page.getByRole('dialog'),trigger=page.getByRole('button',{name:'版本更新 · v0.11.0',exact:true});
  await dialog.waitFor();
  assert((await dialog.innerText()).includes('v0.11.0'));
  assert.equal(await dialog.locator('.nc-release-highlights>li').count(),5);
  for(const text of ['多模型翻译','资费大幅降低','新增额度包','ComicK (comickz)','ComicWalker',"HERO'S Web"])
    assert((await dialog.innerText()).includes(text));
  assert(!(await dialog.innerText()).includes('OPDS'));
  await checkArtwork();
  await shot('release-0.11.0');
  const position=await page.evaluate(()=>scrollY);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert(await trigger.evaluate(element=>element===document.activeElement));
  assert.equal(await page.evaluate(()=>scrollY),position);
  await page.reload();
  await trigger.waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);
  for(const theme of ['light','dark']){
    await page.setViewportSize({width:390,height:844});
    await visit(`scenario=member&theme=${theme}&largeText=1`);
    const more=page.getByRole('button',{name:'更多操作 · 主导航',exact:true});
    if(await more.isVisible())await more.click();
    await trigger.click();
    await dialog.waitFor();
    assert(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth));
    await checkArtwork();
    await shot(`release-0.11.0-mobile-${theme}`);
    await page.getByRole('button',{name:'知道了',exact:true}).click();
    await dialog.waitFor({state:'detached'});
  }
  for(const locale of ['zh-CN','zh-TW','en','ja','ko','fr','de','es','pt-BR','it','ru','uk','pl','tr','vi','id']){
    const dictionary=JSON.parse(await readFile(`apps/extension/src/i18n/dictionaries/${locale}.json`,'utf8'));
    await page.goto(`${origin}/tests/account-fixture.html?scenario=member&locale=${locale}&largeText=1#account`);
    await page.locator('.nc-account-heading').waitFor();
    await page.locator('.nc-header-utilities-trigger').click();
    await page.locator('.nc-release-trigger').click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(),dictionary['releaseNotes.title']);
    assert.equal(await dialog.locator('.nc-release-highlights>li').count(),5);
    assert(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth));
    assert(await dialog.locator('.nc-release-content').evaluate(element=>element.scrollWidth<=element.clientWidth));
    await checkArtwork();
    if(locale==='en')await shot('release-0.11.0-mobile-en');
    await page.locator('.nc-release-close').click();
  }
  await page.setViewportSize({width:1440,height:1100});
  checks.push('0.11.0 replaces old highlights, reopens after upgrade once, restores focus/scroll, and fits mobile light/dark large text in 16 locales.');
}
try{
  await checkRelease();
  await visit();
  assert.equal(await page.getByRole('tab').count(),0);
  assert.equal(await page.locator('.nc-rights-card').count(),3);
  assert((await page.locator('.nc-account-meta').innerText()).includes('示例会员'));
  assert((await page.locator('.nc-account-meta').innerText()).includes('2027/1/1'));
  assert(!(await requests()).some(value=>/quota-purchases|usage\/summary|\/feedback|\/billing\//.test(value)));
  const pricing=page.getByRole('link',{name:'前往定价页面',exact:true});
  assert.equal(await pricing.getAttribute('href'),'https://comics.nodelane.net/pricing/');
  assert.equal(await pricing.getAttribute('target'),'_blank');
  assert.equal(await page.locator('.nc-account-heading').getByRole('link',{name:'前往定价页面',exact:true}).count(),1);
  assert.equal(await pricing.innerText(),'');
  assert((await pricing.locator('use').getAttribute('href')).endsWith('#pricing'));
  assert.equal(await page.locator('.nc-account-actions').count(),0);
  for(const control of [pricing,page.getByRole('button',{name:'刷新权益',exact:true})]){
    const box=await control.boundingBox();
    assert(box.width>=44&&box.height>=44);
  }
  await pricing.focus();
  assert(await pricing.evaluate(element=>element.matches(':focus-visible')&&getComputedStyle(element).outlineStyle==='solid'));
  await page.keyboard.press('Tab');
  await shot('account-overview');
  checks.push('Three server balances, server plan name and expiry; history, usage and feedback are lazy.');

  await open();assert.equal(await purchases().count(),20);
  assert((await purchases().nth(0).innerText()).includes('不过期'));
  assert((await purchases().nth(1).innerText()).includes('2026/10/31'));
  assert((await purchases().nth(2).innerText()).includes('无可用额度'));
  assert((await purchases().nth(3).innerText()).includes('已到期'));
  assert((await purchases().nth(4).innerText()).includes('已撤销'));
  await checkStyle();
  await shot('account-packs');
  const first=await purchases().first().innerText();
  await page.evaluate(()=>window.accountFixture.setPurchaseError(true));
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'暂时无法读取额度包'}).waitFor();
  assert.equal(await purchases().first().innerText(),first);
  await page.evaluate(()=>window.accountFixture.setPurchaseError(false));
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nc-purchase-card').length===1);
  assert((await purchases().first().innerText()).includes('历史额度包 16'));
  assert(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled());
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nc-purchase-card').length===20);
  assert.equal(await purchases().first().innerText(),first);
  checks.push('20-row cursor paging, permanent/limited/exhausted/expired/revoked states, retry keeps prior rows and cursor.');

  await page.getByRole('button',{name:'收起额度包',exact:true}).click();
  assert.equal(await purchases().count(),0);
  const initial=(await requests()).filter(value=>value==='/v1/me/entitlements').length;
  await pricing.evaluate(link=>link.addEventListener('click',event=>event.preventDefault()));
  await pricing.click();
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(expected=>window.accountFixture.requests.filter(value=>value==='/v1/me/entitlements').length===expected,initial+1);
  assert(!(await requests()).some(value=>value.startsWith('/v1/billing/')));
  await page.evaluate(()=>window.accountFixture.setEntitlementError(true));
  await page.getByRole('button',{name:'刷新权益',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'暂时无法读取权益'}).waitFor();
  assert.equal(await page.locator('.nc-rights-card').count(),3);
  await page.evaluate(()=>window.accountFixture.setEntitlementError(false));
  await page.getByRole('button',{name:'刷新权益',exact:true}).click();
  await page.getByRole('alert').waitFor({state:'detached'});
  checks.push('Pricing handoff returns to one read-only refresh; errors retain balances; no payment API calls.');

  await page.locator('.nc-account-activity>summary').click();
  await page.getByText('暂无反馈',{exact:true}).waitFor();
  assert((await requests()).some(value=>value.includes('usage/summary')));
  checks.push('Usage and feedback mount only after opening.');

  await visit('scenario=packs');
  assert((await page.locator('.nc-account-meta').innerText()).includes('普通用户'));
  assert(!(await page.locator('.nc-account-meta').innerText()).includes('有效至'));
  await visit('scenario=empty');
  await page.getByRole('button',{name:'查看额度包',exact:true}).click();
  await page.getByText('暂无已购额度包',{exact:true}).waitFor();
  assert.equal(await purchases().count(),0);
  await visit('scenario=packs&purchaseError=1');
  await page.getByRole('button',{name:'查看额度包',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.evaluate(()=>window.accountFixture.setPurchaseError(false));
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await purchases().first().waitFor();
  checks.push('Pack-only account stays free, empty history and first-load failure are recoverable.');

  await visit('scenario=member&slowPurchases=1');
  await page.getByRole('button',{name:'查看额度包',exact:true}).click();
  await page.getByText('正在读取额度包…',{exact:true}).waitFor();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await page.getByRole('button',{name:'登录账户',exact:true}).waitFor();
  await page.waitForTimeout(1600);
  assert.equal(await purchases().count(),0);
  assert.equal(await page.getByRole('alert').count(),0);
  checks.push('Logout cancels pending private history without stale rows or errors.');

  for(const theme of ['light','dark']){
    for(const accent of ['sky','rose','mint','iris','amber','slate']){
      await page.setViewportSize({width:1440,height:1100});
      await visit(`scenario=member&theme=${theme}&accent=${accent}`);
      await open();await checkStyle();
      if(accent==='sky')await shot(`account-packs-${theme}`);
    }
    await page.setViewportSize({width:390,height:844});
    await visit(`scenario=packs&theme=${theme}`);
    await shot(`account-header-mobile-${theme}`);
    await open();await checkStyle();
    await page.locator('.nc-purchases').scrollIntoViewIfNeeded();
    await shot(`account-packs-mobile-${theme}`);
    await page.setViewportSize({width:320,height:844});
    await visit(`scenario=member&theme=${theme}&largeText=1`);
    await open();await checkStyle();
  }
  checks.push('Header SVG actions have names, keyboard focus and 44px targets. Pack cards share balance-card tokens across six accents, light/dark, and 320px large text.');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,screenshots:output},null,2));
}finally{await browser.close();}
