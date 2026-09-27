// Built MV3, isolated profile. RUN_LIVE_BAOZIMH=1 uses public source pages/images.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_BAOZIMH === '1';
const base = path.join(root, 'artifacts/baozimh/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: {probe, fixtures: path.join(source, 'sources/sites/baozimh/tests/fixtures.ts')}, formats: ['es'], fileName: (_format, name) => name + '.mjs'}}});
const fixture = await import(pathToFileURL(path.join(extension, 'fixtures.mjs')).href);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const errors = [], checks = []; let reader, activeEntry, imageBytes, failCatalog = false, failSearch = false, count = 27;
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
if (!live) {
  for (const pattern of ['https://*.bzcdn.net/**', 'https://static-tw.baozimh.com/**'])
    await context.route(pattern, route => route.fulfill({contentType: 'image/png', body: imageBytes}));
  await context.route('https://cn.baozimh.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/search') return route.fulfill({status: failSearch ? 403 : 200, contentType: 'text/html', body: failSearch ? 'Verification required' : fixture.searchHtml(url.searchParams.get('q'))});
    return route.fulfill({status: failCatalog ? 503 : 200, contentType: 'text/html', body: fixture.catalogHtml(count)});
  });
  await context.route('https://cn.twbzmg.com/**', route => {
    const match = /0_(\d+)(?:_(\d+))?\.html$/.exec(new URL(route.request().url()).pathname); assert(match);
    return route.fulfill({contentType: 'text/html', body: fixture.readerHtml(Number(match[2] ?? 1), 2, match[1])});
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000})};});
const waitImage = (page = 1) => reader.waitForFunction(({entry, page}) =>
  document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
  {entry: activeEntry, page}, {timeout: 60000});
async function refresh() {return reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('probe.mjs')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  if (live) {
    const site = await context.newPage(); await site.goto('https://cn.baozimh.com/', {waitUntil: 'domcontentloaded'});
    await site.getByRole('link', {name: '分类', exact: true}).waitFor(); await site.close();
    checks.push('Normal source navigation establishes verification session; source tab then closed');
  } else {
    const base64 = await reader.evaluate(async () => {const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
      const g = c.getContext('2d'); g.fillStyle = '#ffb84d'; g.fillRect(0, 0, 800, 1200); g.fillStyle = '#123456'; g.font = '48px sans-serif'; g.fillText('Bao fixture', 100, 250);
      return c.toDataURL().split(',')[1];}); imageBytes = Buffer.from(base64, 'base64');
  }
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('包子漫画'));
  const input = search.getByPlaceholder('输入漫画名称或别名');
  if (!live) {
    failSearch = true; await input.fill('blocked'); await input.press('Enter');
    await search.locator('.nc-search-status.is-error').click();
    await search.locator('.nc-search-status-detail').getByText(/验证/).waitFor();
    checks.push('403 search shows source verification error'); failSearch = false;
  }
  if (live) {
    await input.fill('斗破'); await input.press('Enter');
    await search.getByRole('heading', {name: '斗破苍穹', exact: true}).waitFor({timeout: 60000});
    await search.locator('.nc-search-status').click(); await search.getByRole('button', {name: '加载更多', exact: true}).click();
    await reader.waitForFunction(() => document.querySelectorAll('.nc-search-result').length > 50);
    await search.getByRole('heading', {name: '斗破苍穹', exact: true}).scrollIntoViewIfNeeded();
    await reader.screenshot({path: path.join(out, 'doupo-search.png')});
    checks.push('斗破 search renders real candidates and loads the next result page despite unavailable covers');
  }
  await input.fill(live ? '芙莉莲' : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? '葬送者芙莉莲' : 'Bao fixture & work', exact: true})});
  await hit.waitFor({timeout: 60000}); await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  const imported = await state(); assert.equal(imported.comics.length, 1); assert(imported.entries.length >= (live ? 100 : 27));
  const active = imported.entries.find(e => e.indexState === 'ready'); assert(active); activeEntry = active.id; await waitImage();
  await reader.getByLabel('跳转页码', {exact: true}).fill('3'); await waitImage(3);
  await reader.waitForFunction(async entry => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs')); const row = await catalog.get('entries', entry);
    const pages = await catalog.listPages(row.contentId), position = await catalog.get('positions', entry); return position?.pageId === pages[2]?.pageId;}, activeEntry);
  await reader.screenshot({path: path.join(out, 'reader.png')}); checks.push('Search -> complete hidden catalog -> full HTTP pages -> page 3 without source tab');
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const tab = reader.getByRole('tab', {name: /^目录/}); if (await tab.isVisible()) await tab.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor(); await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
  await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  await reader.locator('.nc-book .nc-thumbnail img').evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: '继续阅读', exact: true}).click(); await waitImage(3);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3'); assert.equal(await refresh(), imported.entries.length);
  checks.push('Cover, reopen and complete refresh preserve page 3');
  if (!live) {
    const before = await state(); failCatalog = true; await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; count++; await refresh(); await refresh(); assert.equal((await state()).comics[0].catalogUpdates.count, 1);
    checks.push('Failed refresh retains catalog; repeated refresh counts new chapters once');
  }
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  const chapter = /\/chapter\/([^/]+)\/(\d+)_(\d+)\.html$/.exec(new URL(active.sourceUrl).pathname); assert(chapter);
  const reimport = live ? 'https://cn.baozimh.com/user/page_direct?' + new URLSearchParams({comic_id: chapter[1], section_slot: chapter[2], chapter_slot: chapter[3]}) : active.sourceUrl.replace('.html', '_2.html');
  await reader.getByLabel('通过链接添加漫画').fill(reimport); await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  await waitImage(3); assert.equal((await state()).comics.length, 1); checks.push('Source chapter entry or continuation imports same work/chapter and restores reading position');
  const site = await context.newPage(); await site.goto(active.sourceUrl, {waitUntil: 'domcontentloaded'});
  await site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor({timeout: 60000});
  await site.screenshot({path: path.join(out, 'source-entry.png')}); await site.close();
  assert.deepEqual(errors, []); checks.push('Reader source embeds import/manage action');
  if (live) {
    const volume = imported.entries.find(entry => entry.title === '第01卷'); assert(volume);
    await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
    await reader.getByLabel('通过链接添加漫画').fill(volume.sourceUrl.replace('.html', '_2.html'));
    await reader.getByRole('button', {name: '添加到书架', exact: true}).click(); activeEntry = volume.id; await waitImage();
    await reader.getByLabel('跳转页码', {exact: true}).fill('55'); await waitImage(55);
    const pageCount = await reader.evaluate(async entry => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
      const row = await catalog.get('entries', entry); return (await catalog.listPages(row.contentId, {limit: 1500})).length;}, volume.id);
    assert(pageCount > 100); assert.equal((await state()).comics.length, 1);
    await reader.screenshot({path: path.join(out, 'volume-continuation.png')});
    checks.push('Real volume continuation imports its existing chapter and reads page 55 of all three source parts');
  }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', live, entries: imported.entries.length, checks, errors, models: false}, null, 2));
  console.log(JSON.stringify({out, live, checks}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', live, checks, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2500));}
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await context.close();}
