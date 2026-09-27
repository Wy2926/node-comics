// Isolated MV3 profile, fixture by default; RUN_LIVE_WEBTOONS=1 exercises real public pages.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_WEBTOONS === '1';
const liveTitle = process.env.WEBTOONS_TITLE || 'Not So Silent';
const base = path.join(root, 'artifacts/webtoons/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {search} from '${source}/sources/sites/webtoons/search.ts';
export {createPage} from '${source}/sources/sites/webtoons/page.ts';
export {definition} from '${source}/sources/sites/webtoons/definition.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: {probe, fixtures: path.join(source, 'sources/sites/webtoons/tests/fixtures.ts')}, formats: ['es'], fileName: (_f, name) => name + '.mjs'}}});
const fixture = await import(pathToFileURL(path.join(extension, 'fixtures.mjs')).href);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
if (live) {
  const describe = request => {const u = new URL(request.url()); return u.hostname === 'www.webtoons.com' ? u.pathname + (u.searchParams.has('page') ? '?page=' + u.searchParams.get('page') : '') : undefined;};
  context.on('request', request => {const url = describe(request); if (url) console.log('request', url);});
  context.on('requestfinished', request => {const url = describe(request); if (url) console.log('finished', url);});
  context.on('requestfailed', request => {const url = describe(request); if (url) console.log('failed', url, request.failure()?.errorText);});
}
const errors = [], checks = []; let reader, imageBytes, failCatalog = false, addChapter = false, activeEntry;
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
// Block product API calls in the isolated reader without intercepting source traffic.
await context.addInitScript(() => {
  const request = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href);
    return url.hostname.endsWith('.nodelane.net') ? Promise.resolve(new Response('{}', {status: 503})) : request(input, options);
  };
});
if (!live) {
  await context.route('https://webtoon-phinf.pstatic.net/**', route => route.fulfill({contentType: 'image/png', body: imageBytes}));
  await context.route('https://www.webtoons.com/**', route => {
    const url = new URL(route.request().url()); let html;
    if (url.pathname.includes('/search/')) html = fixture.searchHtml(url.pathname.split('/').at(-1), url.searchParams.get('keyword'));
    else if (url.pathname.endsWith('/viewer')) html = fixture.readerHtml(Number(url.searchParams.get('episode_no')));
    else if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
    else {const page = Number(url.searchParams.get('page')) || 1; html = fixture.catalogHtml(page, page === 1 ? (addChapter ? [4, 3, 2] : [3, 2]) : [1]);}
    return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' + html});
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000})};});
const waitImage = (page = 1) => reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
  {entry: activeEntry, page}, {timeout: 90000});
const refresh = () => reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('probe.mjs')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  if (!live) imageBytes = Buffer.from(await reader.evaluate(() => {const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#25638a'; ctx.fillRect(0, 0, 800, 1200); ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText('WEBTOON fixture', 100, 300); return c.toDataURL().split(',')[1];}), 'base64');
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('WEBTOON · English'));
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? liveTitle : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? liveTitle : 'WEBTOON fixture', exact: true})});
  await hit.waitFor({timeout: 60000}); await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 120000});
  const imported = await state(); assert.equal(imported.comics.length, 1); activeEntry = imported.entries.find(e => e.indexState === 'ready')?.id; assert(activeEntry);
  const active = imported.entries.find(e => e.id === activeEntry);
  await waitImage(); await reader.getByLabel('跳转页码', {exact: true}).fill('3'); await waitImage(3);
  await reader.waitForFunction(async entry => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs')), e = await catalog.get('entries', entry);
    return (await catalog.get('positions', entry))?.pageId === (await catalog.listPages(e.contentId))[2]?.pageId;}, activeEntry);
  await reader.screenshot({path: path.join(out, 'reader.png')}); checks.push('Search -> full catalog -> real image decode -> page 3');
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const directory = reader.getByRole('tab', {name: /^目录/}); if (await directory.isVisible()) await directory.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor(); await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click(); await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  await reader.locator('.nc-book .nc-thumbnail img').evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: '继续阅读', exact: true}).click(); await waitImage(3);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3'); assert.equal(await refresh(), imported.entries.length);
  checks.push('Cover decode, reopen and refresh preserve page 3');
  if (!live) {failCatalog = true; const before = await state(); await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; addChapter = true; assert.equal(await refresh(), imported.entries.length + 1); await refresh();
    assert.equal((await state()).comics[0].catalogUpdates.count, 1); checks.push('Failed refresh preserves old entries; new chapter counts once');}
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(active.sourceUrl); await reader.getByRole('button', {name: '添加到书架', exact: true}).click(); await waitImage(3);
  assert.equal((await state()).comics.length, 1); checks.push('Chapter import deduplicates and restores position');
  const site = await context.newPage(); await site.goto(active.sourceUrl, {waitUntil: 'domcontentloaded'});
  await site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor({timeout: 60000});
  await site.screenshot({path: path.join(out, 'source-entry.png')}); await site.close(); checks.push('Source page import button mounted');
  assert.deepEqual(errors, []); await writeFile(path.join(out, 'result.json'), JSON.stringify({live, checks, entries: imported.entries.length}, null, 2)); console.log(JSON.stringify({out, checks}));
} catch (error) {if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2000));}
  console.log(JSON.stringify({out, checks, errors})); throw error;
} finally {await context.close();}
