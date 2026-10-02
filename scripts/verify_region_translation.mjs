// Built MV3 extension, real captureVisibleTab, isolated profile and synthetic API/pixels.
// No real account, source site, model or paid translation is contacted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {probeImageMetadata} from '../backend/shared/translation-images/image-metadata.ts';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve('artifacts/region-validation', randomUUID());
await mkdir(out, {recursive: true});
const extension = path.join(out, 'extension');
await cp(path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert(manifest.permissions.includes('activeTab'), 'region capture requires activeTab');
assert(!manifest.content_scripts?.some(entry => entry.js.includes('content-scripts/region.js')), 'region selection must not inject automatically');
// CDP mouse events cannot click the browser's own extension action/context menu to
// grant activeTab. This isolated copy grants capture only for the pipeline fixture;
// never change the shipped manifest or claim native-action permission acceptance.
const temporaryCapturePermission = process.env.REGION_CAPTURE_FIXTURE_PERMISSION !== '0';
if (temporaryCapturePermission) {
  assert(!manifest.host_permissions.includes('<all_urls>'), 'the production build must not gain broader host access for this fixture');
  manifest.host_permissions.push('<all_urls>');
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  console.log('INFO Temporary <all_urls> capture permission applies only to the isolated fixture copy; native action gesture is not exercised');
}

const checks = [], errors = [], requests = [], resultRequests = [], uploads = new Map(), translations = new Map();
const mtuInputs = [];
let holdMtuResponse = true, releaseMtuResponse;
const streams = new Set();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = message => {checks.push(message); console.log('PASS ' + message);};
const rights = {plan: 'free', image_rate_limit: {window_seconds: 60, limit: 100}, timezone: 'Asia/Shanghai',
  plus_started_at: null, plus_expires_at: null, pending_previous_period_pages: 0,
  modes: {classic: {allowed: true, unlimited: true, quota_kind: 'classic_unlimited', consent_version: 'fixture', quota: null}}};
const caps = {result_protocol: 'overlay-v1', modes: [{id: 'classic', enabled: true, label: '常规翻译', languages: ['zh-Hans']}],
  languages: [{id: 'zh-Hans', label: '简体中文'}], limits: {max_bytes: 41943040, max_pixels: 60000000, max_dimension: 20000}, entitlements: rights};
let source, nextSource, output, api, site, complete = true;
const refresh = () => {
  for (const record of translations.values()) if (complete && record.state === 'queued' && Date.now() - record.uploadedAt > 100) {
    record.state = 'succeeded'; record.updatedAt = new Date().toISOString();
  }
};
const snapshot = id => {
  const record = translations.get(id);
  if (!record) return;
  return {id, state: record.state, mode: record.intent.mode, target_language: record.intent.target_language,
    image_sha256: record.intent.image.sha256, created_at: record.createdAt, updated_at: record.updatedAt,
    result: record.state === 'succeeded' ? {kind: 'translated', representation: 'overlay-v1',
      input_sha256: record.intent.image.sha256, normalization_version: 1, width: record.width, height: record.height,
      bbox: {x: 24, y: 24, width: 128, height: 80}, composite: 'source-atop',
      artifact: {sha256: sha(output), byte_size: output.length, mime: 'image/webp', path: '/v1/translations/' + id + '/result'}} : null, error: null};
};
const apiServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    const json = (body, status = 200, headers = {}) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers});
      res.end(JSON.stringify(body));
    };
    let body;
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
      if (req.headers['content-type']?.includes('application/json')) body = JSON.parse(body);
    }
    requests.push({method: req.method, path: url.pathname, authorization: !!req.headers.authorization});
    refresh();
    if (url.pathname === '/translate/with-form/image' && req.method === 'POST') {
      assert.equal(req.headers['x-session-token'], 'isolated-region-mtu-token');
      assert.equal(req.headers.authorization, undefined);
      const form = await new Response(body, {headers: {'Content-Type': req.headers['content-type']}}).formData();
      const image = form.get('image');
      assert(image instanceof Blob);
      assert.equal(JSON.parse(form.get('config')).translator.target_lang, 'CHS');
      const bytes = Buffer.from(await image.arrayBuffer());
      mtuInputs.push({bytes: bytes.length, sha256: sha(bytes)});
      if (holdMtuResponse) await new Promise(resolve => {releaseMtuResponse = resolve;});
      res.writeHead(200, {'Content-Type': image.type, 'Cache-Control': 'no-store'}); res.end(bytes); return;
    }
    if (url.pathname === '/v1/auth/config') return json({dev_auth: true});
    if (url.pathname === '/v1/capabilities') return json(caps);
    if (url.pathname === '/v1/me/entitlements') return json(rights);
    if (url.pathname === '/v1/translations/events' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      let previous;
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'});
      streams.add(res);
      const update = () => {
        refresh();
        const items = ids.map(snapshot).filter(Boolean);
        const data = JSON.stringify({items, missing_ids: ids.filter(id => !translations.has(id))});
        if (data !== previous) {previous = data; res.write('event: snapshot\ndata: ' + data + '\n\n');}
        if (items.length === ids.length && items.every(item => item.state === 'succeeded')) res.end('event: end\ndata: {"reason":"complete"}\n\n');
      };
      const timer = setInterval(update, 50);
      res.on('close', () => {clearInterval(timer); streams.delete(res);});
      update(); return;
    }
    if (url.pathname === '/v1/translations' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      return json({items: ids.map(snapshot).filter(Boolean), missing_ids: ids.filter(id => !translations.has(id))});
    }
    const route = url.pathname.match(/^\/v1\/translations\/([a-f0-9-]{36})(\/(input|result))?$/);
    if (route) {
      assert(req.headers.authorization, 'translation API requires the synthetic account');
      const [, id, , operation] = route;
      const record = translations.get(id);
      if (operation === 'input' && req.method === 'PUT') {
        assert(record, 'input requires a persisted translation intent');
        assert.equal(sha(body), record.intent.image.sha256);
        assert.equal(body.length, record.intent.image.byte_size);
        const size = await probeImageMetadata(new Blob([body]));
        assert(size, 'uploaded crop must decode as an accepted image');
        uploads.set(id, body);
        Object.assign(record, {width: size.width, height: size.height, state: 'queued', uploadedAt: Date.now(), updatedAt: new Date().toISOString()});
        return json(snapshot(id), 202);
      }
      if (operation === 'result' && req.method === 'GET') {
        assert.equal(record?.state, 'succeeded'); resultRequests.push(id);
        res.writeHead(200, {'Content-Type': 'image/webp', 'Cache-Control': 'no-store'}); res.end(output); return;
      }
      if (!operation && req.method === 'PUT') {
        assert.equal(req.headers['x-translation-protocol'], 'overlay-v1');
        const {priority, ...intent} = body;
        if (record) assert.deepEqual(intent, record.intent, 'UUID replay must preserve the frozen input');
        else translations.set(id, {intent, state: 'needs_input', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
        return json(snapshot(id), 202);
      }
      if (!operation && req.method === 'GET') return record ? json(snapshot(id)) : json({error: {code: 'NOT_FOUND'}}, 404);
    }
    throw Error('Unexpected fixture endpoint: ' + req.method + ' ' + url.pathname);
  } catch (error) {
    errors.push(error.stack); res.writeHead(500); res.end('fixture failure');
  }
});
await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
api = `http://127.0.0.1:${apiServer.address().port}`;
const siteServer = createServer((req, res) => {
  if (req.url === '/source.png' || req.url === '/source-next.png') {
    res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'});
    res.end(req.url === '/source.png' ? source : nextSource); return;
  }
  res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'});
  res.end(`<!doctype html><meta charset="utf-8"><title>划图翻译隔离验收</title><style>
    html{scroll-behavior:auto}body{margin:0;background:#dce4ef;font:20px sans-serif;color:#24334d}
    header{height:100px;box-sizing:border-box;padding:28px;background:#fff}main{margin:40px 100px;width:700px}
    #comic{display:block;width:700px;height:480px;transform:matrix(1,0,0,1,0,0)}#plain{margin-top:40px;width:700px;height:320px;background:#a8d5bb;border:0;box-sizing:border-box;padding:35px}
    footer{height:1200px}button{font:inherit}</style><header>Only selected pixels may leave this page. <input id="site-input" aria-label="Website input"></header>
    <main><img id="comic" src="/source.png"><section id="plain">Arbitrary page content<br><br>HELLO REGION</section><button id="site-action">Website action</button></main><footer></footer>`);
});
await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
site = `http://127.0.0.1:${siteServer.address().port}`;

for (const file of await readdir(extension, {recursive: true})) if (file.endsWith('.js')) {
  const target = path.join(extension, file), value = await readFile(target, 'utf8');
  await writeFile(target, value.replaceAll(process.env.REGION_BUILD_API || 'https://comics.nodelane.net', api));
}
const background = path.join(extension, 'background.js');
await writeFile(background, `
globalThis.fixtureMenus=[];globalThis.fixtureCaptureCalls=0;globalThis.fixtureCaptureBytes=0;globalThis.fixtureCaptureDurationsMs=[];globalThis.fixtureCaptureReplies=[];globalThis.fixtureHoldCapture=false;globalThis.fixtureCapturePaused=false;globalThis.fixturePermissionRequests=0;globalThis.fixtureExternalRequests=[];
globalThis.fixtureRegionImages=[];globalThis.fixtureRegionRecordWrites=0;
chrome.runtime.onConnect.addListener(port=>{if(port.name==='NC_REGION_IMAGE')port.onMessage.addListener(message=>{if(message?.type==='open')fixtureRegionImages.push({kind:message.request.kind,selectionId:message.request.selectionId})})});
const nativeStorePut=IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put=function(value,...args){if(this.name==='records'&&this.transaction.db.name==='node-comics-reading-v2-region-inputs-v1')fixtureRegionRecordWrites++;return nativeStorePut.call(this,value,...args)};
const nativeMenuCreate=chrome.contextMenus.create.bind(chrome.contextMenus);
chrome.contextMenus.create=(...args)=>{fixtureMenus.push(args[0]);return nativeMenuCreate(...args)};
const nativeMenuListener=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);
chrome.contextMenus.onClicked.addListener=listener=>{globalThis.fixtureMenu=listener;return nativeMenuListener(listener)};
const nativeCapture=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
globalThis.fixtureBaselineCapture=()=>nativeCapture(undefined,{format:'png'});
chrome.tabs.captureVisibleTab=async(...args)=>{fixtureCaptureCalls++;const started=performance.now();let result;try{result=await nativeCapture(...args)}catch(error){globalThis.fixtureNativeCaptureError=error.message;throw error}fixtureCaptureBytes=Math.floor((result.length-result.indexOf(',')-1)*3/4);fixtureCaptureDurationsMs.push(performance.now()-started);if(fixtureHoldCapture){fixtureCapturePaused=true;await new Promise(resolve=>{globalThis.fixtureReleaseCapture=resolve})}return result};
const nativeMessageListener=chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
chrome.runtime.onMessage.addListener=listener=>nativeMessageListener((message,sender,respond)=>listener(message,sender,response=>{if(message?.type==='NC_REGION_CAPTURE')fixtureCaptureReplies.push(response);respond(response)}));
chrome.permissions.request=()=>{fixturePermissionRequests++;throw Error('Unexpected runtime permission request')};
const nativeFetch=fetch;
globalThis.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(/^https?:/.test(url)&&!url.startsWith(${JSON.stringify(api + '/')})){fixtureExternalRequests.push(url);return Promise.resolve(Response.json({}))}return nativeFetch(input,options)};
` + await readFile(background, 'utf8'));

const executablePath = process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH;
const deviceScaleFactor = Number(process.env.REGION_DPR || 2);
assert([1, 1.25, 1.5, 2].includes(deviceScaleFactor), 'REGION_DPR must be 1, 1.25, 1.5 or 2');
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {channel: 'chromium', headless: true,
  ...(executablePath ? {executablePath} : {}), viewport: {width: 1280, height: 900}, deviceScaleFactor, reducedMotion: 'no-preference',
  args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
browser.setDefaultTimeout(15000);
const externalPageRequests = [];
await browser.route(/^https?:/, route => {
  const url = route.request().url();
  if (url.startsWith(api + '/') || url.startsWith(site + '/')) return route.continue();
  externalPageRequests.push(url); return route.fulfill({json: {}});
});
let worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).hostname;
const page = await browser.newPage();
page.on('pageerror', error => errors.push(error.stack));
const cdp = await browser.newCDPSession(page);
const inspector = await browser.newPage();
async function waitUntil(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 50));}
}
async function button(name, click = true) {
  let node;
  await waitUntil(async () => {node = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(entry => entry.role?.value === 'button' &&
    (name instanceof RegExp ? name.test(entry.name?.value || '') : entry.name?.value === name)); return !!node;}, 'Missing button: ' + name);
  if (!click) return node;
  const {model} = await cdp.send('DOM.getBoxModel', {backendNodeId: node.backendDOMNodeId});
  const q = model.content;
  await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}
async function activate() {
  await page.bringToFront();
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(entry => entry.url === url);
    if (!tab) throw Error('Fixture page is not a browser tab');
    await chrome.tabs.update(tab.id, {active: true});
    await fixtureMenu({menuItemId: 'nc-translate-region', pageUrl: url}, tab);
  }, page.url());
}
async function beginDrag(rect) {
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width, rect.y + rect.height, {steps: 12});
}
async function select(rect) {
  await beginDrag(rect);
  const releasedAt = performance.now();
  await page.mouse.up();
  return releasedAt;
}
async function regionRecords(includeBytes = false) {
  return worker.evaluate(async includeBytes => {
    const name = 'node-comics-reading-v2-region-inputs-v1';
    if (!(await indexedDB.databases()).some(database => database.name === name)) return [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const read = request => new Promise((resolve, reject) => {request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
      const records = await read(db.transaction('records').objectStore('records').getAll());
      if (!includeBytes) return records;
      return Promise.all(records.map(async record => {
        const blob = await read(db.transaction('blobs').objectStore('blobs').get(record.id + ':source'));
        return {...record, source: blob ? [...new Uint8Array(await blob.arrayBuffer())] : undefined};
      }));
    } finally {db.close();}
  }, includeBytes);
}
async function shadowBox(attribute, effects = false) {
  const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
  const find = node => {
    if (node.attributes?.includes(attribute)) return node;
    for (const child of [...node.children || [], ...node.shadowRoots || []]) {const match = find(child); if (match) return match;}
  };
  const node = find(tree.root);
  if (!node) return;
  const {object} = await cdp.send('DOM.resolveNode', {backendNodeId: node.backendNodeId});
  try {
    const {result} = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, returnByValue: true,
      arguments: [{value: effects}],
      functionDeclaration: 'function(effects){const css=getComputedStyle(this);if(css.display===\'none\'||css.visibility===\'hidden\')return null;const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,...(effects?{pointerEvents:css.pointerEvents,animations:this.getAnimations({subtree:true}).map(animation=>({playState:animation.playState,animationName:animation.animationName}))}:{})}}'});
    return result.value || undefined;
  } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
}
const translatedBox = () => shadowBox('data-nc-region-translation');
const settleLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const translationTraffic = () => ({jobs: translations.size, uploads: uploads.size, downloads: resultRequests.length,
  writes: requests.filter(request => request.method === 'PUT').length});
async function previewVisible(title) {
  return (await cdp.send('Accessibility.getFullAXTree')).nodes.some(node => node.role?.value === 'region' &&
    (title ? node.name?.value === title : ['截图预览', '译图预览'].includes(node.name?.value)));
}
async function previewLoaded(title) {
  const node = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(entry => entry.role?.value === 'image' && entry.name?.value === title);
  if (!node) return false;
  const {object} = await cdp.send('DOM.resolveNode', {backendNodeId: node.backendDOMNodeId});
  try {
    const {result} = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function(){return this.complete&&this.naturalWidth>0&&!this.hidden}'});
    return result.value;
  } finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
}
function assertBox(actual, expected, message) {
  assert(actual, message + ': overlay is missing');
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actual[key] - expected[key]) < .02,
    message + ': ' + key + ' differs (' + actual[key] + ' vs ' + expected[key] + ')');
}
async function mutateUnrelatedDom(phase) {
  await page.evaluate(phase => {
    const unrelated = document.createElement('span'); unrelated.hidden = true; unrelated.textContent = phase;
    document.querySelector('header').append(unrelated);
    document.querySelector('#site-action').setAttribute('data-fixture-state', phase);
    const ancestor = document.querySelector('main');
    ancestor.setAttribute('data-fixture-state', phase); ancestor.classList.add('fixture-no-layout');
    ancestor.style.setProperty('--fixture-no-layout', phase);
  }, phase);
  await settleLayout();
}
async function restartWorker() {
  const versions = new Map();
  const updated = ({versions: incoming}) => {for (const version of incoming) versions.set(version.versionId, version);};
  cdp.on('ServiceWorker.workerVersionUpdated', updated);
  await cdp.send('ServiceWorker.enable');
  await waitUntil(() => [...versions.values()].some(version => version.scriptURL.includes(extensionId) && version.runningStatus === 'running'), 'Extension worker not found');
  const version = [...versions.values()].find(value => value.scriptURL.includes(extensionId) && value.runningStatus === 'running');
  const marker = await worker.evaluate(() => {globalThis.fixtureRestartMarker = crypto.randomUUID(); return fixtureRestartMarker;});
  await cdp.send('ServiceWorker.stopWorker', {versionId: version.versionId});
  await cdp.send('ServiceWorker.startWorker', {scopeURL: `chrome-extension://${extensionId}/`});
  await waitUntil(async () => {
    worker = browser.serviceWorkers().find(value => value.url().includes(extensionId)) || worker;
    return await worker.evaluate(() => globalThis.fixtureRestartMarker).catch(() => marker) === undefined;
  }, 'Extension worker did not restart');
  cdp.off('ServiceWorker.workerVersionUpdated', updated);
  await cdp.send('ServiceWorker.disable');
}
async function pixelComparison(before, after, ignore, beforeCrop) {
  return inspector.evaluate(async ({before, after, ignore, beforeCrop}) => {
    const decode = async (encoded, crop) => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + encoded)).blob());
      const canvas = new OffscreenCanvas(crop?.width || bitmap.width, crop?.height || bitmap.height), ctx = canvas.getContext('2d');
      if (crop) ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      else ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    const a = await decode(before, beforeCrop), b = await decode(after);
    if (a.width !== b.width || a.height !== b.height) return {sizeMismatch: [a.width, a.height, b.width, b.height]};
    let changed = 0, changedOutside = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if ([0, 1, 2, 3].some(offset => a.data[i + offset] !== b.data[i + offset])) {
        changed++;
        // At fractional rendering scales one physical pixel can straddle a CSS
        // selection edge. Count only pixels wholly outside that selected area.
        if (!ignore || x + 1 <= ignore.x || y + 1 <= ignore.y || x >= ignore.x + ignore.width || y >= ignore.y + ignore.height) changedOutside++;
      }
    }
    return {width: a.width, height: a.height, changed, changedOutside};
  }, {before: before.toString('base64'), after: after.toString('base64'), ignore, beforeCrop});
}

try {
  await waitUntil(() => worker.evaluate(() => typeof fixtureMenu === 'function'), 'Background menus did not initialize');
  source = Buffer.from(await inspector.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 480;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff2d7'; ctx.fillRect(0, 0, 700, 480);
    ctx.fillStyle = '#173851'; ctx.fillRect(0, 0, 700, 12); ctx.fillRect(0, 468, 700, 12);
    ctx.fillStyle = '#cf7153'; ctx.fillRect(48, 58, 430, 250);
    ctx.fillStyle = '#f9f5d2'; ctx.fillRect(75, 75, 390, 210);
    ctx.fillStyle = '#20364a'; ctx.font = '32px sans-serif'; ctx.fillText('HELLO, REGION!', 105, 150);
    ctx.font = '22px sans-serif'; ctx.fillText('Outside must stay original', 48, 414);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  nextSource = Buffer.from(await inspector.evaluate(async encoded => {
    const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + encoded)).blob());
    ctx.drawImage(image, 0, 0); image.close();
    ctx.fillStyle = '#bd4564'; ctx.fillRect(80, 100, 320, 180);
    return canvas.toDataURL('image/png').split(',')[1];
  }, source.toString('base64')), 'base64');
  output = Buffer.from(await inspector.evaluate(async () => {
    const canvas = new OffscreenCanvas(128, 80), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#18654c'; ctx.fillRect(0, 0, 128, 80); ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText('译文', 18, 48);
    return [...new Uint8Array(await (await canvas.convertToBlob({type: 'image/webp', quality: 1})).arrayBuffer())];
  }));
  await worker.evaluate(async api => {
    await chrome.storage.local.set({'nc-reader-settings': {apiBase: api, autoTranslateTabs: false, language: 'zh-Hans', uiLanguage: 'zh-CN', requestConcurrency: 2},
      'nc-auth': {session: {id: 'fixture-region-session', token: 'isolated-fixture', expiresAt: Date.now() + 3600000, refreshAt: Date.now() + 3500000,
        credential: {kind: 'development'}, user: {id: 'fixture-reader', name: 'Fixture', role: 'reader'}, apiOrigin: api}}});
  }, api);
  await page.goto(site);
  await page.locator('#comic').evaluate(image => image.decode());
  assert.equal(await page.locator('#comic').evaluate(image => getComputedStyle(image).transform), 'matrix(1, 0, 0, 1, 0, 0)',
    'the fixture must reproduce the comic image identity transform');
  await page.evaluate(() => {
    window.fixtureInputEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'contextmenu']) document.addEventListener(type, event => {
      window.fixtureInputEvents.push({type, button: event.button, buttons: event.buttons, isTrusted: event.isTrusted});
      if (window.fixtureInputEvents.length > 32) window.fixtureInputEvents.shift();
    }, true);
  });
  const menus = await worker.evaluate(() => fixtureMenus);
  assert(menus.some(menu => menu.id === 'nc-translate-region'), 'region context menu must be registered');
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0);
  check('Region entry is registered and does not capture or inject automatically');

  const selected = {x: 180, y: 230, width: 320, height: 170};
  const originalAttributes = await page.locator('#comic').evaluate(image => ({src: image.getAttribute('src'), content: image.style.content, width: image.width, height: image.height}));
  const originalImage = await page.locator('#comic').screenshot();
  await page.bringToFront();
  // captureVisibleTab can use a different pixel ratio from CDP screenshots even
  // with an emulated DPR. Compare with the actual browser capture, never infer DPR.
  const baselineData = await worker.evaluate(() => fixtureBaselineCapture());
  const originalViewport = Buffer.from(baselineData.slice(baselineData.indexOf(',') + 1), 'base64');
  await new Promise(resolve => setTimeout(resolve, 650)); // Chromium's native 2 captures/second limit.
  const scaleX = originalViewport.readUInt32BE(16) / 1280, scaleY = originalViewport.readUInt32BE(20) / 900;
  const cropPixels = {x: Math.ceil(selected.x * scaleX), y: Math.ceil(selected.y * scaleY),
    width: Math.floor((selected.x + selected.width) * scaleX) - Math.ceil(selected.x * scaleX),
    height: Math.floor((selected.y + selected.height) * scaleY) - Math.ceil(selected.y * scaleY)};
  const expectedRect = {x: cropPixels.x / scaleX, y: cropPixels.y / scaleY, width: cropPixels.width / scaleX, height: cropPixels.height / scaleY};
  await activate();
  await page.locator('[data-nc-region]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0);
  assert.equal(translations.size, 0);
  check('Entering selection and Escape perform no screenshot, upload or translation');

  for (const cancel of ['right-click', 'Escape']) {
    await activate(); await beginDrag(selected);
    assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0, 'dragging must not start capture');
    assert.equal(translations.size, 0); assert.equal(uploads.size, 0);
    if (cancel === 'right-click') {
      await page.mouse.down({button: 'right'});
      await page.locator('[data-nc-region]').waitFor({state: 'detached', timeout: 1000});
      await page.mouse.up({button: 'right'});
    } else await page.keyboard.press('Escape');
    await page.mouse.up({button: 'left'});
    await page.locator('[data-nc-region]').waitFor({state: 'detached'});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0, cancel + ' cancellation must suppress later left-button release');
    assert.equal(translations.size, 0); assert.equal(uploads.size, 0);
    assert.equal((await regionRecords()).length, 0);
    check(`During held drag, ${cancel} cancels with zero screenshot, saved crop, translation or upload`);
  }

  complete = false;
  await activate(); const captureStarted = await select(selected);
  await waitUntil(() => uploads.size === 1, 'Releasing a valid selection did not automatically submit its frozen crop');
  const captureSubmittedMs = performance.now() - captureStarted;
  const [frozen] = await regionRecords(true);
  assert.equal(frozen.submitted, true);
  assert.deepEqual(frozen.rect, expectedRect);
  assert.equal(frozen.width, cropPixels.width);
  assert.equal(frozen.height, cropPixels.height);
  const frozenBytes = Buffer.from(frozen.source);
  const capturedPixels = await pixelComparison(originalViewport, frozenBytes, undefined, cropPixels);
  assert.equal(capturedPixels.changed, 0, JSON.stringify(capturedPixels));
  assert.equal(sha(frozenBytes), frozen.sourceSha256);
  assert.equal(translations.size, 1); assert.equal(uploads.size, 1);
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 1);
  assert.equal(await worker.evaluate(() => fixtureRegionImages.filter(request => request.kind === 'source').length), 0,
    'automatic submission must not wait for an unused original-preview transfer');
  assert.equal(await worker.evaluate(() => fixtureRegionRecordWrites), 2,
    'only capture and frozen input preparation may write the selection record');
  const loading = await shadowBox('data-nc-region-loading', true);
  assert(loading, 'pending translation needs a visible selection frame');
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(loading[key] - expectedRect[key]) < .02, 'pending frame differs from selected area: ' + key);
  assert.equal(loading.pointerEvents, 'none');
  assert(loading.animations.some(animation => animation.playState === 'running'), 'pending frame must show its CSS animation when reduced motion is not requested');
  const pendingAccessibility = (await cdp.send('Accessibility.getFullAXTree')).nodes;
  assert(!pendingAccessibility.some(node => node.role?.value === 'button' && node.name?.value === '确认翻译'), 'automatic mode must not expose an extra confirmation');
  assert(!pendingAccessibility.some(node => node.role?.value === 'region' && node.name?.value === '截图预览'), 'ordinary selections must not open an intermediate screenshot preview');
  const captureMetrics = {...await worker.evaluate(() => ({fullScreenshotBytes: fixtureCaptureBytes, captureDurationsMs: fixtureCaptureDurationsMs})),
    captureToSyntheticInputAcceptedMs: captureSubmittedMs, viewportPixels: {width: originalViewport.readUInt32BE(16), height: originalViewport.readUInt32BE(20)},
    cropPixels: {width: frozen.width, height: frozen.height}, viewportRgbaBytes: originalViewport.readUInt32BE(16) * originalViewport.readUInt32BE(20) * 4,
    cropRgbaBytes: frozen.width * frozen.height * 4};
  await writeFile(path.join(out, 'captured-crop.png'), frozenBytes);
  await page.screenshot({path: path.join(out, 'translating-selection.png')});
  check(`Releasing the selection automatically freezes and submits exactly its native capture pixels at emulated DPR ${deviceScaleFactor}`);
  const sourceReadsBeforePreview = await worker.evaluate(() => fixtureRegionImages.filter(request => request.kind === 'source').length);
  await button('显示预览');
  await waitUntil(() => previewLoaded('截图预览'), 'An explicitly opened original preview did not load');
  assert.equal(await worker.evaluate(() => fixtureRegionImages.filter(request => request.kind === 'source').length), 1);
  await button('关闭预览');
  await button('显示预览');
  await waitUntil(() => previewLoaded('截图预览'), 'The original preview did not reopen');
  const sourceReadsAfterReopen = await worker.evaluate(() => fixtureRegionImages.filter(request => request.kind === 'source').length);
  assert.equal(sourceReadsAfterReopen, 1,
    'reopening a loaded preview must reuse its current selection bytes');
  await button('关闭预览');
  check('Automatic translation performs zero original-preview transfers; explicit preview loads once and reopening reuses it');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await waitUntil(async () => {
    const frame = await shadowBox('data-nc-region-loading', true);
    return frame && frame.animations.every(animation => animation.playState !== 'running');
  }, 'Reduced-motion preference did not stop the pending frame animation');
  await page.screenshot({path: path.join(out, 'translating-reduced-motion.png')});
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await waitUntil(async () => (await shadowBox('data-nc-region-loading', true))?.animations.some(animation => animation.playState === 'running'), 'Pending frame animation did not resume when reduced motion was disabled');
  check('Pending frame stays inside the selection, ignores pointer input and respects reduced-motion preferences');

  const beforePendingMutation = translationTraffic();
  await mutateUnrelatedDom('pending');
  assertBox(await shadowBox('data-nc-region-loading'), expectedRect, 'Unrelated DOM and non-geometric ancestor changes must preserve the pending image placement');
  assert.equal(await previewVisible(), false, 'non-geometric pending mutations must not force preview');
  assert.deepEqual(translationTraffic(), beforePendingMutation);
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 1);
  check('With an identity image transform, unrelated DOM and non-geometric ancestor mutations preserve the pending frame without recapture or resubmission');

  const denied = await worker.evaluate(async ({url, frozen}) => {
    const tab = (await chrome.tabs.query({})).find(entry => entry.url === url);
    return chrome.scripting.executeScript({target: {tabId: tab.id}, func: async record => {
      let credentialsDenied = false;
      try {await chrome.storage.local.get('nc-auth');} catch {credentialsDenied = true;}
      const stale = await chrome.runtime.sendMessage({type: 'NC_REGION_SUBMIT', navigationId: record.navigationId, generation: record.generation + 1, selectionId: record.id});
      return {credentialsDenied, stale};
    }, args: [frozen]});
  }, {url: page.url(), frozen: {...frozen, source: undefined}});
  assert.equal(denied[0].result.credentialsDenied, true);
  assert.equal(denied[0].result.stale.ok, false);
  assert.equal(translations.size, 1);
  assert.equal(uploads.size, 1);
  check('Content scripts cannot read login credentials and stale-generation submissions are rejected');

  complete = true;
  await waitUntil(async () => !!await translatedBox(), 'Translated crop did not appear');
  assert.equal(await shadowBox('data-nc-region-loading'), undefined, 'pending frame must stop after completion');
  assert.equal(translations.size, 1); assert.equal(uploads.size, 1);
  const [requestId, uploaded] = [...uploads.entries()][0];
  assert.equal(sha(uploaded), frozen.sourceSha256);
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 1, 'translating must not recapture the page');
  const selectionRecordWrites = await worker.evaluate(() => fixtureRegionRecordWrites);
  assert.equal(selectionRecordWrites, 2, 'job snapshots must not duplicate the channel job history in the selection database');
  const actualBox = await translatedBox();
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actualBox[key] - expectedRect[key]) < .02, 'translated crop box differs: ' + key);
  assert.deepEqual(await page.locator('#comic').evaluate(image => ({src: image.getAttribute('src'), content: image.style.content, width: image.width, height: image.height})), originalAttributes);
  const translated = await page.locator('#comic').screenshot();
  const renderedScaleX = originalImage.readUInt32BE(16) / 700, renderedScaleY = originalImage.readUInt32BE(20) / 480;
  const outside = await pixelComparison(originalImage, translated, {x: (expectedRect.x - 100) * renderedScaleX, y: (expectedRect.y - 140) * renderedScaleY,
    width: expectedRect.width * renderedScaleX, height: expectedRect.height * renderedScaleY});
  assert(outside.changed > 0, 'translation must visibly change pixels');
  assert.equal(outside.changedOutside, 0, JSON.stringify(outside));
  await page.screenshot({path: path.join(out, 'translated.png')});
  check('Only the frozen crop uploads, only selected pixels change, source attributes and geometry stay untouched');

  const beforeResultMutation = translationTraffic();
  await mutateUnrelatedDom('result');
  assertBox(await translatedBox(), expectedRect, 'Unrelated DOM and non-geometric ancestor changes must preserve the result placement');
  assert.equal(await previewVisible(), false, 'non-geometric result mutations must not force preview');
  const sameSizeLayoutMutationToTwoAnimationFramesMs = await page.evaluate(() => {
    const started = performance.now();
    const spacer = document.createElement('div'); spacer.id = 'fixture-layout-spacer'; spacer.style.height = '27px';
    document.querySelector('#comic').before(spacer);
    document.querySelector('main').style.marginLeft = '124px';
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))));
  });
  const movedRect = {...expectedRect, x: expectedRect.x + 24, y: expectedRect.y + 27};
  assertBox(await translatedBox(), movedRect, 'A same-size image layout displacement must move the selected overlay after frame recheck');
  assert.equal(await previewVisible(), false);
  assert.deepEqual(await page.locator('#comic').evaluate(image => ({src: image.getAttribute('src'), content: image.style.content, width: image.width, height: image.height})), originalAttributes);
  // A 27 CSS-pixel move changes the raster sampling phase at fractional DPR.
  // Compare both layers at the identical new position, not two differently
  // rasterized positions of the untouched original image.
  await button('恢复原图');
  await waitUntil(async () => !await translatedBox(), 'Layout-shift baseline did not hide the translated crop');
  const movedOriginalImage = await page.locator('#comic').screenshot();
  await button('显示译图');
  await waitUntil(async () => !!await translatedBox(), 'Layout-shift comparison did not restore the translated crop');
  assertBox(await translatedBox(), movedRect, 'Toggling the result at the displaced position must preserve placement');
  const movedPixels = await pixelComparison(movedOriginalImage, await page.locator('#comic').screenshot(),
    {x: (expectedRect.x - 100) * renderedScaleX, y: (expectedRect.y - 140) * renderedScaleY,
      width: expectedRect.width * renderedScaleX, height: expectedRect.height * renderedScaleY});
  assert(movedPixels.changed > 0); assert.equal(movedPixels.changedOutside, 0, JSON.stringify(movedPixels));
  await page.screenshot({path: path.join(out, 'image-layout-follow.png')});
  await page.evaluate(() => {document.querySelector('#fixture-layout-spacer').remove(); document.querySelector('main').style.removeProperty('margin-left');});
  await settleLayout();
  assertBox(await translatedBox(), expectedRect, 'Removing the layout displacement must restore the selected overlay position');
  assert.deepEqual(translationTraffic(), beforeResultMutation);
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 1);
  check('Result placement tolerates unrelated DOM and ancestor attributes, follows same-size image layout shifts after rAF, and keeps every outside pixel unchanged');

  await button('恢复原图');
  await waitUntil(async () => !await translatedBox(), 'Restoring source did not hide the crop');
  assert.equal((await pixelComparison(originalImage, await page.locator('#comic').screenshot())).changed, 0);
  await button('显示译图');
  await waitUntil(async () => !!await translatedBox(), 'Restored translation did not appear');
  assert.equal(translations.size, 1); assert.equal(uploads.size, 1); assert.equal(resultRequests.length, 1);
  await page.evaluate(() => scrollTo(0, 65));
  await waitUntil(async () => Math.abs((await translatedBox())?.y - (expectedRect.y - 65)) < 1, 'Image-anchored crop did not follow scrolling');
  await page.screenshot({path: path.join(out, 'image-scroll.png')});
  const beforeReselect = {captures: await worker.evaluate(() => fixtureCaptureCalls), writes: requests.filter(request => request.method === 'PUT').length};
  await button('重新框选');
  await beginDrag({x: 190, y: 250, width: 280, height: 150});
  await page.keyboard.press('Escape');
  await page.mouse.up({button: 'left'});
  await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  await waitUntil(async () => (await regionRecords()).length === 0, 'Closing did not release the frozen local crop');
  assert.equal(translations.has(requestId), true, 'closing the local overlay must not cancel backend work');
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), beforeReselect.captures);
  assert.equal(requests.filter(request => request.method === 'PUT').length, beforeReselect.writes);
  check('Original/result toggles reuse one job/download, stable-image selection follows scroll, and reselect/cancel releases the crop without capturing again or cancelling backend work');

  await page.evaluate(() => scrollTo(0, 450));
  const arbitrary = {x: 180, y: 260, width: 320, height: 170};
  complete = false;
  await activate(); await select(arbitrary);
  await waitUntil(async () => (await regionRecords()).length === 1, 'Arbitrary-content crop was not frozen');
  await waitUntil(() => uploads.size === 2, 'Arbitrary-content crop did not upload');
  const pendingIds = [...translations.keys()];
  const pendingHashes = [...uploads].map(([id, bytes]) => [id, sha(bytes)]);
  const pendingWrites = requests.filter(request => request.method === 'PUT').length;
  await restartWorker();
  complete = true;
  await button('翻译失败 · 重试');
  await waitUntil(async () => !!await translatedBox(), 'Pending translation did not recover after worker restart');
  assert.deepEqual([...translations.keys()], pendingIds);
  assert.deepEqual([...uploads].map(([id, bytes]) => [id, sha(bytes)]), pendingHashes);
  assert.equal(requests.filter(request => request.method === 'PUT').length, pendingWrites, 'recovering an accepted job must not repeat intent or image uploads');
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0);
  await page.evaluate(() => scrollBy(0, 30));
  await waitUntil(async () => !await translatedBox(), 'Unanchored page selection remained at a stale position after scrolling');
  await button('关闭预览');
  await page.evaluate(() => scrollBy(0, 15));
  await mutateUnrelatedDom('preview-dismissed');
  assert.equal(await previewVisible(), false, 'scrolling and unrelated DOM changes must preserve a dismissed fallback preview');
  await button('显示预览');
  await page.screenshot({path: path.join(out, 'scroll-preview-fallback.png')});
  await button('关闭预览');
  await button('关闭');
  await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  check('Worker interruption recovers the same UUID/frozen bytes; a dismissed scroll-fallback preview stays closed across page activity');

  await page.evaluate(() => scrollTo(0, 0));
  const beforeRace = {translations: translations.size, uploads: uploads.size};
  await activate();
  const beforeCaptureReplies = await worker.evaluate(() => fixtureCaptureReplies.length);
  await worker.evaluate(() => {fixtureHoldCapture = true; fixtureCapturePaused = false;});
  await select({x: 190, y: 240, width: 300, height: 150});
  await waitUntil(() => worker.evaluate(() => fixtureCapturePaused), 'Real screenshot did not reach the tab-switch gate');
  await inspector.goto(site + '/other');
  await inspector.bringToFront();
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(entry => entry.url === url);
    await chrome.tabs.update(tab.id, {active: true});
    fixtureHoldCapture = false; fixtureReleaseCapture();
  }, inspector.url());
  await waitUntil(() => worker.evaluate(count => fixtureCaptureReplies.length > count, beforeCaptureReplies), 'Capture did not return a rejected response after the active tab changed');
  await waitUntil(async () => (await regionRecords()).length === 0, 'Tab-switch capture was incorrectly persisted');
  await page.bringToFront();
  await page.screenshot({path: path.join(out, 'tab-switch-rejected.png')});
  assert.equal(translations.size, beforeRace.translations); assert.equal(uploads.size, beforeRace.uploads);
  await button('关闭');
  check('Switching the actual active browser tab while captureVisibleTab resolves rejects the captured frame with no persistence or submission');

  // New selections deliberately use different crop pixels, avoiding cache reuse
  // while proving that invalidation never submits replacement screenshot bytes.
  await new Promise(resolve => setTimeout(resolve, 650));
  complete = false;
  const beforeResize = {uploads: uploads.size, captures: await worker.evaluate(() => fixtureCaptureCalls)};
  await activate(); await select({x: 210, y: 260, width: 280, height: 150});
  await waitUntil(() => uploads.size === beforeResize.uploads + 1, 'Size-change fixture did not upload its selected crop');
  assert(await shadowBox('data-nc-region-loading'), 'size-change fixture must begin with an in-place pending frame');
  const resizeTraffic = translationTraffic();
  await page.locator('#comic').evaluate(image => {image.style.width = '630px'; image.style.height = '432px';});
  await settleLayout();
  assert.equal(await shadowBox('data-nc-region-loading'), undefined, 'a changed image size must not retain the old pending geometry');
  assert.equal(await translatedBox(), undefined);
  complete = true;
  await waitUntil(() => previewVisible('译图预览'), 'Changing image size during translation did not open the completed result in preview');
  assert.equal(await translatedBox(), undefined, 'size-invalidated result must never be composited over changed image geometry');
  assert.deepEqual(await page.locator('#comic').evaluate(image => ({src: image.getAttribute('src'), width: image.width, height: image.height})),
    {src: '/source.png', width: 630, height: 432});
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), beforeResize.captures + 1);
  assert.deepEqual({...translationTraffic(), downloads: resizeTraffic.downloads}, resizeTraffic, 'size invalidation must not create or upload another job');
  assert.equal(resultRequests.length, resizeTraffic.downloads + 1, 'the size-invalidated job should download its result only once');
  await page.screenshot({path: path.join(out, 'image-resize-preview.png')});
  await button('关闭'); await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  await page.locator('#comic').evaluate(image => {image.style.removeProperty('width'); image.style.removeProperty('height');});
  await settleLayout();
  check('An actual image size change during pending translation removes the stale frame and automatically previews the result without recapture or resubmission');

  await new Promise(resolve => setTimeout(resolve, 650));
  const beforeSource = {uploads: uploads.size, captures: await worker.evaluate(() => fixtureCaptureCalls)};
  await activate(); await select({x: 190, y: 285, width: 285, height: 180});
  await waitUntil(() => uploads.size === beforeSource.uploads + 1, 'Source-change fixture did not upload its selected crop');
  await waitUntil(async () => !!await translatedBox(), 'Source-change fixture did not begin with a translated in-place overlay');
  const sourceTraffic = translationTraffic();
  await page.locator('#comic').evaluate(async image => {image.src = '/source-next.png'; await image.decode();});
  await settleLayout();
  await waitUntil(() => previewVisible('译图预览'), 'Changing the image source did not automatically open the translated preview');
  assert.equal(await translatedBox(), undefined, 'source-invalidated result must not cover a different image');
  assert.deepEqual(await page.locator('#comic').evaluate(image => ({src: image.getAttribute('src'), width: image.width, height: image.height,
    naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight})),
    {src: '/source-next.png', width: 700, height: 480, naturalWidth: 700, naturalHeight: 480});
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), beforeSource.captures + 1);
  assert.deepEqual(translationTraffic(), sourceTraffic, 'source invalidation must not create, upload or download another job');
  await page.screenshot({path: path.join(out, 'image-source-preview.png')});
  await button('关闭'); await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  check('A same-size but different image source removes the old in-place result and automatically previews it without altering or translating the replacement source');

  await new Promise(resolve => setTimeout(resolve, 650));
  const beforeCssSource = {uploads: uploads.size, captures: await worker.evaluate(() => fixtureCaptureCalls)};
  await activate(); await select({x: 205, y: 260, width: 290, height: 160});
  await waitUntil(() => uploads.size === beforeCssSource.uploads + 1, 'CSS-source fixture did not upload its selected crop');
  await waitUntil(async () => !!await translatedBox(), 'CSS-source fixture did not begin with an in-place result');
  const cssSourceTraffic = translationTraffic();
  const cssSourceIdentity = await page.locator('#comic').evaluate(image => ({src: image.currentSrc, width: image.width, height: image.height}));
  await page.locator('#comic').evaluate(image => {image.style.content = 'url("/source.png")';});
  await settleLayout();
  await waitUntil(() => previewVisible('译图预览'), 'CSS content replacement did not invalidate the old translated overlay');
  assert.equal(await translatedBox(), undefined, 'a CSS replacement must not retain the previous image overlay');
  assert.deepEqual(await page.locator('#comic').evaluate(image => ({src: image.currentSrc, width: image.width, height: image.height})), cssSourceIdentity,
    'this fixture must change visible image content without changing HTML source identity or geometry');
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), beforeCssSource.captures + 1);
  assert.deepEqual(translationTraffic(), cssSourceTraffic, 'CSS replacement invalidation must not create, upload or download another job');
  await page.screenshot({path: path.join(out, 'image-css-content-preview.png')});
  await button('关闭'); await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  check('CSS content replacement with unchanged HTML source and geometry invalidates the old overlay without starting more work');

  // Exercise the real local-channel cache-miss path, not an injected error code.
  // Headless Chromium keeps page documents visible across tab activation, so
  // emulate visibility only in this isolated content-script world. The real
  // zero-budget host closes before the worker/foreground result read resumes.
  await page.locator('#comic').evaluate(image => {image.style.removeProperty('content');});
  await worker.evaluate(async base => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('node-comics-reading-v2-translation-channel-credentials', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('credentials', {keyPath: 'id'});
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('credentials', 'readwrite');
        tx.objectStore('credentials').put({id: 'region-mtu', values: {token: 'isolated-region-mtu-token'}});
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally {db.close();}
    const saved = await chrome.storage.local.get('nc-reader-settings');
    await chrome.storage.local.set({
      'nc-reader-settings': {...saved['nc-reader-settings'], cacheLimitMb: 0},
      'nc-translation-channels': {activeId: 'region-mtu', profiles: [{id: 'region-mtu', name: 'Region fixture',
        adapterId: 'manga-translator-ui', revision: 1, settings: {baseUrl: base + '/', username: 'fixture'}}]},
    });
  }, api);
  await activate(); await select({x: 195, y: 270, width: 295, height: 165});
  await waitUntil(() => mtuInputs.length === 1, 'The selected crop did not reach the synthetic MTU service');
  const host = browser.pages().find(entry => entry.url().includes('/translation-host.html'));
  assert(host, 'MTU must use the existing extension execution host');
  const setSourceVisibility = async hidden => worker.evaluate(async ({url, hidden}) => {
    const tab = (await chrome.tabs.query({})).find(entry => entry.url === url);
    await chrome.scripting.executeScript({target: {tabId: tab.id}, func: hidden => {
      if (hidden) Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
      else delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    }, args: [hidden]});
  }, {url: page.url(), hidden});
  await setSourceVisibility(true);
  holdMtuResponse = false; releaseMtuResponse();
  await waitUntil(() => host.isClosed(), 'The completed zero-cache-budget host did not close', 20000);
  await restartWorker();
  await setSourceVisibility(false);
  await button(/ · 重新翻译$/, false);
  assert.equal(mtuInputs.length, 1, 'cache loss must not automatically repeat MTU HTTP translation');
  assert.equal(await translatedBox(), undefined);
  await mutateUnrelatedDom('mtu-missing-result');
  assert.equal(mtuInputs.length, 1);
  await page.screenshot({path: path.join(out, 'mtu-explicit-retranslate.png')});
  await button(/ · 重新翻译$/);
  await waitUntil(() => mtuInputs.length === 2, 'The explicit retranslate control did not start a new MTU request');
  await waitUntil(async () => !!await translatedBox(), 'Explicit MTU retranslation did not restore the selected overlay');
  assert.deepEqual(mtuInputs[1], mtuInputs[0], 'explicit retranslation must use the same frozen crop bytes');
  assert.equal(await worker.evaluate(() => fixtureCaptureCalls), 0, 'cache recovery must never recapture the page');
  await button('关闭'); await page.locator('[data-nc-region]').waitFor({state: 'detached'});
  check('Real MTU cache loss after host/worker restart waits for explicit retranslation and reuses the same frozen input without recapture');

  assert.equal(await worker.evaluate(() => fixturePermissionRequests), 0);
  assert.deepEqual(await worker.evaluate(() => fixtureExternalRequests), []);
  assert.deepEqual(externalPageRequests, []);
  assert.equal(requests.filter(request => /translation-plans|reading-sessions|translation-operations|\/v1\/uploads/.test(request.path)).length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, errors, deviceScaleFactor, extensionId,
    translations: translations.size, uploads: [...uploads].map(([id, bytes]) => ({id, bytes: bytes.length, sha256: sha(bytes)})),
    resultDownloads: resultRequests.length, translationWrites: requests.filter(request => request.method === 'PUT').length,
    captureMetrics: {...captureMetrics, cropBytes: frozenBytes.length},
    selectionWork: {sourceReadsBeforePreview, sourceReadsAfterReopen, selectionRecordWrites,
      boundary: 'first selection: two input commits only; job snapshots remain in channel storage'},
    interactionMetrics: {sameSizeLayoutMutationToTwoAnimationFramesMs, timingBoundary: 'synthetic layout mutation to two rAF callbacks; geometry asserted afterward, not precise render latency'}, externalPageRequests,
    mtuInputs, mtuVisibilityEmulated: true, liveProvider: false, liveSource: false, temporaryCapturePermission, nativeActionGesture: false, nativeContextMenuDialog: false}, null, 2));
  console.log('Artifacts: ' + out);
} catch (error) {
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({error: error.stack, checks, errors, requests, resultRequests, mtuInputs,
    background: await worker.evaluate(() => ({captureCalls: fixtureCaptureCalls, captureReplies: fixtureCaptureReplies,
      regionImages: fixtureRegionImages, regionRecordWrites: fixtureRegionRecordWrites,
      nativeCaptureError: globalThis.fixtureNativeCaptureError, externalRequests: fixtureExternalRequests})).catch(() => undefined),
    inputEvents: await page.evaluate(() => window.fixtureInputEvents).catch(() => undefined),
    frozen: await regionRecords().catch(() => undefined),
    accessibility: await cdp.send('Accessibility.getFullAXTree').then(tree => tree.nodes.filter(node => ['button', 'status', 'StaticText'].includes(node.role?.value)).map(node => ({role: node.role?.value, name: node.name?.value, description: node.description?.value}))).catch(() => [])}, null, 2));
  await page.screenshot({path: path.join(out, 'failure.png'), timeout: 5000}).catch(() => {});
  console.error('Artifacts: ' + out); throw error;
} finally {
  releaseMtuResponse?.();
  await worker.evaluate(() => globalThis.fixtureReleaseCapture?.()).catch(() => {});
  await browser.close();
  for (const stream of streams) stream.end();
  await new Promise(resolve => apiServer.close(resolve));
  await new Promise(resolve => siteServer.close(resolve));
}
