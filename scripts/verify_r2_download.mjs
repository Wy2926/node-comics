// Chrome reader check with simulated R2 responses. No Cloudflare or paid models.
// Start tests/manual_ui_server.py and Vite :5174; set UI_FIXTURE_DIRECTORY.
import assert from 'node:assert/strict';
import {completeLocalImport} from './local_import_helpers.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const api = 'http://127.0.0.1:18089', web = process.env.TEST_READER_URL || 'http://127.0.0.1:5174';
const output = path.resolve('artifacts/r2-validation');
assert(process.env.UI_FIXTURE_DIRECTORY, 'UI_FIXTURE_DIRECTORY is required');
await mkdir(output, {recursive: true});
const auth = await fetch(api + '/v1/auth/dev', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'r2-' + randomUUID().slice(0,8)})}).then(r => r.json());
const browser = await chromium.launch({headless:true, ...(process.env.TEST_CHROMIUM ? {executablePath:process.env.TEST_CHROMIUM} : {channel:'chrome'})});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const objects = new Map(), remoteRequests = [], checks = [];
let rejectOnce = true, accessCount = 0;
const check = name => {checks.push(name); console.log('PASS ' + name);};
try {
  // The isolated API stores fixture bytes locally. Copy them into this test's
  // simulated object service; the browser receives only a remote signed URL.
  await page.route(api + '/v1/images/*/access', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({response});
    const access = await response.json(), id = new URL(route.request().url()).pathname.split('/')[3];
    const content = await fetch(api + access.url, {headers:{Authorization:`Bearer ${auth.access_token}`}});
    objects.set(id, Buffer.from(await content.arrayBuffer()));
    accessCount++;
    await route.fulfill({response, json:{url:`https://r2-fixture.example/${id}?signature=fixture-${accessCount}`, authorization_required:false, expires_at:new Date(Date.now()+300000).toISOString()}});
  });
  await page.route('https://r2-fixture.example/**', async route => {
    const headers = await route.request().allHeaders();
    assert(!headers.authorization && !headers.cookie && !headers.referer, 'private headers leaked to storage');
    remoteRequests.push(new URL(route.request().url()).pathname);
    if (rejectOnce) {rejectOnce = false; return route.fulfill({status:403, headers:{'Access-Control-Allow-Origin':web}});}
    const body = objects.get(new URL(route.request().url()).pathname.slice(1));
    await route.fulfill({status:body ? 200 : 404, headers:{'Access-Control-Allow-Origin':web, 'Content-Type':'image/png'}, body});
  });
  await page.goto(web);
  await page.evaluate(({api,auth}) => {
    localStorage.setItem('nc-settings', JSON.stringify({apiBase:api,translationMode:'redraw',layout:'single',autoAhead:0}));
    localStorage.setItem('nc-session', JSON.stringify({token:auth.access_token,user:auth.user,apiOrigin:api}));
  }, {api,auth});
  await page.reload();
  await page.locator('input[type=file]').setInputFiles([1,2,3].map(i => path.join(process.env.UI_FIXTURE_DIRECTORY,'pages',`page-0${i}.png`)));
  await page.getByLabel('内容归属',{exact:true}).selectOption('publication');
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-shelf-detail').first().click();
  await page.getByRole('tab',{name:'卷册',exact:true}).click();
  await page.getByRole('button',{name:'阅读',exact:true}).first().click();
  await page.getByLabel('跳转页码').waitFor();
  await page.getByRole('button',{name:'AI 重绘本页',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:/确认/,exact:false}).last().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.nc-page-image')].some(img => img.complete && img.naturalWidth > 0));
  const until = Date.now() + 40000;
  while (remoteRequests.length < 2) {assert(Date.now() < until, 'reader did not download from simulated R2'); await new Promise(r => setTimeout(r,250));}
  await page.waitForTimeout(1000);
  assert(accessCount >= 2);
  check('reader renews the first rejected signature and downloads directly without account headers');
  assert.equal(await page.getByLabel('跳转页码').inputValue(), '1');
  check('translation completion retains the selected page');
  await page.screenshot({path:path.join(output,'reader-translated.png')});
  const jump = page.getByLabel('跳转页码');
  await jump.fill('2'); await jump.press('Enter'); await jump.blur();
  await page.getByRole('button',{name:'AI 重绘本页',exact:true}).waitFor();
  assert.equal(await jump.inputValue(), '2');
  await page.screenshot({path:path.join(output,'reader-next-page.png')});
  check('next original page remains readable after translated-page loading');
  await writeFile(path.join(output,'results.json'), JSON.stringify({checks, remoteDownloads:remoteRequests.length, liveR2:false},null,2));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png')});
  throw error;
} finally {await browser.close();}
