// Isolated Chromium; real user-origin CSS, synthetic source page and extension messages.
// Run from the repository root with PLAYWRIGHT_MODULE and CHROMIUM_PATH configured.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const {build} = createRequire(path.join(extensionRoot, 'package.json'))('vite');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const filter = '[style*="width: 100% !important;"], [style*="z-index:"] {display:none!important}';
let browser, worker, page, server, origin, out, script, errors;

before(async () => {
  const base = path.resolve(extensionRoot, '../../artifacts/source-import-button');
  await mkdir(base, {recursive: true}); out = await mkdtemp(path.join(base, 'run-'));
  const result = await build({configFile: false, root: extensionRoot, logLevel: 'error', build: {
    write: false, lib: {entry: path.join(extensionRoot, 'src/sources/runtime/import-button.ts'), formats: ['iife'], name: 'SourceImportButton'},
  }});
  script = (Array.isArray(result) ? result[0] : result).output.find(output => output.type === 'chunk').code;
  const fixtureExtension = path.join(out, 'extension'); await mkdir(fixtureExtension);
  await writeFile(path.join(fixtureExtension, 'manifest.json'), JSON.stringify({manifest_version: 3, name: 'Import button CSS fixture', version: '1.0',
    permissions: ['scripting', 'tabs'], host_permissions: ['http://127.0.0.1/*'], background: {service_worker: 'background.js'}}));
  await writeFile(path.join(fixtureExtension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  server = createServer((_req, res) => {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(`<!doctype html>
    <style>body{margin:24px;background:#eaf0f8}#mount{width:310px}#mount>span{position:absolute!important;margin:99px!important;font-size:40px!important}</style>
    <h1>Source import button</h1><div id="mount"></div><div id="filter-control" style="z-index:1">Filter control</div>`);});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.CHROMIUM_PATH,
    viewport: {width: 390, height: 600}, args: ['--disable-extensions-except=' + fixtureExtension, '--load-extension=' + fixtureExtension]});
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
});
after(async () => {await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); console.log('Artifacts:', out);});
beforeEach(async () => {
  page = await browser.newPage(); page.setDefaultTimeout(5000); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await worker.evaluate(async ({url, css}) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url + '/');
    await chrome.scripting.insertCSS({target: {tabId: tab.id}, origin: 'USER', css});
  }, {url: origin, css: filter});
  assert.equal(await page.locator('#filter-control').isVisible(), false);
  await page.evaluate(() => {
    window.fixture = {messages: [], listeners: new Set()};
    window.chrome = {runtime: {id: 'fixture', onMessage: {
      addListener: fn => fixture.listeners.add(fn), removeListener: fn => fixture.listeners.delete(fn),
    }, sendMessage(message) {
      if (message.type === 'NC_INLINE_THEME') return Promise.resolve({appearance: 'dark', accentTheme: 'iris', textScale: 1.25});
      fixture.messages.push(message.type); return Promise.resolve({ok: true});
    }}};
  });
  await page.addScriptTag({content: script});
});
afterEach(async () => {await page.close(); assert.deepEqual(errors, []);});

for (const floating of [false, true]) test(`${floating ? 'floating' : 'embedded'} button survives cosmetic filtering, remains operable and cleans up`, async () => {
  await page.evaluate(floating => {fixture.cleanup = SourceImportButton.mountSourceImportButton(document.querySelector('#mount'), {floating, findAlternatives: !floating});}, floating);
  const button = page.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await button.waitFor();
  const metrics = await page.locator('#mount > span').evaluate(host => {
    const style = getComputedStyle(host), box = host.getBoundingClientRect();
    return {display: style.display, position: style.position, marginTop: style.marginTop, left: box.left, right: box.right,
      bottom: box.bottom, width: box.width, height: box.height, inline: host.getAttribute('style'), listeners: fixture.listeners.size};
  });
  assert.equal(metrics.inline, null); assert.equal(metrics.display, floating ? 'block' : 'inline-block');
  assert.equal(metrics.position, floating ? 'fixed' : 'static'); assert.equal(metrics.marginTop, floating ? '0px' : '12px');
  assert(metrics.width > 0 && metrics.height > 0 && metrics.right <= 390); assert.equal(metrics.listeners, 1);
  if (floating) {assert.equal(metrics.left, 16); assert.equal(metrics.bottom, 580);}
  await button.click(); await page.waitForFunction(() => fixture.messages.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.messages), ['NC_IMPORT_CURRENT']);
  if (!floating) {
    await page.getByRole('button', {name: '寻找其他语言', exact: true}).click();
    await page.waitForFunction(() => fixture.messages.length === 2);
    assert.deepEqual(await page.evaluate(() => fixture.messages), ['NC_IMPORT_CURRENT', 'NC_SEARCH_CURRENT']);
  } else assert.equal(await page.getByRole('button').count(), 1);
  await page.screenshot({path: path.join(out, floating ? 'floating.png' : 'embedded.png')});
  await page.evaluate(() => fixture.cleanup());
  assert.equal(await page.locator('#mount > span').count(), 0);
  assert.equal(await page.evaluate(() => fixture.listeners.size), 0);
});
