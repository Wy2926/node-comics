// Built MV3 + isolated profile. Synthetic fixtures by default; --live also reads two public pages.
// All translation requests stay on the loopback MTU fixture. No account/provider credentials are used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';

const flags = new Set(process.argv.slice(2));
const usage = `node scripts/verify_immersive_reading.mjs [--headed] [--live] [--live-only] [--no-translation] [--http-only] [--styles-only]
Build first. PLAYWRIGHT_MODULE, TEST_CHROMIUM (or CHROMIUM_PATH), TEST_EXTENSION_DIR are supported.
--headed opens an isolated Chromium window. The full fixture suite attempts native tab visibility; unsupported browser visibility remains unverified (headless cannot certify it).
--styles-only verifies shared reader theme/range/translation-notice styles with local fixtures only; no public pages or provider calls.
IMMERSIVE_OUTPUT chooses the artifact parent; each run gets a new directory and profile.
IMMERSIVE_LIVE_ADAPTED_URL and IMMERSIVE_LIVE_GENERIC_URL override the two public read-only pages.
IMMERSIVE_LIVE_IMAGE_ORIGINS is an optional comma-separated exact HTTPS image-CDN origin allowlist.
The default run is wholly synthetic. --live never mocks public source HTML or image responses.`;
if (flags.has('--help')) {console.log(usage); process.exit(0);}
assert([...flags].every(flag => ['--headed', '--live', '--live-only', '--no-translation', '--http-only', '--styles-only'].includes(flag)), usage);
assert(!flags.has('--http-only') || !flags.has('--live') && !flags.has('--live-only'), '--http-only is a synthetic diagnostic, not a public-source run');
assert(!flags.has('--styles-only') || !['--live', '--live-only', '--http-only', '--no-translation'].some(flag => flags.has(flag)), '--styles-only is a local fixture run including synthetic translation notices');
const live = flags.has('--live') || flags.has('--live-only'), fixtures = !flags.has('--live-only');
const headed = flags.has('--headed'), stylesOnly = flags.has('--styles-only');
const root = process.cwd(), base = path.resolve(process.env.IMMERSIVE_OUTPUT || 'artifacts/immersive-validation');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
const built = path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3');
const manifestBytes = await readFile(path.join(built, 'manifest.json')), manifest = JSON.parse(manifestBytes);
assert.equal(manifest.manifest_version, 3, 'Build the MV3 extension first');
assert(manifest.host_permissions?.includes('http://*/*') && manifest.host_permissions?.includes('https://*/*'), 'Keep the production host permissions');
await cp(built, extension, {recursive: true});
await writeFile(path.join(extension, 'immersive-inspect.html'), '<!doctype html><meta charset="utf-8"><title>Isolated immersive verification</title>');

const checks = [], measurements = [], unverifiedChecks = [], errors = [], publicFailures = [], liveChecks = [], pendingSizes = new Set();
const network = {requests: 0, imageRequests: 0, imageResponses: 0, completedBodyBytes: 0, blockedServiceRequests: 0, blockedThirdPartyRequests: 0, modelRequests: 0};
const blockedOrigins = {}, liveOrigins = new Set();
const liveImageOrigins = (process.env.IMMERSIVE_LIVE_IMAGE_ORIGINS || 'https://cdn.readdetectiveconan.com,https://imgs.xkcd.com').split(',').map(value => {
  const url = new URL(value.trim()); assert(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Image CDN allowlist entries must be exact public HTTPS origins'); return url.origin;
});
const fixtureRequests = [], mtuInputs = [], failedFixtureImages = new Set(), mtuWaiters = new Set();
const limits = {fixturePages: 500, publicRequests: 180, publicImages: 32, publicBytes: 64 * 1024 * 1024, timeoutMs: 300000};
let context, probe, page, cdp, worker, watchdog, fatal, stage = 'prepare', scope = 'fixture', translated, originals = [], fixtureRoutes = false;
let publicRequests = 0, publicImages = 0, publicBytes = 0, currentRequests = 0, currentImages = 0;
let mtuMode = 'success';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceUrl = value => {try {const url = new URL(value); return url.origin + url.pathname;} catch {return '(unavailable)';}};
const redact = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, sourceUrl).slice(0, 1500);
const fail = message => {fatal ??= Error(message); void context?.close().catch(() => {});};
const check = message => {checks.push(message); console.log('PASS ' + message);};
async function until(condition, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!await condition()) {if (fatal) throw fatal; assert(Date.now() < end, message); await pause(80);}
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/translate/with-form/image') {
      assert.equal(scope, 'fixture', 'Public-source runs must never submit translation');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert(body.length <= 8 * 1024 * 1024, 'Synthetic upload unexpectedly exceeded its budget');
      assert.equal(req.headers['x-session-token'], 'isolated-immersive-token');
      assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
      const form = await new Response(body, {headers: {'Content-Type': req.headers['content-type']}}).formData();
      const image = form.get('image'); assert(image instanceof Blob && image.size > 0);
      mtuInputs.push({bytes: image.size, sha256: createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex'), stageAtReceive: stage});
      if (mtuMode === 'pending') await new Promise(resolve => mtuWaiters.add(resolve));
      if (mtuMode === 'error') {res.writeHead(503, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end('{"error":"Synthetic translation temporarily unavailable"}'); return;}
      await pause(120);
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'}); res.end(translated); return;
    }
    if (url.pathname.startsWith('/images/')) {
      fixtureRequests.push(url.pathname);
      const number = Number(/\/(\d+)\.png$/.exec(url.pathname)?.[1] || 1);
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=600'}); res.end(originals[(number - 1) % originals.length]); return;
    }
    if (url.pathname === '/generic' || url.pathname === '/region') {
      res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); res.end(genericHtml(url.pathname === '/region')); return;
    }
    if (url.pathname === '/delayed') {
      res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); res.end(delayedHtml()); return;
    }
    if (url.pathname.startsWith('/v1/')) {
      network.blockedServiceRequests++;
      if (/^\/v1\/(translations|comic-titles\/translate)/.test(url.pathname)) {network.modelRequests++; errors.push('Unexpected official translation request was blocked');}
      res.writeHead(503, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}); res.end('{"error":{"code":"ISOLATED_FIXTURE","message":"External services disabled"}}'); return;
    }
    res.writeHead(404); res.end();
  } catch (error) {errors.push(redact(error.message)); if (!res.headersSent) res.writeHead(500); res.end('fixture failure');}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;
// Like the existing inline fixture, only this isolated copy redirects its build-time service.
// This also blocks service-worker fetches which browser routing alone cannot reliably intercept.
const buildApi = process.env.IMMERSIVE_BUILD_API || 'https://comics.nodelane.net';
const buildJavaScriptDigest = createHash('sha256');
for (const file of (await readdir(extension, {recursive: true})).sort()) if (file.endsWith('.js')) {
  const target = path.join(extension, file), contents = await readFile(target, 'utf8');
  buildJavaScriptDigest.update(file.replaceAll('\\', '/')).update('\0').update(contents).update('\0');
  if (contents.includes(buildApi)) await writeFile(target, contents.replaceAll(buildApi, local));
}
const buildJavaScriptSha256 = buildJavaScriptDigest.digest('hex');

function genericHtml(alternate = false) {
  return `<!doctype html><meta charset="utf-8"><title>Original comic fixture</title>
  <style>body{margin:0;background:#f1f4f8;font:16px system-ui}header{height:220px;padding:20px;box-sizing:border-box}main{width:680px;margin:auto}#comic-scroll{height:680px;overflow:auto;background:white}article{padding:16px 20px}.comic{display:block;width:600px;height:825px;margin:0 auto 24px}aside img{width:70px;height:90px}footer{height:900px}button{padding:8px}</style>
  <header><button id="site-action">Original site control</button><aside><img src="/images/8.png" alt="Small recommendation"></aside></header>
  <main><section id="comic-scroll"><article id="comic-body" aria-label="Comic chapter">
  ${Array.from({length: 12}, (_, index) => `<img class="comic" id="source-${index + 1}" src="/images/${index === 3 ? 3 : index + 1}.png" width="800" height="1100" alt="Original synthetic page ${index + 1}">`).join('')}
  <img class="comic" id="lazy" data-src="/images/13.png" width="800" height="1100" alt="Lazy synthetic page">
  </article></section></main>${alternate ? '<aside id="alternate-body" aria-label="Alternate comic body"><img class="comic" id="alternate-1" src="/images/101.png" width="800" height="1100"><img class="comic" id="alternate-2" src="/images/102.png" width="800" height="1100"></aside>' : ''}<footer>Original site footer</footer>
  <script>document.querySelector('#site-action').onclick=()=>document.body.dataset.siteClicks=String(Number(document.body.dataset.siteClicks||0)+1);
  const lazy=document.querySelector('#lazy'), observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){lazy.src=lazy.dataset.src;observer.disconnect();}},{root:document.querySelector('#comic-scroll')});observer.observe(lazy);
  window.fixtureAppend=()=>{const image=new Image();image.className='comic';image.id='appended';image.width=800;image.height=1100;image.src='/images/14.png';document.querySelector('#comic-body').append(image);return image.decode();};</script>`;
}
function delayedHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Late first comic fixture</title>
  <style>body{margin:0;background:#f1f4f8;font:16px system-ui}header{height:260px}header img{display:block;width:400px;height:100px}main{width:600px;margin:auto}main img{display:block;width:600px;height:825px}footer{height:600px}</style>
  <header><button id="site-action">Original site control</button><img src="/images/1.png" alt="Non-comic banner"></header>
  <main><img id="late-first" width="800" height="1100" alt="Late first synthetic comic"></main><footer>Original site footer</footer>
  <script>window.fixtureLoadFirst=()=>{const image=document.querySelector('#late-first');image.src='/images/2.png';return image.decode();};</script>`;
}
const adaptedFixtureUrl = 'https://mangapill.com/chapters/42-10001000/fixture-work-chapter-1';
const adaptedImage = number => `https://cdn.readdetectiveconan.com/file/mangap/42/10001000/${number}.png`;
function adaptedHtml() {
  const title = 'Fixture Work Chapter 1', count = stylesOnly ? 12 : limits.fixturePages;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#f1f4f8}h1{text-align:center}chapter-page{display:block;width:600px;min-height:825px;margin:24px auto}chapter-page img{display:block;width:600px;height:825px}#js-chapter-selector-modal{display:none}</style><h1 id="top">${title}</h1>
  <main>${Array.from({length: count}, (_, index) => {const number = index + 1, image = adaptedImage(number === 4 ? 3 : number); return `<chapter-page><div class="primary"><div data-summary><div>page ${number}/${count}</div></div><div><picture><img class="js-page" data-src="${image}" ${number <= 2 ? `src="${image}"` : ''} alt="${title} Page ${number}" width="800" height="1100"></picture></div></div></chapter-page>`;}).join('')}</main>
  <div id="js-chapter-selector-modal"><div><div id="chapter-selector-modal-title">Fixture Work Chapters</div><a href="/manga/42" data-hotkey="m">Go To Manga</a><include-fragment id="js-chapter-selector-fragment" src="/manga/42/chapters?current=10001000"></include-fragment></div></div>`;
}
const adaptedRoute = async route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'cdn.readdetectiveconan.com') {
    fixtureRequests.push(url.pathname);
    const number = Number(/\/(\d+)\.png$/.exec(url.pathname)?.[1] || 1);
    if (failedFixtureImages.has(number)) {await route.fulfill({status: 503, contentType: 'text/plain', body: 'Synthetic unavailable page'}); return;}
    await route.fulfill({status: 200, contentType: 'image/png', body: originals[(number - 1) % originals.length], headers: {'Cache-Control': 'public,max-age=600'}}); return;
  }
  if (url.pathname.startsWith('/chapters/')) {await route.fulfill({status: 200, contentType: 'text/html', body: adaptedHtml()}); return;}
  if (url.pathname === '/quick-search') {await route.fulfill({status: 200, contentType: 'text/html', body: '<a href="/manga/42/fixture-work"><img src="https://cdn.readdetectiveconan.com/file/mangapill/i/42.png"><div class="font-black">Fixture Work</div></a>'}); return;}
  await route.fulfill({status: 200, contentType: 'text/html', body: '<h1>Fixture Work</h1><img data-src="https://cdn.readdetectiveconan.com/file/mangapill/i/42.png" alt="Fixture Work"><div id="chapters"><div data-filter-list><a href="/chapters/42-10001000/fixture-work-chapter-1" title="Chapter 1">Chapter 1</a></div></div>'});
};

async function surfaceCall(fn, args, returnByValue = true) {
  // Resolve the one host instead of serializing 500 source-page DOM trees on each poll.
  const {root: documentRoot} = await cdp.send('DOM.getDocument', {depth: 0});
  const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: documentRoot.nodeId, selector: '[data-nc-immersive]'});
  assert(nodeId, 'The immersive host must exist');
  const {node: host} = await cdp.send('DOM.describeNode', {nodeId, depth: 1, pierce: true});
  assert(host?.shadowRoots?.length, 'The immersive closed Shadow DOM must exist');
  const {object} = await cdp.send('DOM.resolveNode', {backendNodeId: host.shadowRoots[0].backendNodeId});
  try {
    const result = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: fn.toString(), arguments: [{value: args}], returnByValue, awaitPromise: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return returnByValue ? result.result.value : result.result;
  } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId}).catch(() => {});}
}
async function surfaceState() {
  return surfaceCall(function () {
    const host = this.host, viewport = this.querySelector('[data-reader-viewport]'), images = [...this.querySelectorAll('img')];
    const visible = image => {const r = image.getBoundingClientRect(), v = viewport?.getBoundingClientRect(); return !!v && r.width > 0 && r.height > 0 && r.top < v.bottom && r.bottom > v.top && r.left < v.right && r.right > v.left;};
    return {count: Number(host.dataset.pageCount), complete: host.dataset.complete, current: Number(host.dataset.currentPage), view: host.dataset.view, loading: host.dataset.loading, error: host.dataset.error,
      viewport: viewport ? {top: viewport.scrollTop, left: viewport.scrollLeft, width: viewport.clientWidth, height: viewport.clientHeight} : null,
      imageElements: images.length, decodedImageElements: images.filter(image => image.complete && image.naturalWidth > 0).length,
      visibleDecodedImages: images.filter(image => visible(image) && image.complete && image.naturalWidth > 0).length,
      pageIds: [...this.querySelectorAll('[data-page-id]')].map(cell => cell.dataset.pageId),
      buttons: [...this.querySelectorAll('button')].map(button => button.getAttribute('aria-label') || button.textContent?.trim()).filter(Boolean)};
  });
}
async function assertIcons(label) {
  await until(async () => surfaceCall(function () {
    const icons = [...this.querySelectorAll('svg use')];
    return icons.length > 0 && icons.every(icon => {try {const box = icon.getBBox(); return box.width > 0 && box.height > 0;} catch {return false;}});
  }), 'Reader icon sprite references must resolve to non-empty SVG geometry');
  const icons = await surfaceCall(function () {return [...this.querySelectorAll('svg use')].map(icon => {const box = icon.getBBox(); return {reference: icon.getAttribute('href'), width: box.width, height: box.height};});});
  measurements.push({label: label + '-icons', icons});
}
async function button(names, selector = '') {
  // Reveal the normal reader rails, then use actual pointer input across the closed shadow boundary.
  await page.mouse.move(2, 450); await pause(100);
  const point = await surfaceCall(function ({labels, selector}) {
    const area = selector ? this.querySelector(selector) : this;
    if (!area) throw Error('Missing immersive control scope: ' + selector);
    const candidates = [...area.querySelectorAll('button')].filter(element => labels.includes(element.getAttribute('aria-label')) || labels.includes(element.getAttribute('title')) || labels.includes(element.textContent?.trim()));
    const button = candidates.find(element => {const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;}) || candidates[0];
    if (!button) throw Error('Missing immersive button: ' + labels.join(', '));
    button.scrollIntoView({block: 'nearest'});
    const rect = button.getBoundingClientRect(); if (!rect.width || !rect.height) throw Error('Immersive control is not visible');
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  }, {labels: names, selector});
  await page.mouse.click(point.x, point.y);
}
async function activate() {
  const result = await probe.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url); if (!tab?.id) throw Error('Fixture tab is missing');
    return chrome.runtime.sendMessage({type: 'NC_IMMERSIVE_START', tabId: tab.id, url});
  }, page.url());
  assert.equal(result?.ok, true, redact(result?.error || 'Immersive activation failed'));
  await page.locator('[data-nc-immersive]').waitFor();
}
async function start() {
  const began = performance.now();
  await activate();
  await until(async () => {const state = await surfaceState(); if (state.error) throw Error(state.error); return state.visibleDecodedImages > 0;}, 'Immersive first visible image did not decode', 45000);
  return {firstImageAfterActivationMs: Math.round(performance.now() - began), state: await surfaceState()};
}
async function closeSurface() {
  await button(['返回网页', '返回来源网页', '退出沉浸阅读', '退出沉浸式阅读', '退出', '关闭', 'Exit immersive reading', 'Close']);
  await page.locator('[data-nc-immersive]').waitFor({state: 'detached'});
  await until(async () => (await resources()).active === 0, 'Exiting leaked extension-owned display object URLs');
}
async function jump(number, expectImage = true) {
  await surfaceCall(function () {
    const input = this.querySelector('input[aria-label="跳转页码"]') || this.querySelector('input[type="number"]');
    if (!input) throw Error('The immersive page number input is missing'); input.focus(); input.select();
  });
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(String(number)); await page.keyboard.press('Enter');
  await until(async () => {const state = await surfaceState(); return state.current === number && (!expectImage || state.visibleDecodedImages > 0);}, `Page ${number} did not become visible`, 30000);
}
async function metrics(label) {
  const [heap, dom, performanceMetrics, documentImages] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters'), cdp.send('Performance.getMetrics'),
    page.evaluate(live => ({imageElements: document.images.length, decodedImageElements: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length,
      ...(live ? {geometry: [...document.images].slice(0, 32).map(image => {const rect = image.getBoundingClientRect(); let source = ''; try {const url = new URL(image.currentSrc || image.src); source = url.origin + url.pathname;} catch {} return {source, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: rect.width, height: rect.height, complete: image.complete, visible: image.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}), parentTag: image.parentElement?.tagName, parentId: image.parentElement?.id};}), contentRegions: [...document.querySelectorAll('main,article,[role="main"]')].map(element => ({tag: element.tagName, id: element.id}))} : {})}), scope === 'live'),
  ]);
  const hasSurface = await page.locator('[data-nc-immersive]').count();
  const result = {label, jsHeapUsedBytes: heap.usedSize, jsHeapTotalBytes: heap.totalSize, ...(heap.backingStorageSize == null ? {} : {jsBackingStorageBytes: heap.backingStorageSize}), dom,
    performance: Object.fromEntries(performanceMetrics.metrics.filter(metric => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize', 'JSHeapTotalSize'].includes(metric.name)).map(metric => [metric.name, metric.value])),
    documentImages, surface: hasSurface ? await surfaceState() : null, displayResources: await resources(), requests: currentRequests, imageRequests: currentImages};
  measurements.push(result); return result;
}
async function open(url) {
  if (page && !page.isClosed()) await page.close();
  page = await context.newPage(); page.on('pageerror', error => {if (scope === 'fixture') errors.push(redact(error.message));});
  cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  // Playwright enables permanent focus/visibility per target by default. Restore native tab semantics,
  // rather than overriding document.hidden or dispatching a synthetic visibility event.
  if (headed) await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false});
  currentRequests = 0; currentImages = 0;
  const began = performance.now(); await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45000});
  await page.waitForFunction(() => [...document.images].some(image => image.complete && image.naturalWidth >= 80 && image.getBoundingClientRect().width >= 240), undefined, {timeout: 45000});
  const firstImageMs = Math.round(performance.now() - began);
  await resources(true); return firstImageMs;
}
async function resources(install = false) {
  // Test-runtime instrumentation only, in this extension's isolated world. No production hooks/files.
  return probe.evaluate(async ({url, install}) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url); if (!tab?.id) throw Error('Fixture tab is missing');
    const values = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', args: [install], func: install => {
      if (install && !globalThis.__ncImmersiveFixtureResources) {
        const state = globalThis.__ncImmersiveFixtureResources = {urls: new Map(), created: 0, revoked: 0};
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = value => {const url = create(value); state.urls.set(url, value?.size ?? 0); state.created++; return url;};
        URL.revokeObjectURL = url => {if (state.urls.delete(url)) state.revoked++; revoke(url);};
      }
      const state = globalThis.__ncImmersiveFixtureResources;
      return state ? {active: state.urls.size, retainedBlobBytes: [...state.urls.values()].reduce((sum, bytes) => sum + bytes, 0), created: state.created, revoked: state.revoked} : {active: 0, retainedBlobBytes: 0, created: 0, revoked: 0};
    }});
    return values[0].result;
  }, {url: page.url(), install});
}
async function originalPosition() {
  return page.evaluate(() => ({x: scrollX, y: scrollY, inner: document.querySelector('#comic-scroll')?.scrollTop ?? null,
    bodyStyle: document.body.getAttribute('style'), rootStyle: document.documentElement.getAttribute('style'), focus: document.activeElement?.id || ''}));
}
async function visibilityEvidence() {
  const [source, inspector, tabs] = await Promise.all([
    page.evaluate(() => ({hidden: document.hidden, state: document.visibilityState, focus: document.hasFocus()})),
    probe.evaluate(() => ({hidden: document.hidden, state: document.visibilityState, focus: document.hasFocus()})),
    probe.evaluate(async url => {
      const inspector = await chrome.tabs.getCurrent(), source = (await chrome.tabs.query({})).find(tab => tab.url === url);
      const select = tab => tab ? {id: tab.id, windowId: tab.windowId, active: tab.active, status: tab.status} : null;
      return {source: select(source), inspector: select(inspector)};
    }, page.url()),
  ]);
  return {source, inspector, tabs};
}
async function activateRealTab(inspector) {
  return probe.evaluate(async ({url, inspector}) => {
    const tab = inspector ? await chrome.tabs.getCurrent() : (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (!tab?.id) throw Error('The isolated verification tab is missing');
    await chrome.tabs.update(tab.id, {active: true});
  }, {url: page.url(), inspector});
}
async function runHttpDiagnostic() {
  stage = 'ordinary insecure HTTP synthetic origin';
  const route = async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/images/')) {
      const number = Number(/\/(\d+)\.png$/.exec(url.pathname)?.[1] || 1);
      await route.fulfill({status: 200, contentType: 'image/png', body: originals[(number - 1) % originals.length]});
    } else await route.fulfill({status: 200, contentType: 'text/html', body: genericHtml()});
  };
  await context.route('http://immersive-fixture.test/**', route);
  try {
    await open('http://immersive-fixture.test/generic');
    await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    const contextState = await probe.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', func: () => ({secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues})});
      return results[0].result;
    }, page.url());
    measurements.push({label: 'insecure-http-isolated-context', ...contextState});
    console.log('HTTP_CONTEXT ' + JSON.stringify(contextState));
    assert.equal(contextState.secure, false, 'This fixture must be an ordinary insecure HTTP origin, not trusted loopback');
    await start(); assert.equal((await surfaceState()).count, 12); await closeSurface();
    check('Ordinary insecure HTTP supports source/discovery IDs and immersive original images without secure-context-only UUID assumptions');
  } finally {await context.unroute('http://immersive-fixture.test/**', route);}
}
async function runGeneric() {
  stage = 'generic synthetic HTML';
  const firstImageMs = await open(local + '/generic');
  await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => {scrollTo(0, 180); document.querySelector('#comic-scroll').scrollTop = 457; document.querySelector('#site-action').focus({preventScroll: true});});
  const source = await originalPosition(), baseline = await metrics('generic-original');
  const opened = await start();
  assert.equal(opened.state.complete, 'false', 'Unknown HTML must never advertise a complete chapter');
  assert.equal(opened.state.count, 12, 'Keep two distinct slots with the same image URL; exclude the thumbnail and unloaded lazy image');
  assert(opened.state.pageIds.length <= 11, 'Generic immersive page mounting must stay bounded');
  await assertIcons('generic');
  await page.screenshot({path: path.join(out, 'generic-original-view.png')});
  const immersive = await metrics('generic-immersive');
  measurements.push({label: 'generic-first-image', originalAfterNavigationMs: firstImageMs, ...opened, baselineRequests: baseline.requests, immersiveRequests: immersive.requests,
    comparison: 'Original is navigation-to-first-loaded image; immersive is warm-source activation-to-first-visible image. Not an equivalent cold-start benchmark.'});
  if (headed) {
    const beforeHidden = await readingOffset();
    await probe.bringToFront();
    await pause(120);
    const firstEvidence = await visibilityEvidence();
    let switchedByTabsApi = false;
    if (!firstEvidence.source.hidden && !firstEvidence.tabs.inspector?.active && firstEvidence.tabs.source?.windowId === firstEvidence.tabs.inspector?.windowId) {
      await activateRealTab(true); switchedByTabsApi = true; await pause(200);
    }
    const afterSwitch = await visibilityEvidence();
    measurements.push({label: 'generic-tab-visibility', afterBringToFront: firstEvidence, switchedByTabsApi, afterSwitch});
    if (!afterSwitch.source.hidden) {
      const reason = 'The isolated headed browser did not report a hidden source document after real tab activation; visibility was not mocked.';
      unverifiedChecks.push({check: 'background-tab display release', reason});
      console.log('UNVERIFIED ' + reason);
    } else {
      await until(async () => (await resources()).active === 0, 'A background tab must release extension-owned display object URLs');
      assert.equal((await surfaceState()).imageElements, 0, 'Hidden presentation must not retain decoded img elements');
      await metrics('generic-hidden');
    }
    await activateRealTab(false); await page.bringToFront();
    await until(async () => !await page.evaluate(() => document.hidden) && (await surfaceState()).visibleDecodedImages > 0, 'Foregrounding did not restore its bounded display window');
    const afterHidden = await readingOffset();
    assert.equal(afterHidden.page, beforeHidden.page); assert(Math.abs(afterHidden.relativeOffset - beforeHidden.relativeOffset) < 0.02);
    if (afterSwitch.source.hidden) check('Hiding the real tab releases displayed images/object URLs; foregrounding restores the same reading anchor');
  } else {
    const reason = 'Headless Chromium does not produce real background-tab visibility; rerun with --headed. No visibility properties are mocked.';
    unverifiedChecks.push({check: 'background-tab display release', reason});
  }
  await closeSurface();
  assert.deepEqual(await originalPosition(), source, 'Exiting without reading movement must exactly restore outer/nested scroll, focus, and extension-owned styles');
  await start(); await jump(10); assert((await surfaceState()).pageIds.length <= 11);
  await page.evaluate(() => window.fixtureAppend());
  await until(async () => (await surfaceState()).count === 13, 'A source-owned appended loaded image was not discovered');
  await closeSurface();
  const moved = await originalPosition();
  assert.equal(moved.y, source.y, 'Mapping a page in a nested scroller must not move the outer document');
  assert.equal(moved.focus, source.focus); assert.equal(moved.bodyStyle, source.bodyStyle); assert.equal(moved.rootStyle, source.rootStyle);
  const alignment = await page.evaluate(() => document.querySelector('#source-10').getBoundingClientRect().top - document.querySelector('#comic-scroll').getBoundingClientRect().top);
  assert(Math.abs(alignment) <= 2, `The current immersive page must map back to its original nested viewport, got ${alignment}px`);
  await page.locator('#site-action').click(); assert.equal(await page.locator('body').getAttribute('data-site-clicks'), '1');
  check('Generic candidates retain duplicate URLs, exclude thumbnail/unloaded lazy images and observe append; unchanged exit restores exactly, moved exit aligns the source page without moving the outer viewport');
  await page.evaluate(() => {const scroll = document.querySelector('#comic-scroll'); scroll.scrollTop = document.querySelector('#lazy').offsetTop;});
  await page.locator('#lazy').evaluate(image => image.decode());
  await start(); assert.equal((await surfaceState()).count, 14); await closeSurface();
  assert.equal(await page.locator('[data-nc-immersive]').count(), 0);
  check('Source-owned lazy loading still works after exit; explicit re-entry discovers the additional original');
  await start();
  await page.evaluate(() => history.pushState({}, '', '?chapter=2'));
  await page.locator('[data-nc-immersive]').waitFor({state: 'detached'});
  await until(async () => (await resources()).active === 0, 'SPA invalidation leaked display object URLs');
  await start(); assert.equal((await surfaceState()).count, 14); await closeSurface();
  check('SPA navigation retires the old document session and display resources; explicit activation binds a fresh navigation');
  await metrics('generic-after-close');
}
async function runRegionSelection() {
  stage = 'explicit generic body selection';
  const beforeTranslations = mtuInputs.length;
  await open(local + '/region');
  await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await start(); assert.equal((await surfaceState()).count, 12, 'Automatic discovery must exclude the alternate aside');
  await button(['阅读设置']); await button(['选择正文区域'], '.nc-stack-actions');
  await until(async () => surfaceCall(function () {return this.querySelector('.theme')?.dataset.picking === 'true' && getComputedStyle(this.querySelector('.nc-session-mount')).visibility === 'hidden';}), 'Body picker did not reveal the original source');
  await page.locator('#alternate-1').scrollIntoViewIfNeeded();
  const target = await page.locator('#alternate-1').boundingBox(); assert(target);
  await page.mouse.move(target.x + target.width / 2, Math.max(20, Math.min(880, target.y + target.height / 2)));
  await page.mouse.click(target.x + target.width / 2, Math.max(20, Math.min(880, target.y + target.height / 2)));
  await until(async () => {const state = await surfaceState(); return state.count === 2 && state.visibleDecodedImages > 0;}, 'Explicit source-region click did not bind the selected two-image body');
  assert.equal((await surfaceState()).complete, 'false'); assert((await surfaceState()).pageIds.length <= 2);
  if ((await surfaceState()).buttons.includes('关闭面板')) await button(['关闭面板']);
  await assertIcons('selected-region');
  await page.screenshot({path: path.join(out, 'generic-selected-region.png')});
  await closeSurface();
  assert.equal(mtuInputs.length, beforeTranslations, 'Body selection in original view must not invoke translation');
  check('Selecting the source body with real pointer input replaces the automatic scope, remains partial and does not invoke translation');
}
async function runLateFirstImage() {
  stage = 'late first generic source image';
  const beforeTranslations = mtuInputs.length;
  await open(local + '/delayed');
  await page.locator('#site-action').focus();
  const position = await originalPosition();
  await activate();
  await until(async () => {const state = await surfaceState(); return state.loading === 'false' && state.count === 0;}, 'The delayed fixture must resolve an initially empty comic scope');
  await page.evaluate(() => window.fixtureLoadFirst());
  await until(async () => {const state = await surfaceState(); return state.count === 1 && state.visibleDecodedImages > 0;}, 'The first late-loaded source image did not appear in the open immersive surface');
  assert.equal((await surfaceState()).complete, 'false');
  await page.screenshot({path: path.join(out, 'generic-late-first-image.png')});
  await closeSurface();
  assert.deepEqual(await originalPosition(), position, 'An initially empty scope gaining its first image must not count as user movement when exiting');
  assert.equal(mtuInputs.length, beforeTranslations);
  check('A late first source image fills an initially empty surface; unchanged exit still exactly preserves the original page position');
}
async function readingOffset() {
  return surfaceCall(function () {
    const cell = [...this.querySelectorAll('[data-page-index]')].find(cell => Number(cell.dataset.pageIndex) + 1 === Number(this.host.dataset.currentPage));
    const rect = cell?.getBoundingClientRect(), viewport = this.querySelector('[data-reader-viewport]')?.getBoundingClientRect();
    if (!rect?.height || !viewport) throw Error('Current page geometry is missing');
    return {page: Number(this.host.dataset.currentPage), relativeOffset: (viewport.top - rect.top) / rect.height};
  });
}
const borderProperties = ['border-top-width', 'border-top-style', 'border-top-color'];
const skinProperties = ['background-color', 'color', ...borderProperties, 'border-radius', 'box-shadow'];
const styleTargets = [
  {name: 'rail', selector: '.nc-reader-rail', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-card-radius);box-shadow:var(--comic-shadow-small)', properties: skinProperties},
  {name: 'active-view', selector: '.nc-page-versions button[aria-pressed="true"]', css: 'background:var(--accent-soft);color:var(--accent);border-radius:var(--comic-control-radius)', properties: ['background-color', 'color', 'border-radius']},
  {name: 'page-input', selector: 'input[aria-label="跳转页码"]', css: 'background:var(--surface);border:var(--comic-input-border);border-radius:var(--comic-control-radius)', properties: ['background-color', ...borderProperties, 'border-radius']},
  {name: 'drawer', selector: '.nc-reader-drawer', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-card-radius);box-shadow:var(--comic-shadow)', properties: skinProperties},
  {name: 'drawer-title', selector: '.nc-drawer-title', css: 'background-color:var(--accent-soft)', properties: ['background-color']},
  {name: 'segmented-selection', selector: '.segmented button.active', css: 'background:var(--accent);color:var(--accent-on);box-shadow:var(--comic-shadow-small)', properties: ['background-color', 'color', 'box-shadow']},
  {name: 'viewport-scrollbar', selector: '[data-reader-viewport]', pseudo: '::-webkit-scrollbar', css: 'width:12px;height:12px', properties: ['width', 'height']},
  {name: 'viewport-scrollbar-track', selector: '[data-reader-viewport]', pseudo: '::-webkit-scrollbar-track', css: 'background:var(--accent-soft);border:1px solid var(--line);border-radius:var(--comic-control-radius)', properties: ['background-color', ...borderProperties, 'border-radius']},
  {name: 'viewport-scrollbar-thumb', selector: '[data-reader-viewport]', pseudo: '::-webkit-scrollbar-thumb', css: 'background:var(--accent);border:1px solid var(--comic-stroke);border-radius:3px;box-shadow:var(--comic-shadow-small)', properties: ['background-color', ...borderProperties, 'border-radius', 'box-shadow']},
];
async function applyTheme(appearance, accentTheme, textScale) {
  await probe.evaluate(async preferences => {
    const saved = await chrome.storage.local.get('nc-reader-settings');
    await chrome.storage.local.set({'nc-reader-settings': {...saved['nc-reader-settings'], ...preferences}});
  }, {appearance, accentTheme, textScale});
  await until(async () => surfaceCall(function (theme) {
    const root = this.querySelector('.theme');
    return root?.dataset.appearance === theme.appearance && root?.dataset.accent === theme.accentTheme && Number(root.style.getPropertyValue('--text-scale')) === theme.textScale;
  }, {appearance, accentTheme, textScale}), 'Reader did not receive the normal shared theme broadcast');
  await page.mouse.move(2, 450);
}
async function tokenStyles(targets) {
  return surfaceCall(function (targets) {
    const root = this.querySelector('.theme'); if (!root) throw Error('Shared theme root is missing');
    const result = targets.map(target => {
      const element = target.selector ? this.querySelector(target.selector) : null;
      if (target.selector && !element) throw Error('Shared themed element is missing: ' + target.selector);
      // A short-lived reference resolves the existing shared CSS variables, not a duplicate palette.
      const reference = document.createElement('div'); reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' + target.css; root.append(reference);
      const expected = getComputedStyle(reference), actual = element && getComputedStyle(element, target.pseudo || null);
      const value = {name: target.name, expected: Object.fromEntries(target.properties.map(property => [property, expected.getPropertyValue(property)])),
        ...(actual ? {actual: Object.fromEntries(target.properties.map(property => [property, actual.getPropertyValue(property)]))} : {})};
      reference.remove(); return value;
    });
    const fonts = Object.fromEntries(['.nc-session-reader', '.nc-reader-rail button span', '.nc-reader-navigation label', 'input[aria-label="跳转页码"]', '.nc-drawer-title h2', '.field', '.nc-image-translation'].map(selector => {
      const element = this.querySelector(selector); return [selector, element ? getComputedStyle(element).fontSize : null];
    }).filter(([, value]) => value));
    return {styles: result, fonts, theme: {appearance: root.dataset.appearance, accent: root.dataset.accent, scale: root.style.getPropertyValue('--text-scale')},
      images: [...this.querySelectorAll('.nc-page-image')].map(image => ({source: image.currentSrc || image.src, filter: getComputedStyle(image).filter, opacity: getComputedStyle(image).opacity}))};
  }, targets);
}
function assertTokenStyles(snapshot, label) {
  for (const result of snapshot.styles) if (result.actual) assert.deepEqual(result.actual, result.expected, `${label}: ${result.name} must use the shared theme tokens`);
  for (const image of snapshot.images) {assert.equal(image.filter, 'none', 'Theme changes must not recolor comic artwork'); assert.equal(image.opacity, '1');}
}
async function rangeStyles() {
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const object = await surfaceCall(function () {return this.querySelector('.nc-reader-progress');}, undefined, false);
  try {
    assert(object.objectId, 'Native reader range is missing');
    const {node} = await cdp.send('DOM.describeNode', {objectId: object.objectId, depth: -1, pierce: true});
    const descendants = item => [item, ...(item.children || []).flatMap(descendants), ...(item.shadowRoots || []).flatMap(descendants)];
    const nodes = descendants(node), result = {};
    for (const part of ['track', 'thumb']) {
      const target = nodes.find(item => {const attrs = item.attributes || []; return attrs.some((value, index) => index % 2 === 0 && value === 'id' && attrs[index + 1] === part);});
      assert(target, `CDP must expose the actual native range ${part}; pseudo-element getComputedStyle is not equivalent`);
      const {nodeIds} = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {backendNodeIds: [target.backendNodeId]});
      const {computedStyle} = await cdp.send('CSS.getComputedStyleForNode', {nodeId: nodeIds[0]});
      const values = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
      const properties = ['background-color', ...borderProperties, 'border-top-left-radius', 'box-shadow', 'width', 'height'];
      result[part] = Object.fromEntries(properties.map(property => [property, values[property]]));
    }
    return result;
  } finally {if (object.objectId) await cdp.send('Runtime.releaseObject', {objectId: object.objectId}).catch(() => {});}
}
async function assertRangeTokens(label) {
  const actual = await rangeStyles(), expected = await tokenStyles([
    {name: 'track', css: 'background:var(--accent-soft);border:1px solid var(--line);border-radius:var(--comic-control-radius);box-shadow:none;width:6px', properties: ['background-color', ...borderProperties, 'border-top-left-radius', 'box-shadow', 'width']},
    {name: 'thumb', css: 'background:var(--accent);border:1px solid var(--comic-stroke);border-radius:3px;box-shadow:var(--comic-shadow-small);width:12px;height:24px', properties: ['background-color', ...borderProperties, 'border-top-left-radius', 'box-shadow', 'width', 'height']},
  ]);
  for (const part of expected.styles) for (const [property, value] of Object.entries(part.expected)) assert.equal(actual[part.name][property], value, `${label}: native range ${part.name} ${property}`);
  measurements.push({label, nativeRange: actual});
}
async function assertStyleAnchor(anchor, display, requests, label) {
  const after = await readingOffset(), state = await surfaceState();
  assert.equal(after.page, anchor.page, `${label}: presentation changes must retain the page`);
  assert(Math.abs(after.relativeOffset - anchor.relativeOffset) < .02, `${label}: presentation changes must retain the within-page offset`);
  assert.equal(state.pageIds.length, 11, `${label}: the existing 11-slot window must not remount or expand`);
  assert(state.imageElements <= 11, `${label}: stable original presentation must retain at most 11 images`);
  assert.deepEqual(await resources(), display, `${label}: theme changes must not replace original display leases`);
  assert.equal(fixtureRequests.length, requests, `${label}: theme changes must not request original images`);
}
function releaseMtu(mode) {mtuMode = mode; for (const resolve of mtuWaiters) resolve(); mtuWaiters.clear();}
async function runStyles() {
  stage = 'shared reader presentation tokens';
  await open(local + '/generic');
  await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => {document.documentElement.style.fontSize = '10px';});
  await start(); await applyTheme('light', 'sky', 1); await jump(6);
  await assertIcons('styles-shared-reader');
  await until(async () => {const state = await surfaceState(); return state.pageIds.length === 11 && state.decodedImageElements === 11;}, 'The local style fixture must settle on its full bounded window');
  await page.mouse.move(640, 450); await page.mouse.wheel(0, 140); await pause(180);
  const anchor = await readingOffset(); assert.equal(anchor.page, 6);
  await button(['阅读设置']);
  const display = await resources(), requests = fixtureRequests.length, variants = [], baseline = await tokenStyles(styleTargets);
  assertTokenStyles(baseline, 'light-sky');
  for (const appearance of ['light', 'dark']) for (const accent of ['sky', 'rose', 'mint', 'iris', 'amber', 'slate']) {
    await applyTheme(appearance, accent, 1);
    const snapshot = await tokenStyles(styleTargets); assertTokenStyles(snapshot, `${appearance}-${accent}`);
    await assertRangeTokens(`styles-range-${appearance}-${accent}`);
    await assertStyleAnchor(anchor, display, requests, `${appearance}-${accent}`);
    variants.push(snapshot);
    if (accent === 'sky') await page.screenshot({path: path.join(out, `styles-${appearance}-sky.png`)});
  }
  for (const appearance of ['light', 'dark']) assert.equal(new Set(variants.filter(variant => variant.theme.appearance === appearance).map(variant => variant.styles.find(style => style.name === 'active-view').actual.color)).size, 6, 'Each advertised accent must visibly reach the reader controls');
  const beforeRoot = await tokenStyles(styleTargets);
  await page.evaluate(() => {document.documentElement.style.fontSize = '20px';});
  const afterRoot = await tokenStyles(styleTargets); assert.deepEqual(afterRoot.fonts, beforeRoot.fonts, 'Source root font size must not leak through shared shadow typography');
  await applyTheme('dark', 'iris', 1.25);
  const large = await tokenStyles(styleTargets); assertTokenStyles(large, 'dark-iris-large');
  for (const [selector, font] of Object.entries(beforeRoot.fonts)) assert(Math.abs(parseFloat(large.fonts[selector]) / parseFloat(font) - 1.25) < .005, `${selector} must follow the shared text scale, not a fixed px or source rem size`);
  await page.evaluate(() => {document.documentElement.style.fontSize = '10px';});
  assert.deepEqual((await tokenStyles(styleTargets)).fonts, large.fonts, 'Large UI typography must also ignore the source root size');
  await assertStyleAnchor(anchor, display, requests, 'source-root and text-scale changes');
  await page.screenshot({path: path.join(out, 'styles-dark-iris-large.png')});
  measurements.push({label: 'styles-theme-matrix', variants, sourceRootFonts: {ten: beforeRoot.fonts, twenty: afterRoot.fonts}, largeFonts: large.fonts, anchor, stableDisplayResources: display});
  check('All six accents in light/dark modes use shared reader/native-scrollbar tokens; text scale follows preferences and ignores source root sizes, preserving page/offset/11 slots and original image leases');

  stage = 'native reader progress control';
  await button(['关闭面板']); await page.mouse.move(2, 450);
  await surfaceCall(function () {this.querySelector('.nc-reader-progress').focus();});
  await page.keyboard.press('End'); await until(async () => (await surfaceState()).current === 12, 'Native range End must reach the last page');
  await page.keyboard.press('Home'); await until(async () => (await surfaceState()).current === 1, 'Native range Home must reach the first page');
  const track = await surfaceCall(function () {const element = this.querySelector('.nc-reader-progress'), rect = element.getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};});
  await page.mouse.move(track.x + track.width / 2, track.y + track.height - 12); await page.mouse.down();
  await page.mouse.move(track.x + track.width / 2, track.y + 12, {steps: 8}); await page.mouse.up();
  await until(async () => (await surfaceState()).current > 1, 'Real pointer movement on the native range must navigate pages');
  assert((await surfaceState()).pageIds.length <= 11);
  await assertRangeTokens('styles-range-after-pointer');
  await page.mouse.move(2, 450); await page.screenshot({path: path.join(out, 'styles-native-progress.png')});
  check('The native range track/thumb resolve shared accent/line/stroke/radius/shadow tokens; real keyboard and pointer navigation stay within the bounded image window');

  stage = 'shared pending and error image notices';
  await jump(6); await page.mouse.move(640, 450); await page.mouse.wheel(0, 140); await pause(180);
  const translationAnchor = await readingOffset(), beforeTranslations = mtuInputs.length;
  mtuMode = 'pending'; await button(['译图', '显示译图', '翻译']);
  await until(() => mtuInputs.length > beforeTranslations, 'The gated local MTU must receive a real translation request');
  await until(async () => surfaceCall(function () {return !!this.querySelector('.nc-image-translation.translating .nc-task-animation') && !!this.querySelector('.nc-image-translation.waiting .nc-task-animation');}), 'Pending and queued translations must reuse the shared notices and TaskActivity');
  const pendingTargets = [{name: 'pending', selector: '.nc-image-translation.translating', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-control-radius);box-shadow:var(--comic-shadow-small);font-size:var(--text-caption)', properties: [...skinProperties, 'font-size']},
    {name: 'waiting', selector: '.nc-image-translation.waiting', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-control-radius);box-shadow:var(--comic-shadow-small);font-size:var(--text-caption)', properties: [...skinProperties, 'font-size']},
    {name: 'activity', selector: '.nc-image-translation.translating .nc-task-animation', css: 'color:var(--accent)', properties: ['color']},
    {name: 'waiting-activity', selector: '.nc-image-translation.waiting .nc-task-animation', css: 'color:var(--accent)', properties: ['color']}];
  const pending = await tokenStyles(pendingTargets); assertTokenStyles(pending, 'pending-large');
  assert(!await surfaceCall(function () {return !!this.querySelector('.nc-session-page-status');}), 'Do not reintroduce a parallel translation status presentation');
  await page.mouse.move(2, 450); await page.screenshot({path: path.join(out, 'styles-translation-pending.png')});
  releaseMtu('error');
  await until(async () => surfaceCall(function () {return !!this.querySelector('.nc-image-translation.error');}), 'A local 503 must produce the real shared per-image error notice', 30000);
  const errorTargets = [{name: 'error', selector: '.nc-image-translation.error', css: 'background:var(--danger-soft);color:var(--danger);border:2px solid var(--danger);border-radius:var(--comic-control-radius);box-shadow:2px 2px 0 var(--danger);font-size:var(--text-caption)', properties: [...skinProperties, 'font-size']}];
  const darkError = await tokenStyles(errorTargets); assertTokenStyles(darkError, 'dark-error');
  await page.mouse.move(2, 450); await page.screenshot({path: path.join(out, 'styles-translation-error-dark.png')});
  const errorPalette = darkError.styles[0].actual;
  await applyTheme('dark', 'mint', 1.25); assert.deepEqual((await tokenStyles(errorTargets)).styles[0].actual, errorPalette, 'Accent changes must not change error semantics');
  await applyTheme('light', 'rose', 1);
  const lightError = await tokenStyles(errorTargets); assertTokenStyles(lightError, 'light-error');
  await page.mouse.move(2, 450); await page.screenshot({path: path.join(out, 'styles-translation-error-light.png')});
  const statusGeometry = await surfaceCall(function () {
    const viewport = this.querySelector('[data-reader-viewport]').getBoundingClientRect(), current = this.querySelector(`[data-page-index="${Number(this.host.dataset.currentPage) - 1}"]`), notice = current?.querySelector('.nc-image-translation');
    if (!notice) throw Error('The current page must retain its own status notice');
    const rect = notice.getBoundingClientRect(), page = current.getBoundingClientRect();
    return {notice: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, page: {x: page.x, y: page.y, width: page.width, height: page.height}, viewport: {x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height}, hasDismiss: !!notice.querySelector('.nc-image-translation-dismiss')};
  });
  assert(statusGeometry.hasDismiss); assert(statusGeometry.notice.x >= statusGeometry.page.x && statusGeometry.notice.x + statusGeometry.notice.width <= statusGeometry.page.x + statusGeometry.page.width + 1);
  assert(statusGeometry.notice.y >= statusGeometry.viewport.y && statusGeometry.notice.y < statusGeometry.viewport.y + statusGeometry.viewport.height, 'The current-page notice must remain visible over its own page');
  const afterError = await readingOffset(); assert.equal(afterError.page, translationAnchor.page); assert(Math.abs(afterError.relativeOffset - translationAnchor.relativeOffset) < .02);
  assert((await surfaceState()).pageIds.length <= 11); assert((await surfaceState()).visibleDecodedImages > 0, 'A translation error must leave the original image readable');
  measurements.push({label: 'styles-image-notices', pending, darkError, lightError, statusGeometry, before: translationAnchor, after: afterError, syntheticRequests: mtuInputs.length - beforeTranslations});
  // Accepted provider work can finish after switching view/closing. Drain this all-error mock window
  // before asserting that the next unrelated original-only case submits no translation work.
  await until(async () => surfaceCall(function () {return !this.querySelector('.nc-image-translation.waiting, .nc-image-translation.translating');}), 'The synthetic translation window must settle before the unrelated original-only cases', 20000);
  await button(['原图', '恢复原图']);
  await until(async () => (await surfaceState()).view === 'original', 'The error presentation must still allow returning to the original');
  await closeSurface(); releaseMtu('success');
  check('Gated/503 loopback MTU requests render shared animated pending and semantic error notices, preserve the reading position/original image and release all display resources on exit');
  await runImageFailureStyles();

  stage = 'themed source region selection';
  await open(local + '/region'); await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => {document.documentElement.style.fontSize = '20px';});
  await start(); await applyTheme('dark', 'iris', 1.25);
  const beforePicker = mtuInputs.length;
  await button(['阅读设置']); await button(['选择正文区域'], '.nc-stack-actions');
  await until(async () => surfaceCall(function () {return this.querySelector('.theme')?.dataset.picking === 'true';}), 'The picker must use the existing isolated theme root');
  const hintTarget = [{name: 'region-hint', selector: '.nc-session-region-hint', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-control-radius);box-shadow:var(--comic-shadow-small);font-size:var(--text-body)', properties: [...skinProperties, 'font-size']}];
  const hint = await tokenStyles(hintTarget); assertTokenStyles(hint, 'region-hint');
  assert.equal(hint.styles[0].actual['font-size'], '20px', 'Picker typography must use 16px shared base × 1.25, not the 20px source root');
  assert.equal(await page.locator('.nc-session-region-hint').count(), 0, 'The themed picker notice must not escape into source light DOM');
  await page.keyboard.press('Escape');
  await until(async () => surfaceCall(function () {return !this.querySelector('.theme')?.dataset.picking && !this.querySelector('.nc-session-region-hint');}), 'Escape must cancel the source-region picker');
  const pickerFocus = await surfaceCall(function () {
    const element = this.activeElement; return {insideReader: !!element?.closest('.nc-session-reader'), tag: element?.tagName || null, activeLabel: element?.getAttribute('aria-label') || element?.textContent?.trim() || null, sourceActiveTag: document.activeElement?.tagName};
  });
  measurements.push({label: 'styles-picker-escape-focus', ...pickerFocus});
  assert(pickerFocus.insideReader, 'Cancelling the source picker must restore focus inside the reader, not leave keyboard navigation on the source body');
  await button(['选择正文区域'], '.nc-stack-actions');
  await until(async () => surfaceCall(function () {return this.querySelector('.theme')?.dataset.picking === 'true';}), 'The picker must reopen after Escape');
  await page.locator('#alternate-1').scrollIntoViewIfNeeded();
  const target = await page.locator('#alternate-1').boundingBox(); assert(target);
  const point = {x: target.x + target.width / 2, y: Math.max(20, Math.min(880, target.y + target.height / 2))};
  await page.mouse.move(point.x, point.y);
  const highlight = await tokenStyles([{name: 'region-highlight', selector: '.nc-session-region-highlight', css: 'border:var(--comic-border);border-color:var(--accent);border-radius:var(--comic-control-radius);background:color-mix(in srgb,var(--accent) 12%,transparent)', properties: ['background-color', ...borderProperties, 'border-radius']}]);
  assertTokenStyles(highlight, 'region-highlight');
  await page.screenshot({path: path.join(out, 'styles-region-selection.png')});
  await page.mouse.click(point.x, point.y);
  await until(async () => {const state = await surfaceState(); return state.count === 2 && state.visibleDecodedImages > 0;}, 'The themed picker must still select the real two-page source region');
  assert.equal(mtuInputs.length, beforePicker, 'The themed original-view picker must not start translation');
  measurements.push({label: 'styles-region-picker', hint, highlight});
  await closeSurface();
  check('Source-region hint/highlight inherit shared tokens inside the isolated shadow; Escape restores reader focus and real source selection/exit work without translation');
}
async function runImageFailureStyles() {
  stage = 'shared original-image failure styling';
  await context.route('https://mangapill.com/**', adaptedRoute); await context.route('https://cdn.readdetectiveconan.com/**', adaptedRoute); fixtureRoutes = true;
  const beforeTranslations = mtuInputs.length;
  failedFixtureImages.add(6);
  try {
    await open(adaptedFixtureUrl); await start(); assert.equal((await surfaceState()).count, 12); await applyTheme('dark', 'mint', 1.25); await jump(6, false);
    await until(async () => surfaceCall(function () {return !!this.querySelector('[data-page-index="5"] .nc-image-failure');}), 'The style fixture must expose a real isolated failed original');
    const targets = [
      {name: 'image-failure', selector: '[data-page-index="5"] .nc-image-failure', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-card-radius);box-shadow:var(--comic-shadow-small)', properties: skinProperties},
      {name: 'image-retry', selector: '[data-page-index="5"] .nc-image-failure .button', css: 'background:var(--surface);color:var(--ink);border:var(--comic-border);border-radius:var(--comic-control-radius);box-shadow:var(--comic-shadow-small);font-size:var(--text-body)', properties: [...skinProperties, 'font-size']},
    ];
    await page.mouse.move(2, 450); const dark = await tokenStyles(targets); assertTokenStyles(dark, 'dark-image-failure');
    await page.screenshot({path: path.join(out, 'styles-image-failure-dark.png')});
    await applyTheme('light', 'sky', 1); const light = await tokenStyles(targets); assertTokenStyles(light, 'light-image-failure');
    await page.screenshot({path: path.join(out, 'styles-image-failure-light.png')});
    assert((await surfaceState()).pageIds.length <= 11);
    const neighbour = await surfaceCall(function () {const image = this.querySelector('[data-page-index="6"] img'); return !!image?.complete && image.naturalWidth > 0;});
    assert(neighbour, 'Failure styling must not replace a neighbouring original with a global error');
    failedFixtureImages.delete(6); await button(['重试'], '[data-page-index="5"]');
    await until(async () => surfaceCall(function () {const cell = this.querySelector('[data-page-index="5"]'), image = cell?.querySelector('img'); return !cell?.querySelector('.nc-image-failure') && !!image?.complete && image.naturalWidth > 0;}), 'The styled retry must still recover the failed original');
    assert.equal((await surfaceState()).current, 6); assert.equal(mtuInputs.length, beforeTranslations, 'Original failure/retry must not add a translation request after the prior translation fixture has settled');
    measurements.push({label: 'styles-original-image-failure', dark, light});
    await closeSurface();
    check('A real failed original and its retry action use shared light/dark/large-text tokens; retry recovers only that page while neighbours remain readable and no translation runs');
  } finally {
    failedFixtureImages.delete(6);
    await context.unroute('https://mangapill.com/**', adaptedRoute); await context.unroute('https://cdn.readdetectiveconan.com/**', adaptedRoute); fixtureRoutes = false;
  }
}
async function runAdaptedFixture() {
  stage = '500-page synthetic adapted manifest';
  await context.route('https://mangapill.com/**', adaptedRoute); await context.route('https://cdn.readdetectiveconan.com/**', adaptedRoute); fixtureRoutes = true;
  const beforeImages = fixtureRequests.length, firstImageMs = await open(adaptedFixtureUrl);
  const sourcePosition = await originalPosition();
  await metrics('manifest-original'); const opened = await start();
  assert.equal(opened.state.count, limits.fixturePages); assert.equal(opened.state.complete, 'true');
  assert(opened.state.pageIds.length <= 11, 'A complete 500-page manifest must not mount a whole chapter');
  assert.equal(new Set(opened.state.pageIds).size, opened.state.pageIds.length, 'Manifest page identities must stay distinct');
  assert(fixtureRequests.length - beforeImages <= 20, 'First screen fetched too many images for a bounded reader');
  await metrics('manifest-immersive-first');
  measurements.push({label: 'manifest-first-image', originalAfterNavigationMs: firstImageMs, ...opened});
  await jump(250); await metrics('manifest-page-250'); assert((await surfaceState()).pageIds.length <= 11);
  await page.mouse.move(640, 450); await page.mouse.wheel(0, 160); await pause(180);
  const reloadPosition = await readingOffset(), beforeReloadRequests = fixtureRequests.length;
  assert.equal(reloadPosition.page, 250);
  await button(['阅读设置']); await button(['重新载入'], '.nc-stack-actions');
  await until(async () => {const state = await surfaceState(); return state.loading === 'false' && state.visibleDecodedImages > 0;}, 'Manual manifest reload did not finish');
  // A successful resolve may remount the presentation and close its drawer.
  if ((await surfaceState()).buttons.includes('关闭面板')) await button(['关闭面板']);
  await pause(150);
  const reloadedPosition = await readingOffset();
  assert.equal(reloadedPosition.page, 250, 'Manual manifest reload must not reset to page 1');
  assert(Math.abs(reloadedPosition.relativeOffset - reloadPosition.relativeOffset) < 0.02, 'Manual manifest reload must preserve the within-page offset');
  assert(fixtureRequests.length - beforeReloadRequests <= 15, 'Manual reload must not reload the whole chapter');
  measurements.push({label: 'manifest-reload-position', before: reloadPosition, after: reloadedPosition, requests: fixtureRequests.length - beforeReloadRequests});
  check('Manual manifest reload preserves page 250 and its within-page offset with a bounded image window');
  await jump(499); await metrics('manifest-page-499'); assert((await surfaceState()).pageIds.length <= 11);
  await jump(3); const repeated = await surfaceState(); assert.equal(new Set(repeated.pageIds).size, repeated.pageIds.length);
  assert(fixtureRequests.length - beforeImages < 60, 'Jumping must not read intermediate or all chapter images');
  await page.screenshot({path: path.join(out, 'manifest-500-pages.png')});
  stage = 'isolated synthetic page failure and retry';
  const beforeFailureRequests = fixtureRequests.length, beforeTranslations = mtuInputs.length;
  failedFixtureImages.add(100);
  await jump(100, false);
  await until(async () => surfaceCall(function () {
    const failed = this.querySelector('[data-page-index="99"] .nc-image-failure');
    const neighbour = this.querySelector('[data-page-index="100"] img');
    return !!failed && !!neighbour?.complete && neighbour.naturalWidth > 0;
  }), 'A failed page must show its own failure while an adjacent page remains readable');
  assert.equal((await surfaceState()).error, ''); assert((await surfaceState()).pageIds.length <= 11);
  await page.screenshot({path: path.join(out, 'manifest-isolated-page-failure.png')});
  failedFixtureImages.delete(100);
  await button(['重试'], '[data-page-index="99"]');
  await until(async () => surfaceCall(function () {
    const cell = this.querySelector('[data-page-index="99"]'), image = cell?.querySelector('img');
    return !cell?.querySelector('.nc-image-failure') && !!image?.complete && image.naturalWidth > 0;
  }), 'Retry did not recover the failed original image');
  assert.equal((await surfaceState()).current, 100);
  assert.equal(mtuInputs.length, beforeTranslations, 'Original image failure/retry must not invoke translation');
  assert(fixtureRequests.length - beforeFailureRequests <= 15, 'A failed-page retry must not fan out beyond its image window');
  await metrics('manifest-recovered-failure');
  check('A single original-image failure does not block its neighbours; real retry recovers that page without a model call');
  await closeSurface(); assert.deepEqual(await originalPosition(), sourcePosition, 'An unloaded/unmapped manifest page must leave the original webpage position unchanged'); await metrics('manifest-after-close');
  check('Complete 500-page source metadata stays separate from bounded image mounting/requests; distant jumps and duplicate-URL slots work');
  await context.unroute('https://mangapill.com/**', adaptedRoute); await context.unroute('https://cdn.readdetectiveconan.com/**', adaptedRoute); fixtureRoutes = false;
}
async function runTranslation() {
  stage = 'loopback-only translation view';
  await open(local + '/generic'); await page.locator('img[src]').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await start(); const original = await surfaceState(), before = mtuInputs.length;
  await button(['显示译图', '译图', '翻译', 'Translated', 'Show translation']);
  await until(() => mtuInputs.length > before, 'The local MTU fixture received no translation input');
  const translatedHash = createHash('sha256').update(translated).digest('hex');
  await until(async () => surfaceCall(async function (expected) {
    const viewport = this.querySelector('[data-reader-viewport]')?.getBoundingClientRect(); if (!viewport) return false;
    for (const image of this.querySelectorAll('img')) {
      const rect = image.getBoundingClientRect(); if (!image.complete || !image.naturalWidth || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      try {
        const bytes = await (await fetch(image.currentSrc || image.src)).arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash === expected) return true;
      } catch { /* A view swap may retire this display between selection and reading. */ }
    }
    return false;
  }, translatedHash), 'The visible translated image did not match the local MTU output', 30000);
  await pause(750);
  await page.screenshot({path: path.join(out, 'generic-translated-view.png')});
  const state = await surfaceState(), submitted = new Map();
  for (const input of mtuInputs) submitted.set(input.sha256, (submitted.get(input.sha256) ?? 0) + 1);
  await button(['恢复原图', '原图', 'Original', 'Show original']);
  await until(async () => (await surfaceState()).view === original.view, 'Original view was not restored');
  assert.equal((await surfaceState()).current, state.current, 'View switching must retain the current logical page');
  await button(['显示译图', '译图', '翻译', 'Translated', 'Show translation']);
  await pause(750);
  for (const [hash, count] of submitted) assert.equal(mtuInputs.filter(input => input.sha256 === hash).length, count, 'Restoring a cached input must not resubmit it; new neighbours may still be admitted');
  await closeSurface();
  check('Original/translated switching uses only the loopback MTU, keeps the logical page and reuses cached results without resubmission');
}
async function runLive(kind, input) {
  stage = 'live ' + kind; scope = 'live'; assert(!fixtureRoutes, 'Synthetic source routing must be removed before live checks');
  const url = new URL(input); assert(url.protocol === 'https:' && !url.username && !url.password, 'Only public credential-free HTTPS pages are accepted');
  assert(!url.search, 'Choose a public non-signed page URL without query parameters');
  liveOrigins.clear(); for (const origin of [url.origin, ...liveImageOrigins]) liveOrigins.add(origin);
  const firstImageMs = await open(url.href), before = await originalPosition();
  await metrics('live-' + kind + '-original');
  const opened = await start(); assert(opened.state.count > 0 && opened.state.visibleDecodedImages > 0);
  if (kind === 'generic') assert.equal(opened.state.complete, 'false');
  if (kind === 'adapted') assert.equal(opened.state.complete, 'true', 'The selected known source must expose a complete chapter manifest');
  assert(opened.state.pageIds.length <= 11);
  await assertIcons('live-' + kind);
  await metrics('live-' + kind + '-immersive');
  measurements.push({label: 'live-' + kind + '-first-image', url: sourceUrl(input), originalAfterNavigationMs: firstImageMs, ...opened});
  await page.screenshot({path: path.join(out, 'live-' + kind + '.png')});
  await closeSurface();
  const after = await originalPosition(); assert.equal(after.y, before.y); assert.equal(after.x, before.x);
  assert.equal(mtuInputs.length, reportMtuBeforeLive, 'No public-source image may be sent to the translation fixture');
  liveChecks.push({kind, url: sourceUrl(input)});
  check(`Real public ${kind} page and original images render in the installed MV3, with unmodified source responses and no model call`);
}
let reportMtuBeforeLive = 0;
try {
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: !headed, channel: 'chromium',
    executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, locale: 'zh-CN', viewport: {width: 1280, height: 900}, reducedMotion: 'reduce',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  context.setDefaultTimeout(30000); watchdog = setTimeout(() => fail('Verification exceeded its bounded five-minute budget'), limits.timeoutMs);
  context.on('request', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.origin === local && url.pathname.startsWith('/v1/')) return;
    network.requests++; currentRequests++;
    if (request.resourceType() === 'image' || /\.(?:png|webp|jpe?g)(?:$|\?)/i.test(url.href)) {network.imageRequests++; currentImages++;}
    if (scope === 'live' && url.origin !== local && ++publicRequests > limits.publicRequests) fail('Public HTTP request budget exceeded');
  });
  context.on('response', response => {
    const url = new URL(response.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === local && url.pathname.startsWith('/v1/')) return;
    const image = /^image\//i.test(response.headers()['content-type'] || ''); if (image) network.imageResponses++;
    if (scope === 'live' && url.origin !== local) {
      if (image && ++publicImages > limits.publicImages) fail('Public image response budget exceeded');
      if (response.status() >= 400 && publicFailures.length < 20) publicFailures.push({origin: url.origin, status: response.status(), image});
      if (response.status() === 429) fail('Public source returned HTTP 429; no automatic retry is performed');
    }
  });
  context.on('requestfinished', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol)) return;
    const isPublic = scope === 'live' && url.origin !== local;
    const pending = request.sizes().then(size => {network.completedBodyBytes += size.responseBodySize; if (isPublic && (publicBytes += size.responseBodySize) > limits.publicBytes) fail('Public image/HTML byte budget exceeded');}).catch(() => {}).finally(() => pendingSizes.delete(pending)); pendingSizes.add(pending);
  });
  await context.route(/^https?:\/\//, route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'comics.nodelane.net') {network.blockedServiceRequests++; return route.abort('blockedbyclient');}
    if (stylesOnly && url.origin !== local) {network.blockedThirdPartyRequests++; blockedOrigins[url.origin] = (blockedOrigins[url.origin] ?? 0) + 1; return route.abort('blockedbyclient');}
    if (scope === 'live' && url.origin !== local && !liveOrigins.has(url.origin)) {
      network.blockedThirdPartyRequests++; blockedOrigins[url.origin] = (blockedOrigins[url.origin] ?? 0) + 1;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  await until(() => context.pages().some(candidate => candidate.url() === `chrome-extension://${extensionId}/reader.html`), 'The extension welcome page did not open');
  const welcome = context.pages().find(candidate => candidate.url() === `chrome-extension://${extensionId}/reader.html`);
  await welcome.locator('.nc-app').waitFor(); await welcome.close();
  probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/immersive-inspect.html`);
  if (headed) {
    const probeCdp = await context.newCDPSession(probe);
    await probeCdp.send('Emulation.setFocusEmulationEnabled', {enabled: false});
  }
  const panels = await probe.evaluate(async () => {
    const image = async (color, label) => {const canvas = new OffscreenCanvas(800, 1100), drawing = canvas.getContext('2d'); drawing.fillStyle = color; drawing.fillRect(0, 0, 800, 1100); drawing.strokeStyle = '#263954'; drawing.lineWidth = 7; drawing.strokeRect(32, 32, 736, 1036); drawing.strokeRect(60, 260, 680, 300); drawing.strokeRect(60, 590, 680, 380); drawing.fillStyle = '#263954'; drawing.font = '42px system-ui'; drawing.fillText(label, 65, 150); return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];};
    return {originals: await Promise.all(['#fff3df', '#e3efff', '#edf6e5', '#f7e5ed'].map((color, index) => image(color, 'ORIGINAL SYNTHETIC PAGE ' + (index + 1)))), translated: await image('#dbf4f0', 'LOCAL MOCK TRANSLATION')};
  });
  originals = panels.originals.map(bytes => Buffer.from(bytes)); translated = Buffer.from(panels.translated);
  await probe.evaluate(async local => {
    await chrome.storage.local.remove('nc-auth');
    await chrome.storage.local.set({'nc-reader-settings': {autoTranslateTabs: false, language: 'zh-Hans', translationMode: 'classic', uiLanguage: 'zh-CN', cacheLimitMb: 128, layout: 'continuous', fit: 'width', discoveryTextTranslation: false},
      'nc-translation-channels': {activeId: 'isolated-immersive', profiles: [{id: 'isolated-immersive', name: 'Synthetic MTU', adapterId: 'manga-translator-ui', revision: 1, settings: {baseUrl: local + '/', username: 'fixture'}}]}});
    const db = await new Promise((resolve, reject) => {const request = indexedDB.open('node-comics-reading-v2-translation-channel-credentials', 1); request.onupgradeneeded = () => request.result.createObjectStore('credentials', {keyPath: 'id'}); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
    await new Promise((resolve, reject) => {const transaction = db.transaction('credentials', 'readwrite'); transaction.objectStore('credentials').put({id: 'isolated-immersive', values: {token: 'isolated-immersive-token'}}); transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error);}); db.close();
  }, local);
  if (fixtures) {
    if (stylesOnly) await runStyles();
    else {await runHttpDiagnostic(); if (!flags.has('--http-only')) {await runGeneric(); await runRegionSelection(); await runLateFirstImage(); await runAdaptedFixture(); if (!flags.has('--no-translation')) await runTranslation();}}
  }
  reportMtuBeforeLive = mtuInputs.length;
  if (live) {await runLive('adapted', process.env.IMMERSIVE_LIVE_ADAPTED_URL || 'https://mangapill.com/chapters/2-11194000/one-piece-chapter-1194'); await runLive('generic', process.env.IMMERSIVE_LIVE_GENERIC_URL || 'https://xkcd.com/353/');}
  await Promise.all([...pendingSizes]); assert.equal(fatal, undefined); assert.deepEqual(errors, []); assert.equal(network.modelRequests, 0);
  stage = 'complete';
} catch (error) {
  fatal ??= error;
  if (page && !page.isClosed()) await metrics('failure-state').catch(() => {});
  if (page && !page.isClosed()) await page.screenshot({path: path.join(out, 'failure.png'), timeout: 3000}).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  const report = {status: fatal ? 'failed' : 'passed', stage, build: {version: manifest.version, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), originalJavaScriptSha256: buildJavaScriptSha256}, headed, focusEmulationDisabled: headed, fixtures, stylesOnly, liveRequested: live, liveSource: liveChecks.length > 0, liveChecks, liveProvider: false,
    checks, unverifiedChecks, limits, network, public: {requests: publicRequests, imageResponses: publicImages, completedBodyBytes: publicBytes, blockedOrigins, failures: publicFailures}, mtu: {requests: mtuInputs.length, inputs: mtuInputs}, measurements, errors,
    ...(fatal ? {error: redact(fatal.message)} : {}),
    boundary: 'Actual built MV3 in a fresh isolated desktop Chromium profile. Synthetic page/image responses are confined to fixture mode and removed before live checks. Live allows the selected source origin and explicit image-CDN origins only; unrelated advertising/tracking/frames are blocked and counted. Allowed public HTML/CDN responses are never rewritten. Translation is a loopback synthetic MTU only; public-source runs never translate. CDP heap metrics describe target JavaScript heap/backing storage, not total browser/process/GPU memory. decodedImageElements counts loaded image elements with positive intrinsic dimensions, not the browser decoder cache. Routing may disable browser HTTP caching, so request counts do not prove production cache-hit efficiency. First-image timings have distinct navigation and warm-source activation start points. Native extension-menu gestures, production service/model quality, physical mobile devices and total decoded-memory peaks are not certified.'};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({out, status: report.status, stage, checks: checks.length, unverified: unverifiedChecks.length, liveSource: report.liveSource, liveProvider: false, error: report.error}, null, 2));
  releaseMtu('success'); await context?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
