// Built MV3, isolated profile. Default is synthetic; RUN_LIVE_COMICPASH=1 reads public source data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_COMICPASH === '1';
const output = path.join(root, 'artifacts/comicpash-validation'); await mkdir(output, {recursive: true});
const out = await mkdtemp(path.join(output, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://comicpash.jp/*', 'https://viewer.comicpash.jp/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';export {readNetworkPages} from '${source}/sources/runtime/network.ts';export {readSourceImage} from '${source}/sources/runtime/source-image.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, viewport: {width: 1440, height: 1000},
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const checks = [], errors = [], created = [];
context.on('page', page => {created.push(page);page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);});});
const series = live ? '1fafeeae328df' : 'fixture', episode = live ? '17f11c20955a2' : 'first';
const base = 'https://comicpash.jp/series/' + series, viewer = 'a598aba404a952d2822908e7d58a8aa0';
let reader, failImages = false, failCatalog = false, scrambled;
await context.route('https://*.nodelane.net/**', route => route.fulfill({status: 503, body: 'Isolated acceptance'}));
if (!live) await context.route('https://**/*', route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'viewer.comicpash.jp') return route.fulfill({status: failImages ? 503 : 200, contentType: 'image/png', body: scrambled});
  if (url.hostname !== 'comicpash.jp') return route.abort();
  if (url.pathname.startsWith('/series/')) return route.fulfill({status: failCatalog ? 503 : 200, contentType: 'text/html', body:
    `<link rel="canonical" href="${base}"><meta property="og:title" content="Comic PASH fixture"><div class="series-act"></div>
    <a class="series-sort-link" href="${base}/1">1-2</a>${['first','second'].map(id => `<a class="series-eplist-item-link" href="/episodes/${id}"><span class="series-eplist-item-h-text">${id}</span></a>`).join('')}`});
  if (url.pathname.startsWith('/episodes/')) return route.fulfill({contentType: 'text/html', body:
    `<link rel="canonical" href="https://comicpash.jp${url.pathname}"><meta property="og:title" content="Fixture chapter"><div id="comici-viewer" data-api-domain="/api" data-series-id="fixture" data-comici-viewer-id="${viewer}"></div>`});
  if (url.pathname === '/api/book/contentsInfo') return route.fulfill({json: {totalPages: 3, scrollDirection: '横',
    result: Array.from({length: Number(url.searchParams.get('page-to')) + 1}, (_, sort) => ({sort, width: 720, height: 1024,
      scramble: JSON.stringify(Array.from({length: 16}, (_, i) => 15 - i)), imageUrl: `https://viewer.comicpash.jp/book/${viewer}/${sort}.png`}))}});
  return route.abort();
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href, setup = await context.newPage(); await setup.goto(home);
  await setup.evaluate(() => {localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN', layout: 'single'}));});
  await worker.evaluate(() => chrome.storage.local.set({'nc-reader-settings': {uiLanguage: 'zh-CN', autoTranslateTabs: false}}));
  if (!live) {
    const data = await setup.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 720;c.height = 1024;const ctx = c.getContext('2d');
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {const n = 15 - (x * 4 + y);ctx.fillStyle = `rgb(${n * 12},${255 - n * 12},100)`;ctx.fillRect(x * 180, y * 256, 180, 256);}
      return c.toDataURL();
    });
    scrambled = Buffer.from(data.split(',')[1], 'base64');
  }
  const site = await context.newPage();await site.goto(base, {waitUntil: 'domcontentloaded'});
  const entry = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await entry.waitFor();
  // Next's hydration can replace the initial server-rendered action container once.
  for (let attempt = 0; ; attempt++) {
    try {await entry.scrollIntoViewIfNeeded(); break;}
    catch (error) {if (attempt >= 2 || !/not attached/.test(error.message)) throw error;await entry.waitFor();}
  }
  await site.screenshot({path: path.join(out, 'entry.png')});
  const before = created.length, opening = context.waitForEvent('page');await entry.click();reader = await opening;
  await reader.getByLabel('跳转页码').waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  const details = await reader.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics'))[0], entries = await catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.indexState === 'ready');
    return {comicId: comic.id, entryId: entry.id, chapters: entries.length, total: entry.pageCount, complete: entry.discoveryComplete};
  });
  assert(details.complete); assert(details.total > 0); assert.equal(created.length, before + 1);
  await site.close(); checks.push('Embedded button imports a complete catalog and chapter without acquisition tabs');
  for (let n = 1; n <= details.total; n++) {
    await reader.getByLabel('跳转页码').fill(String(n), {force: true});
    await reader.waitForFunction(index => document.querySelector(`[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth > 0, n - 1, {timeout: 60000});
    if (n === 1 || n === details.total) await reader.screenshot({path: path.join(out, `reader-${n}.png`)});
  }
  checks.push(`All ${details.total} pages decode and display with the source tab closed`);
  if (!live) {
    const pixels = await reader.evaluate(async () => {
      const image = document.querySelector('img.nc-page-image'), c = document.createElement('canvas');c.width = image.naturalWidth;c.height = image.naturalHeight;
      const ctx = c.getContext('2d');ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(10, 10, 1, 1).data];
    });
    assert.deepEqual(pixels, [0,255,100,255]);checks.push('Decoded synthetic pixels match the expected original tile');
  }
  const restore = Math.min(details.total, 10); await reader.getByLabel('跳转页码').fill(String(restore), {force: true});
  await reader.waitForFunction(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')), entry = await catalog.get('entries', id), pages = await catalog.listPages(entry.contentId);
    return (await catalog.get('positions', id))?.pageId === pages[index]?.pageId;
  }, {id: details.entryId, index: restore - 1});
  const route = reader.url();await reader.close();failImages = true;reader = await context.newPage();await reader.goto(route);
  await reader.getByRole('button', {name: /继续阅读/}).click();
  await reader.waitForFunction(index => document.querySelector(`[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth > 0, restore - 1);
  await reader.screenshot({path: path.join(out, 'reopened.png')});checks.push('Reopening restores reading position and cached images');
  if (!live) {
    failCatalog = true;
    const failed = await reader.evaluate(async url => {try {await (await import(chrome.runtime.getURL('verify-source.js'))).readSourceCatalog(url);return false;} catch {return true;}}, base);
    assert(failed);failCatalog = false;
  }
  const refreshed = await reader.evaluate(async url => {
    const {readSourceCatalog, catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const refreshed = await readSourceCatalog(url);return {count: refreshed.entries.length, comics: (await catalog.list('comics')).length};
  }, base);
  assert.equal(refreshed.count, details.chapters);assert.equal(refreshed.comics, 1);assert.deepEqual(errors, []);
  checks.push('Catalog refresh succeeds without duplicating the stored comic');
  await writeFile(path.join(out, 'results.json'), JSON.stringify({liveSource: live, liveProvider: false, nativePermissionDialog: false, details, checks, errors}, null, 2));
  console.log(JSON.stringify({out, details, checks}));
} catch (error) {if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});console.error('Artifacts: ' + out);throw error;}
finally {await context.close();}
