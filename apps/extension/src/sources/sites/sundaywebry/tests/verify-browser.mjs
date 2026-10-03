// Production MV3 in an isolated Chromium profile. RUN_LIVE_WEBRY=1 reads the public website.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_WEBRY === '1';
const base = path.join(root, 'artifacts/sunday-webry/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {image} from '${source}/sources/sites/sundaywebry/image.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: {probe, fixtures: path.join(source, 'sources/sites/sundaywebry/tests/fixtures.ts')},
    formats: ['es'], fileName: (_format, name) => name + '.mjs'},
}});
const fixture = await import(pathToFileURL(path.join(extension, 'fixtures.mjs')).href);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const errors = [], checks = [];
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
let failCatalog = false, addChapter = false, imageBytes, reader, activeEntry;
const rows = () => [fixture.entry('11'), fixture.entry('12', false), fixture.entry('13'), ...(addChapter ? [fixture.entry('14')] : [])];
if (!live) {
  await context.route('https://cdn-img.www.sunday-webry.com/**', route => route.fulfill({contentType: 'image/png', body: imageBytes}));
  await context.route('https://www.sunday-webry.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/search') return route.fulfill({status: url.searchParams.get('q') === 'missing' ? 404 : 200,
      contentType: 'text/html', body: fixture.searchHtml(url.searchParams.get('q'), url.searchParams.get('q') === 'missing' ? [] : ['7']).replace('作品 7', 'Webry fixture')});
    if (url.pathname.startsWith('/episode/')) {
      const data = fixture.readerData(url.pathname.split('/')[2]);
      data.readableProduct.series.title = 'Webry fixture';
      data.readableProduct.pageStructure.pages = [0, 1, 2].map(() => ({type: 'main', src: fixture.imageUrl, width: 803, height: 1207}));
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' + fixture.readerHtml(data)});
    }
    if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
    if (url.pathname.endsWith('/readable_product_pagination_information'))
      return route.fulfill({json: {...fixture.info, readable_products_count: rows().length}});
    if (url.pathname.endsWith('/pagination_readable_products')) {
      const offset = Number(url.searchParams.get('offset'));
      return route.fulfill({json: rows().slice(offset, offset + Number(url.searchParams.get('limit')))});
    }
    return route.abort();
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000}), positions: await catalog.list('positions')};});
async function waitImage(page = 1) {await reader.waitForFunction(({entry, page}) =>
  document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
  {entry: activeEntry, page}, {timeout: 60000});}
async function jump(page) {
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(page)); await waitImage(page);
  await reader.waitForFunction(async ({entry, page}) => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
    const data = await catalog.get('entries', entry), pages = await catalog.listPages(data.contentId), position = await catalog.get('positions', entry);
    return position?.pageId === pages[page - 1]?.pageId;}, {entry: activeEntry, page});
}
async function refresh() {return reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('probe.mjs')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  if (!live) {
    const result = await reader.evaluate(async () => {
      const {image} = await import(chrome.runtime.getURL('probe.mjs'));
      const canvas = document.createElement('canvas'); canvas.width = 803; canvas.height = 1207; const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const w = Math.floor(canvas.width / 32) * 8, h = Math.floor(canvas.height / 32) * 8;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {ctx.fillStyle = `rgb(${x * 60},${y * 60},${(x * 4 + y) * 15})`; ctx.fillRect(x * w, y * h, w, h);}
      const original = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const encoded = await image.decode(blob, new Headers(), 'webry-baku:803:1207');
      const decoded = await image.decode(encoded, new Headers(), 'webry-baku:803:1207'), bitmap = await createImageBitmap(decoded);
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const restored = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const exact = original.every((value, index) => value === restored[index]);
      const bytes = new Uint8Array(await encoded.arrayBuffer()); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      return {exact, data: btoa(binary)};
    });
    assert(result.exact); imageBytes = Buffer.from(result.data, 'base64'); checks.push('Lossless baku round-trip includes remainder strips');
  }
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('サンデーうぇぶり'));
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? 'フリーレン' : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? '葬送のフリーレン' : 'Webry fixture', exact: true})});
  await hit.waitFor({timeout: 60000}); await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  const imported = await state(); assert.equal(imported.comics.length, 1);
  const active = imported.entries.find(e => e.indexState === 'ready'); assert(active); activeEntry = active.id;
  await waitImage(); await jump(3); await reader.screenshot({path: path.join(out, 'reader.png')});
  assert(imported.entries.length >= (live ? 100 : 3));
  checks.push('Search -> full paginated catalog -> decoded images -> page 3 without a source tab');
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const directoryTab = reader.getByRole('tab', {name: /^目录/}); if (await directoryTab.isVisible()) await directoryTab.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor();
  await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
  await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = reader.locator('.nc-book .nc-thumbnail img'); await cover.waitFor(); await cover.evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.locator('.nc-book-cover').click(); await waitImage(3);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
  assert.equal(await refresh(), imported.entries.length);
  checks.push('Cover loads; reopening and complete refresh retain page 3');
  if (!live) {
    failCatalog = true; const before = await state(); await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; addChapter = true; assert.equal(await refresh(), imported.entries.length + 1); await refresh();
    assert.equal((await state()).comics[0].catalogUpdates.count, 1);
    checks.push('Failed refresh keeps previous catalog; duplicate refresh counts new chapter once');
  }
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
  await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(active.sourceUrl.split('#')[0]);
  await reader.getByRole('button', {name: '添加到书架', exact: true}).click(); await waitImage(3);
  assert.equal((await state()).comics.length, 1); checks.push('Bare chapter reimport resolves ownership, deduplicates work and restores reading position');
  const site = await context.newPage(); await site.goto(active.sourceUrl.split('#')[0], {waitUntil: 'domcontentloaded'});
  await site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor({timeout: 60000});
  await site.screenshot({path: path.join(out, 'source-entry.png')}); await site.close();
  assert.deepEqual(errors, []); checks.push('Source episode displays the installed import/manage button');
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', live, entries: imported.entries.length, checks, errors, models: false}, null, 2));
  console.log(JSON.stringify({out, live, checks}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', live, checks, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2500));}
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await context.close();}
