// Opt-in live MTU verification. No mocked MTU responses or seeded channel credentials.
// Credentials come only from process environment; a fresh extension profile is removed on exit.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const base = new URL(process.env.MTU_BASE_URL || 'http://127.0.0.1:8000/');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'This check is restricted to a loopback service');
assert(!base.username && !base.password && !base.search && !base.hash);
base.pathname = base.pathname.replace(/\/+$/, '') + '/';
const username = process.env.MTU_USERNAME, password = process.env.MTU_PASSWORD;
assert(username && password, 'Set MTU_USERNAME and MTU_PASSWORD for this process');
const out = path.resolve('artifacts/translation-channel-live', randomUUID());
const extension = path.join(out, 'extension'), profile = path.join(out, 'profile');
await mkdir(out, {recursive: true});
await cp('apps/extension/.output/chrome-mv3', extension, {recursive: true});
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
// Pregrant only loopback in this isolated build copy; native permission dialog is not tested.
manifest.host_permissions.push(base.origin + '/*', 'http://127.0.0.1/*');
await writeFile(manifestPath, JSON.stringify(manifest));
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const checks = [], report = {service: base.href, checks, requests: [], syntheticSource: true, permissionPregranted: true};
let context, token, source, completed, translationResponse, settings, page;
const check = text => {checks.push(text); console.log('PASS ' + text);};
async function readDiagnostics() {
  if (!settings || settings.isClosed()) return {};
  return settings.evaluate(async () => {
    const databases = await indexedDB.databases(), summary = {};
    for (const [suffix, store] of [['channel-transfers', 'receipts'], ['channel-operations', 'operations']]) {
      const name = 'node-comics-reading-v2-' + suffix;
      if (!databases.some(value => value.name === name)) continue;
      const db = await new Promise((resolve, reject) => {const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
      const records = await new Promise((resolve, reject) => {const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
      summary[suffix] = records.map(value => ({state: value.state ?? value.job?.status, errorCode: value.errorCode ?? value.job?.error_code}));
      db.close();
    }
    summary.locks = await navigator.locks.query();
    return summary;
  }).catch(() => ({}));
}
const server = createServer((req, res) => {
  if (req.url === '/source.png') {res.writeHead(200, {'Content-Type': 'image/png'}); res.end(source); return;}
  if (req.url === '/page') {
    res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'});
    res.end('<!doctype html><title>Live MTU verification</title><style>body{background:#edf2f8;margin:0;font:20px system-ui;text-align:center}img{display:block;width:640px;margin:20px auto}</style><h1>真实本机服务 · 合成测试图</h1><img id="comic" src="/source.png">'); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sourceUrl = `http://127.0.0.1:${server.address().port}/page`;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH,
    viewport: {width: 1360, height: 1000}, locale: 'zh-CN',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => chrome.storage.local.set({'nc-reader-settings': {
    uiLanguage: 'zh-CN', appearance: 'light', language: 'zh-Hans', translationMode: 'classic', autoTranslateTabs: false,
  }}));
  settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.getByRole('button', {name: '添加翻译渠道', exact: true}).click();
  await settings.getByLabel('名称', {exact: true}).fill('本机真实 MTU 验收');
  await settings.getByLabel('服务地址', {exact: true}).fill(base.href);
  await settings.getByLabel('用户名', {exact: true}).fill(username);
  await settings.getByLabel('密码', {exact: true}).fill(password);
  const loginResponse = settings.waitForResponse(response => response.url() === base.href + 'auth/login');
  await settings.getByRole('button', {name: '连接并使用', exact: true}).click();
  const response = await loginResponse, result = await response.json(), sent = response.request().postDataJSON();
  report.login = {status: response.status(), success: result.success, tokenPresent: !!result.token,
    tokenLength: typeof result.token === 'string' ? result.token.length : null,
    mustChangePassword: result.must_change_password, fields: Object.keys(result),
    usernameMatched: sent.username === username, passwordMatched: sent.password === password};
  assert.equal(response.status(), 200); assert.equal(result.success, true); assert(result.token);
  assert(report.login.usernameMatched && report.login.passwordMatched);
  token = result.token;
  await settings.getByRole('dialog').waitFor({state: 'hidden'});
  const saved = await settings.evaluate(async () => {
    const value = await chrome.storage.local.get(['nc-translation-channels', 'nc-auth']);
    return {channels: value['nc-translation-channels'], hasOfficialSession: !!value['nc-auth']?.session};
  });
  assert.equal(saved.hasOfficialSession, false); assert.equal(saved.channels.profiles.length, 1);
  assert(!JSON.stringify(saved).includes(password)); assert(!JSON.stringify(saved).includes(token));
  await settings.screenshot({path: path.join(out, 'connected.png'), fullPage: true});
  check('Real extension settings logged into live MTU and selected the channel without a NodeLane account');
  await settings.getByRole('button', {name: '重新连接', exact: true}).click();
  assert.equal(await settings.getByLabel('密码', {exact: true}).inputValue(), '');
  await settings.keyboard.press('Escape');
  check('Channel metadata excludes credentials and the reconnect form does not retain the password');

  source = Buffer.from(await settings.evaluate(async () => {
    const canvas = new OffscreenCanvas(800, 1100), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#cfe3ef'; ctx.fillRect(0, 0, 800, 1100);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#182f49'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.roundRect(45, 50, 710, 370, 85); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.font = 'bold 42px Arial'; ctx.textAlign = 'center';
    ctx.fillText('HELLO, MY FRIEND!', 400, 155); ctx.fillText('LET US READ', 400, 235); ctx.fillText('A COMIC TOGETHER!', 400, 315);
    ctx.fillStyle = '#405b75'; ctx.beginPath(); ctx.arc(400, 650, 110, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(265, 780, 270, 270);
    return [...new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer())];
  }));
  await writeFile(path.join(out, 'source.png'), source);
  let translationCount = 0;
  context.on('request', request => {
    if (request.url() === base.href + 'translate/with-form/image') {
      translationCount++;
      report.requests.push({method: request.method(), path: '/translate/with-form/image',
        hasSessionToken: !!request.headers()['x-session-token'], contentType: request.headers()['content-type']});
      console.log('LIVE translation submitted (no automatic retry)');
    }
  });
  context.on('response', response => {
    if (response.url() === base.href + 'translate/with-form/image') translationResponse = response;
  });
  page = await context.newPage(); await page.goto(sourceUrl); await page.locator('#comic').evaluate(image => image.decode());
  const started = Date.now();
  const activation = await settings.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.runtime.sendMessage({type: 'NC_TRANSLATE_TAB', tabId: tab.id, url});
  }, sourceUrl);
  assert.equal(activation.ok, true);
  console.log('LIVE inline activation acknowledged');
  const timeout = Number(process.env.MTU_TIMEOUT_MS || 300000);
  let lastDiagnostic = started;
  while (!translationResponse && Date.now() - started < timeout) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (Date.now() - lastDiagnostic > 20000) {
      lastDiagnostic = Date.now(); report.diagnostics = await readDiagnostics();
      await page.screenshot({path: path.join(out, 'waiting.png'), fullPage: true});
      await writeFile(path.join(out, 'progress.json'), JSON.stringify(report, null, 2));
      console.log('LIVE waiting: requests=' + translationCount + ', states=' + JSON.stringify(report.diagnostics));
      assert(!report.diagnostics['channel-transfers']?.some(record => record.state === 'failed'), 'Image transfer failed before delivery; see safe diagnostics');
    }
  }
  assert(translationResponse, 'Live MTU did not respond within the verification deadline; request is not retried');
  report.translation = {status: translationResponse.status(), contentType: translationResponse.headers()['content-type'],
    elapsedMs: Date.now() - started, requestCount: translationCount};
  assert.equal(translationCount, 1); assert.equal(translationResponse.status(), 200, 'Live translation HTTP status');
  const bytes = await translationResponse.body();
  report.translation.bytes = bytes.length;
  await writeFile(path.join(out, 'result.png'), bytes);
  await page.waitForFunction(() => document.querySelector('#comic').style.content.includes('blob:'), undefined, {timeout: 30000});
  report.translation.decoded = await page.locator('#comic').evaluate(async image => {
    const url = image.style.content.match(/url\(["']?([^"')]+)/)[1];
    const blob = await (await fetch(url)).blob(), decoded = await createImageBitmap(blob);
    const result = {width: decoded.width, height: decoded.height}; decoded.close(); return result;
  });
  await page.screenshot({path: path.join(out, 'translated.png'), fullPage: true});
  check('One real form request returned a decodable image and the production inline flow displayed it');
  // DevTools may omit binary multipart postData; assert observable headers and actual delivery.
  // Exact form field/config construction is covered by mtu-protocol and channel-transfer tests.
  assert(report.requests.every(item => item.hasSessionToken && item.contentType.startsWith('multipart/form-data; boundary=')));
  await page.reload(); await page.locator('#comic').evaluate(image => image.decode());
  await settings.evaluate(async url => {const tab = (await chrome.tabs.query({})).find(tab => tab.url === url); return chrome.runtime.sendMessage({type: 'NC_TRANSLATE_TAB', tabId: tab.id, url});}, sourceUrl);
  await page.waitForFunction(() => document.querySelector('#comic').style.content.includes('blob:'), undefined, {timeout: 15000});
  assert.equal(translationCount, 1);
  check('Reloading the source reuses the real result without another MTU translation');
  report.diagnostics = await readDiagnostics();
  completed = true;
} catch (error) {
  // Do not persist fetch/request errors containing credentials, bodies, or service tokens.
  report.failure = {name: error.name, code: error.code, message: String(error.message).replaceAll(password, '[redacted]').replaceAll(token || '__no_token__', '[redacted]').slice(0, 1000)};
  if (page && !page.isClosed()) await page.screenshot({path: path.join(out, 'failure.png'), fullPage: true}).catch(() => {});
  report.diagnostics = await readDiagnostics();
  process.exitCode = 1;
} finally {
  if (token) {
    const logout = await fetch(base.href + 'auth/logout', {method: 'POST', headers: {'X-Session-Token': token}}).catch(() => null);
    report.testSessionLogoutStatus = logout?.status ?? null;
    const loggedOut = await logout?.json().catch(() => null);
    report.testSessionLogoutSucceeded = logout?.ok === true && loggedOut?.success === true;
  }
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(profile), out); await rm(profile, {recursive: true, force: true});
  report.passed = !!completed;
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); console.log('REPORT ' + path.join(out, 'results.json'));
}
