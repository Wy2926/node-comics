// Production MV3 extension, isolated Chromium and a synthetic MTU HTTP server.
// Deliberately silent for >30 s; no real MTU engine, account, image or external endpoint.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const out = path.resolve('artifacts/translation-channel-host', randomUUID()), extension = path.join(out, 'extension');
await mkdir(out, {recursive: true});
await cp('apps/extension/.output/chrome-mv3', extension, {recursive: true});
const manifestPath = path.join(extension, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(manifestPath, JSON.stringify(manifest));
await writeFile(path.join(extension, 'host-probe.html'), '<!doctype html><meta charset="utf-8"><title>Isolated channel host verification</title><pre id="report"></pre>');
const probeEntry = path.join(out, 'result-probe.ts'), sourceRoot = path.resolve('apps/extension/src').replaceAll('\\', '/');
await writeFile(probeEntry, `export {loadResultBlob,saveResultBlob,resultBlobKey} from '${sourceRoot}/storage/translations/results';export {translationCache} from '${sourceRoot}/storage/translations';`);
const {build} = createRequire(path.resolve('apps/extension/package.json'))('vite');
await build({configFile: false, root: path.resolve('apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probeEntry, formats: ['es'], fileName: () => 'result-probe.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const checks = [], failures = [], requests = [];
let context, page, probe, source, output, releaseResponse, translationStartedAt, silentMs;
let translations = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    requests.push({method: req.method, path: url.pathname});
    if (url.pathname === '/original.png') {res.writeHead(200, {'Content-Type': 'image/png'}); res.end(source); return;}
    if (url.pathname === '/page') {
      res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'});
      res.end('<!doctype html><title>Local GPU fixture comic</title><style>body{margin:0;background:#edf2f8}h1{font:20px system-ui;text-align:center}img{display:block;width:640px;margin:20px auto}</style><h1>本地算力 · 原位翻译验收</h1><img id="comic" src="/original.png">'); return;
    }
    if (url.pathname === '/translate/with-form/image') {
      translations++; translationStartedAt ??= Date.now();
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), text = bytes.toString('latin1');
      assert.equal(req.headers['x-session-token'], 'isolated-mtu-token');
      assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
      assert(req.headers['content-type'].startsWith('multipart/form-data; boundary='));
      assert(text.includes('name="image"')); assert(text.includes('name="config"'));
      assert(text.includes('"target_lang":"CHS"'));
      await new Promise(resolve => {releaseResponse = resolve;});
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'}); res.end(output); return;
    }
    res.writeHead(404); res.end();
  } catch (error) {failures.push(error.message); res.writeHead(500); res.end('fixture failure');}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const check = label => {checks.push(label); console.log('PASS ' + label);};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {assert(Date.now() < deadline, 'Condition timed out'); await pause(100);}
}
try {
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    headless: true, executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH,
    viewport: {width: 1280, height: 1000}, locale: 'zh-CN',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/host-probe.html`);
  const panels = await probe.evaluate(async () => {
    async function image(color, text) {
      const canvas = new OffscreenCanvas(800, 1100), ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 800, 1100); ctx.strokeStyle = '#223451'; ctx.lineWidth = 6; ctx.strokeRect(30, 30, 740, 1040);
      ctx.font = '42px sans-serif'; ctx.fillStyle = '#223451'; ctx.fillText(text, 70, 150);
      return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];
    }
    return {source: await image('#fff3df', 'HELLO LOCAL GPU'), output: await image('#e2f4ff', '你好，本地算力')};
  });
  source = Buffer.from(panels.source); output = Buffer.from(panels.output);
  await probe.evaluate(async base => {
    await chrome.storage.local.remove('nc-auth');
    await chrome.storage.local.set({
      'nc-reader-settings': {autoTranslateTabs: false, language: 'zh-Hans', translationMode: 'classic', uiLanguage: 'zh-CN', cacheLimitMb: 0},
      'nc-translation-channels': {activeId: 'isolated-mtu', profiles: [{id: 'isolated-mtu', name: 'Fixture GPU', adapterId: 'manga-translator-ui', revision: 1, settings: {baseUrl: base + '/', username: 'fixture'}}]},
    });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('node-comics-reading-v2-translation-channel-credentials', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('credentials', {keyPath: 'id'});
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('credentials', 'readwrite'); tx.objectStore('credentials').put({id: 'isolated-mtu', values: {token: 'isolated-mtu-token'}});
      tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
    }); db.close();
  }, base);
  page = await context.newPage(); page.on('pageerror', error => failures.push(error.message));
  await page.goto(base + '/page'); await page.locator('#comic').evaluate(image => image.decode());
  const activation = await probe.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.runtime.sendMessage({type: 'NC_TRANSLATE_TAB', tabId: tab.id, url});
  }, page.url());
  assert.equal(activation.ok, true);
  await until(() => translations === 1);
  const host = await context.waitForEvent('page', {predicate: p => p.url().includes('/translation-host.html'), timeout: 2000}).catch(() => context.pages().find(p => p.url().includes('/translation-host.html')));
  assert(host, 'The worker must create the extension execution page'); await host.waitForLoadState();
  const hostTab = await host.evaluate(() => chrome.tabs.getCurrent());
  assert.equal(hostTab.active, false);
  await host.screenshot({path: path.join(out, 'host-running.png')});
  check('No NodeLane account: the actual inline flow sends one MTU form request from an inactive extension host');
  const cdp = await context.newCDPSession(probe), versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({versions: incoming}) => {for (const version of incoming) versions.set(version.versionId, version);});
  await cdp.send('ServiceWorker.enable');
  await until(() => [...versions.values()].some(version => version.scriptURL.includes(extensionId) && version.runningStatus === 'running'));
  const version = [...versions.values()].find(value => value.scriptURL.includes(extensionId) && value.runningStatus === 'running');
  const oldWorker = worker;
  const marker = await oldWorker.evaluate(() => {globalThis.fixtureRestartMarker = crypto.randomUUID(); return globalThis.fixtureRestartMarker;});
  await cdp.send('ServiceWorker.stopWorker', {versionId: version.versionId});
  // New Chrome versions reuse a DevTools target/Playwright Worker while replacing its JS context.
  // A vanished in-memory marker proves the actual execution context restarted.
  await until(async () => {
    worker = context.serviceWorkers().find(value => value.url().includes(extensionId)) ?? oldWorker;
    return await worker.evaluate(() => globalThis.fixtureRestartMarker).catch(() => marker) === undefined;
  }, 10000);
  check('The background service worker was explicitly stopped while the server had sent no response headers');
  await until(() => Date.now() - translationStartedAt > 35_000, 40_000);
  assert.equal(translations, 1); assert(!host.isClosed());
  const receipt = await probe.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {const req = indexedDB.open('node-comics-reading-v2-channel-transfers', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);});
    const receipts = await new Promise((resolve, reject) => {const tx = database.transaction('receipts'), req = tx.objectStore('receipts').getAll(); tx.oncomplete = () => resolve(req.result); tx.onabort = tx.onerror = () => reject(tx.error);});
    database.close(); return receipts.map(({id, state, input, output, ...rest}) => ({id, state, inputBytes: input?.size ?? 0, outputBytes: output?.size ?? 0, ...rest}));
  });
  assert.equal(receipt.length, 1); assert.equal(receipt[0].state, 'running');
  assert(!JSON.stringify(receipt).includes('isolated-mtu-token'));
  check('A request silent for over 35 seconds remains running with a durable receipt and no duplicate submission');
  silentMs = Date.now() - translationStartedAt; releaseResponse();
  await page.waitForFunction(() => document.querySelector('#comic').style.content.includes('blob:'), undefined, {timeout: 20000});
  assert.equal(translations, 1);
  worker = context.serviceWorkers().find(value => value.url().includes(extensionId)) ?? await context.waitForEvent('serviceworker');
  assert.equal(await worker.evaluate(() => globalThis.fixtureRestartMarker), undefined);
  const jobs = await probe.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {const req = indexedDB.open('node-comics-reading-v2-channel-operations', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);});
    const jobs = await new Promise((resolve, reject) => {const tx = database.transaction('operations'), req = tx.objectStore('operations').getAll(); tx.oncomplete = () => resolve(req.result.map(record => record.job)); tx.onabort = tx.onerror = () => reject(tx.error);});
    database.close(); return jobs;
  });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'succeeded'); assert.equal(jobs[0].output_asset_id, null); assert.equal(jobs[0].result.recoverable, false);
  await page.screenshot({path: path.join(out, 'inline-result-after-worker-restart.png')});
  check('The restarted worker consumes the persisted host result and displays the decoded local translation in the original page');
  await page.reload(); await page.locator('#comic').evaluate(image => image.decode());
  await probe.evaluate(async url => {const tab = (await chrome.tabs.query({})).find(tab => tab.url === url); return chrome.runtime.sendMessage({type: 'NC_TRANSLATE_TAB', tabId: tab.id, url});}, page.url());
  await page.waitForFunction(() => document.querySelector('#comic').style.content.includes('blob:'), undefined, {timeout: 20000});
  assert.equal(translations, 1);
  check('Reloading the source page reuses the completed translation without a second MTU call');
  await until(() => host.isClosed(), 15_000);
  check('The idle execution host closes itself after delivery');
  const secondProbe = await context.newPage(); await secondProbe.goto(`chrome-extension://${extensionId}/host-probe.html`);
  const localScope = {key: JSON.stringify(['isolated-mtu', 1])}, delivered = jobs[0];
  for (const consumer of [probe, secondProbe]) {
    const bytes = await consumer.evaluate(async ({scope, job}) => {
      const {loadResultBlob, translationCache} = await import(chrome.runtime.getURL('result-probe.js'));
      const blob = await loadResultBlob({scope, job, isCurrent: () => true});
      return {size: blob.size, usage: await translationCache.usage()};
    }, {scope: localScope, job: delivered});
    assert.equal(bytes.size, output.length); assert.equal(bytes.usage.bytes, 0); assert.equal(bytes.usage.budgetBytes, 0);
  }
  check('With cacheLimitMb=0 from production storage settings, two extension contexts read the worker result while disk usage stays zero');
  await probe.evaluate(async () => {const {translationCache} = await import(chrome.runtime.getURL('result-probe.js')); await translationCache.clear();});
  for (const consumer of [probe, secondProbe]) {
    const code = await consumer.evaluate(async ({scope, job}) => {
      const {loadResultBlob} = await import(chrome.runtime.getURL('result-probe.js'));
      try {await loadResultBlob({scope, job, isCurrent: () => true}); return 'unexpected-success';}
      catch (error) {return error.code;}
    }, {scope: localScope, job: delivered});
    assert.equal(code, 'RESULT_NOT_CACHED');
  }
  assert.equal(translations, 1); await secondProbe.close();
  check('Clearing the shared cache epoch prevents either context from reviving bytes through memory messaging and does not resubmit translation');
  assert.deepEqual(failures, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, failures, requests, translations, silentMs,
    browser: context.browser()?.version(), syntheticMtu: true, realMtuEngine: false}, null, 2));
  console.log('Artifacts: ' + out);
} catch (error) {
  await page?.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({checks, failures, requests, translations, error: error.stack}, null, 2)); throw error;
} finally {
  releaseResponse?.(); await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
