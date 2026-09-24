// Build the extension first. Real Chromium HTTP cache and reader, isolated profile and local images.
// Do not add Playwright routes: request interception disables the browser HTTP cache.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/source-image-cache');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {registerManifest} from '${source}/sources/runtime/manifests.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error',
  build: {outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-cache.js'}}});

let online = false, png;
const requests = [], checks = [], errors = [];
const server = createServer((request, response) => {
  requests.push({url: request.url, status: online ? 200 : 503});
  response.writeHead(online ? 200 : 503, {'Content-Type': online ? 'image/png' : 'text/plain',
    'Cache-Control': 'public, max-age=3600'});
  response.end(online ? png : 'Synthetic source offline');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const imageUrl = `http://127.0.0.1:${server.address().port}/page.png`;
let context, reader;
try {
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    headless: true, executablePath: process.env.TEST_CHROMIUM, locale: 'zh-CN', viewport: {width: 1440, height: 1000},
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  reader = await context.newPage();
  const readerUrl = new URL('reader.html', worker.url()).href;
  await reader.goto(readerUrl);
  await reader.evaluate(async () => {
    await chrome.storage.local.set({'nc-reader-settings': {uiLanguage: 'zh-CN'}});
    localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN', layout: 'single'}));
  });
  png = Buffer.from(await reader.evaluate(async () => {
    const canvas = new OffscreenCanvas(800, 1200), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#eef2ff';ctx.fillRect(0, 0, 800, 1200);
    ctx.fillStyle = '#385b97';ctx.font = '40px sans-serif';ctx.fillText('Recovered from cached 503', 80, 220);
    return Array.from(new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer()));
  }));

  const cdp = await context.newCDPSession(reader), responses = [];
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', event => {
    if (event.response.url === imageUrl) responses.push({status: event.response.status, disk: !!event.response.fromDiskCache});
  });
  const defaultRead = () => reader.evaluate(async url => {
    const response = await fetch(url, {credentials: 'include'});await response.text();return response.status;
  }, imageUrl);
  assert.equal(await defaultRead(), 503);
  assert.equal(await defaultRead(), 503);
  assert.equal(requests.length, 1, 'Default fetch must actually reuse the cached 503');
  assert.deepEqual(responses.at(-1), {status: 503, disk: true});
  checks.push('默认 fetch 复用带 max-age 的 503，第二次不访问服务器');

  const id = await reader.evaluate(async url => {
    const {registerManifest} = await import(chrome.runtime.getURL('verify-cache.js'));
    const result = await registerManifest({title: '图片缓存重试验收', adapter: 'mangacopy',
      url: 'https://www.mangacopy.com/comic/cache-fixture/chapter/724f819b-5306-11ea-b7ea-024352452ce0',
      direction: 'ltr', discoveryComplete: true, knownTotal: 1, note: '',
      items: [{id: 'page-1', url, width: 800, height: 1200, order: 0}]});
    return result.id;
  }, imageUrl);
  await reader.goto(readerUrl + '?manifest=' + encodeURIComponent(id));
  const failure = reader.locator('.nc-image-failure');
  await failure.getByText('图片暂不可用', {exact: true}).waitFor();
  await reader.getByText('正在打开漫画', {exact: true}).waitFor({state: 'hidden'});
  assert((await failure.innerText()).includes('503'));
  assert(requests.length > 1, 'The reader must bypass the pre-existing cached 503');
  await reader.screenshot({path: path.join(out, 'unavailable.png')});
  checks.push('阅读器跳过已有 HTTP 失败缓存；源站仍失败时显示可操作的 503 原因');

  const geometry = () => reader.locator('.nc-page-picture').first().evaluate(element => ({
    width: element.clientWidth, height: element.clientHeight,
    scroll: document.querySelector('.nc-reading-viewport').scrollTop,
  }));
  const before = await geometry(), count = requests.length;
  online = true;
  await failure.getByRole('button', {name: '重试', exact: true}).click();
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth === 800);
  assert.equal(requests.length, count + 1, 'Retry must reach the server exactly once');
  assert.equal(await failure.count(), 0);
  assert.deepEqual(await geometry(), before);
  assert.deepEqual(responses.at(-1), {status: 200, disk: false});
  await reader.screenshot({path: path.join(out, 'recovered.png')});
  checks.push('点击重试只访问一次源站，显示可解码图片并保持阅读位置和尺寸');

  const successfulReads = requests.length;
  online = false;
  await reader.reload();
  await reader.locator('article.nc-book').filter({has: reader.getByRole('button', {name: '打开漫画 图片缓存重试验收', exact: true})})
    .getByRole('button', {name: /^(开始阅读|继续阅读)$/}).click();
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth === 800);
  assert.equal(requests.length, successfulReads, 'Validated application cache should avoid another source request');
  checks.push('重开阅读器复用已校验的应用图片缓存，源站不可用也无需再下载');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, errors, requests, responses,
    browser: context.browser()?.version(), liveSites: false}, null, 2));
  console.log(JSON.stringify({out, checks, errors, responses}, null, 2));
} catch (error) {
  if (reader && !reader.isClosed()) {
    await reader.screenshot({path: path.join(out, 'failure.png')});
    await writeFile(path.join(out, 'failure.txt'), await reader.locator('body').innerText());
  }
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
