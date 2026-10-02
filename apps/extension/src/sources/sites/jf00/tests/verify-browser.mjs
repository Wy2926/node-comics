// Public source HTTP in a fresh MV3 profile. Requires the current extension build; no model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/jf00/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const extension = path.join(out, 'extension'); await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert(manifest.host_permissions.includes('https://*/*') && manifest.host_permissions.includes('http://*/*'));
assert(!Object.hasOwn(manifest, 'optional_host_permissions'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const checks = [], errors = [];
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
let reader;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  const setup = await context.newPage(); await setup.goto(home);
  await setup.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window'};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});});
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: '漫画猫 (00jf)', exact: true}).waitFor();
  const site = await context.newPage(); await site.goto('https://www.00jf.com/chapter_13871_4992.html', {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await button.waitFor();
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = context.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  const details = await reader.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(c => c.source.connectionId === 'website:jf00');
    const entries = await catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.sourceEntryId === 'jf00:13871:chapter:4992');
    return {comicId: comic.id, entryId: entry.id, chapters: entries.length, total: entry.pageCount};
  });
  assert(details.chapters >= 800 && details.total === 18);
  for (let number = 1; number <= details.total; number++) {
    await reader.getByLabel('跳转页码', {exact: true}).fill(String(number), {force: true});
    await reader.waitForFunction(index => document.querySelector(`[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth > 0, number - 1, {timeout: 60000});
  }
  checks.push('Live chapter embedded entry imports the 800-entry catalog and decodes all 18 pages');
  await reader.getByLabel('跳转页码', {exact: true}).fill('10', {force: true});
  await reader.waitForFunction(async id => {const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', id), pages = await catalog.listPages(entry.contentId), position = await catalog.get('positions', id);
    return position?.pageId === pages[9]?.pageId;}, details.entryId);
  await reader.screenshot({path: path.join(out, 'reader-10.png')});
  const route = reader.url(); await reader.close(); reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 一人之下', exact: true}).click();
  await reader.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '10');
  await reader.screenshot({path: path.join(out, 'reopened-10.png')}); checks.push('Reader reopen restores exact page 10');
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`); await cover.waitFor(); await cover.evaluate(i => i.decode());
  assert(await cover.evaluate(i => i.naturalWidth > 0)); await setup.screenshot({path: path.join(out, 'cover.png')});
  checks.push('Shelf decodes the dedicated work cover');
  await site.close();
  const count = context.pages().length;
  const refreshed = await reader.evaluate(async id => {const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;}, details.comicId);
  assert(refreshed >= 800 && context.pages().length === count); checks.push('Full catalog refresh with source tab closed creates no source tabs');
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByLabel('通过链接添加漫画').fill('https://www.00jf.com/comic_13871.html');
  await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  assert.equal(await setup.getByLabel('跳转页码', {exact: true}).inputValue(), '10');
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push('Catalog link reimport preserves one comic and existing page 10'); assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, errors, models: false}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-1500));}
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await context.close();}
