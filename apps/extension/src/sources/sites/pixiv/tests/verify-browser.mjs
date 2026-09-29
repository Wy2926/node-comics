// Isolated built MV3 reader. Fixtures by default; opt in to real public Pixiv with RUN_LIVE_PIXIV=1.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_PIXIV === '1';
const base = path.join(root, 'artifacts/pixiv/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {syncNextCatalog} from '${source}/comics/application/catalog-sync.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: {probe, fixtures: path.join(source, 'sources/sites/pixiv/tests/fixtures.ts')}, formats: ['es'], fileName: (_f, name) => name + '.mjs'}}});
const fixture = await import(pathToFileURL(path.join(extension, 'fixtures.mjs')).href);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const userId = live ? process.env.PIXIV_USER_ID || '25786514' : '7', author = `https://www.pixiv.net/users/${userId}/artworks`;
const tagged = author + '/' + encodeURIComponent(process.env.PIXIV_TAG || fixture.tag);
const errors = [], checks = []; let reader, entrySource, activeEntry, imageBytes, failCatalog = false, addArtwork = false;
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
if (!live) {
  await context.route('https://i.pximg.net/**', route => route.fulfill({contentType: 'image/png', body: imageBytes}));
  await context.route('https://www.pixiv.net/**', route => {
    if (!new URL(route.request().url()).pathname.startsWith('/ajax/')) return route.fulfill({contentType: 'text/html', body:
      '<!doctype html><meta charset="utf-8"><title>Pixiv entry fixture</title><style>body{margin:0;background:#f5f5f5;font:16px sans-serif}header{padding:24px;background:white}main{max-width:900px;margin:48px auto}article{padding:40px;background:white;border-radius:16px}</style><header>Pixiv · 网站入口夹具</header><main><h1>作者作品</h1><article>主页 · 插画 · 漫画 · 系列</article></main>'});
    if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
    const rows = [fixture.work('101', {seriesId: '9'}), fixture.work('102', {illustType: 1, seriesId: '9'}), fixture.work('103', {tags: ['other']})];
    if (addArtwork) rows.push(fixture.work('104', {illustType: 1, seriesId: '9'}));
    const body = fixture.fixtureBody(route.request().url(), rows);
    // Missing work summaries need detail; missing membership does not need another request.
    if (body.thumbnails) {
      body.thumbnails.illust = body.thumbnails.illust.filter(row => row.id !== '101');
      for (const row of body.thumbnails.illust) if (row.id === '102') delete row.seriesId;
    }
    return route.fulfill({contentType: 'application/json', body: fixture.response(body)});
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000})};});
const waitImage = (page = 1) => reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
  {entry: activeEntry, page}, {timeout: 90000});
const refresh = comicId => reader.evaluate(async comicId => {const p = await import(chrome.runtime.getURL('probe.mjs')), comic = await p.catalog.get('comics', comicId);
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;}, comicId);
const importLink = async url => {await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(url); await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 120000});};
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  if (!live) imageBytes = Buffer.from(await reader.evaluate(() => {const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#0096fa'; ctx.fillRect(0, 0, 800, 1200); ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText('Pixiv fixture', 100, 300); return c.toDataURL().split(',')[1];}), 'base64');
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  if (live) await importLink(author.replace('/artworks', ''));
  else {
    await reader.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === 'nc-source-entry-pixiv'));
    entrySource = await context.newPage(); await entrySource.goto('https://www.pixiv.net/artworks/101');
    const importButton = entrySource.getByRole('button', {name: /NodeLane Comics/});
    assert.equal(await importButton.count(), 0);
    const rejected = await reader.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === 'https://www.pixiv.net/artworks/101');
      return chrome.runtime.sendMessage({type: 'NC_DISCOVER_TAB', tabId: tab.id});
    }); assert.equal(rejected.ok, false);
    await entrySource.evaluate(() => history.pushState({}, '', '/users/7'));
    await importButton.waitFor(); assert.equal(await importButton.count(), 1);
    assert.equal(await entrySource.getByRole('button', {name: '寻找其他语言', exact: true}).count(), 0);
    assert(await importButton.evaluate(el => {const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;}));
    await entrySource.screenshot({path: path.join(out, 'source-entry.png')});
    const opened = context.waitForEvent('page', p => p.url().includes('reader.html'));
    await importButton.click(); await reader.close(); reader = await opened;
    await reader.getByLabel('跳转页码', {exact: true}).waitFor();
    checks.push('Embedded import works on first click after native artwork to author SPA navigation; no alternative-language button');
  }
  const imported = await state(); assert.equal(imported.comics.length, 1); const comic = imported.comics[0];
  activeEntry = imported.entries.find(e => e.indexState === 'ready')?.id; assert(activeEntry);
  if (live) assert(imported.entries.length > 0); else assert.equal(imported.entries.length, 3); await waitImage();
  const savedPage = await reader.evaluate(async entry => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs')), e = await catalog.get('entries', entry);
    return Math.min(2, (await catalog.listPages(e.contentId)).length);}, activeEntry);
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(savedPage)); await waitImage(savedPage);
  await reader.waitForFunction(async ({entry, page}) => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs')), e = await catalog.get('entries', entry);
    return (await catalog.get('positions', entry))?.pageId === (await catalog.listPages(e.contentId))[page - 1]?.pageId;}, {entry: activeEntry, page: savedPage});
  await reader.screenshot({path: path.join(out, 'reader.png')}); checks.push('Author home import, complete directory and original image decode');
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const directory = reader.getByRole('tab', {name: /^目录/}); if (await directory.isVisible()) await directory.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor(); await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.close();
  reader = await context.newPage(); await reader.goto(home); await reader.getByRole('button', {name: '打开漫画 ' + comic.title, exact: true}).click(); await waitImage(savedPage);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(savedPage)); assert.equal(await refresh(comic.id), imported.entries.length);
  const synced = await reader.evaluate(async comicId => {const p = await import(chrome.runtime.getURL('probe.mjs'));
    await p.catalog.mutate(['comics'], async tx => {const c = await tx.get('comics', comicId); await tx.put('comics', {...c, catalogSync: {...c.catalogSync, nextCheckAt: 0}});});
    await p.syncNextCatalog(); return (await p.catalog.get('comics', comicId)).catalogSync;}, comic.id);
  assert(synced.lastSuccessAt && synced.nextCheckAt > Date.now()); checks.push('Reopen restores saved page; existing scheduled refresh completes without source tabs');
  if (!live) {
    const before = await state(); failCatalog = true; await assert.rejects(refresh(comic.id)); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; addArtwork = true; await refresh(comic.id); await refresh(comic.id);
    assert.equal((await state()).comics[0].catalogUpdates.count, 1); checks.push('Failed refresh preserves catalog; duplicate refresh counts new artwork once');
  }
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await importLink(author + '?p=2'); await waitImage(savedPage);
  assert.equal((await state()).comics.length, 1); checks.push('Home and artworks imports deduplicate and preserve reading position');
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await importLink(tagged);
  const separate = await state(), tagComic = separate.comics.find(c => c.id !== comic.id); assert(tagComic);
  const tagEntries = separate.entries.filter(e => e.comicId === tagComic.id);
  if (live) assert(tagEntries.length > 0 && tagEntries.length <= imported.entries.length); else assert.equal(tagEntries.length, 3);
  activeEntry = tagEntries.find(e => e.indexState === 'ready')?.id; assert(activeEntry); await waitImage();
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '1');
  await reader.screenshot({path: path.join(out, 'tag-reader.png')});
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.screenshot({path: path.join(out, 'shelf.png')});
  checks.push('Tag import creates an independent book and reading position');
  const seriesId = live ? process.env.PIXIV_SERIES_ID : '9', scopes = [['illustrations', author.replace('/artworks', '/illustrations'), 2],
    ['manga', author.replace('/artworks', '/manga'), 2]];
  if (seriesId) scopes.push(['series', `https://www.pixiv.net/user/${userId}/series/${seriesId}`, 3]);
  const scopeCounts = {};
  for (const [scope, url, fixtureCount] of scopes) {
    const before = await state(); await importLink(url);
    const current = await state(), importedScope = current.comics.find(c => !before.comics.some(b => b.id === c.id)); assert(importedScope);
    const entries = current.entries.filter(e => e.comicId === importedScope.id);
    if (live) assert(entries.length > 0); else assert.equal(entries.length, fixtureCount);
    assert.equal(current.comics.length, before.comics.length + 1);
    activeEntry = entries.find(e => e.indexState === 'ready')?.id; assert(activeEntry); await waitImage();
    assert.equal(await refresh(importedScope.id), entries.length);
    scopeCounts[scope] = entries.length;
    await reader.getByRole('button', {name: '打开目录', exact: true}).click();
    const tab = reader.getByRole('tab', {name: /^目录/}); if (await tab.isVisible()) await tab.click();
    await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor(); await reader.screenshot({path: path.join(out, scope + '-directory.png')});
    await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
    await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
    await reader.getByRole('button', {name: '打开漫画 ' + importedScope.title, exact: true}).click(); await waitImage();
    await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
    checks.push(scope + ': independent import, original decode, refresh and reopen' + (scope === 'series' && !live ? '; missing summaries recovered, missing membership accepted' : ''));
  }
  if (live) assert.equal(scopeCounts.illustrations + scopeCounts.manga, imported.entries.length);
  if (entrySource) {
    const importButton = entrySource.getByRole('button', {name: /NodeLane Comics/});
    for (const target of ['/users/7/artworks', '/users/7/illustrations', '/users/7/manga', '/users/7/artworks/' + encodeURIComponent(fixture.tag), '/user/7/series/9']) {
      await entrySource.evaluate(target => history.pushState({}, '', target), target);
      await importButton.waitFor(); assert.equal(await importButton.count(), 1);
      assert.equal(await entrySource.getByRole('button', {name: '寻找其他语言', exact: true}).count(), 0);
    }
    await entrySource.evaluate(() => history.pushState({}, '', '/artworks/101'));
    await importButton.waitFor({state: 'detached'});
    await entrySource.evaluate(() => history.pushState({}, '', '/user/7/series/9')); await importButton.waitFor();
    failCatalog = true; await importButton.click(); await entrySource.getByRole('status').filter({hasText: '目录读取失败'}).waitFor();
    assert(await importButton.isEnabled()); failCatalog = false;
    const reopened = context.waitForEvent('page', p => p.url().includes('reader.html'));
    await importButton.click(); const seriesReader = await reopened;
    await seriesReader.getByLabel('跳转页码', {exact: true}).waitFor(); await seriesReader.close();
    await worker.evaluate(async url => {const tab = (await chrome.tabs.query({})).find(t => t.url === url); await chrome.tabs.update(tab.id, {active: true});}, entrySource.url());
    const popupOpened = context.waitForEvent('page');
    await worker.evaluate(async home => chrome.tabs.create({url: new URL('popup.html', home).href, active: false}), home);
    const popup = await popupOpened; await popup.setViewportSize({width: 420, height: 720});
    await popup.getByRole('button', {name: '开始阅读', exact: true}).waitFor();
    assert.equal(await popup.getByRole('button', {name: '寻找其他语言', exact: true}).count(), 0);
    await popup.getByRole('button', {name: '开始阅读', exact: true}).scrollIntoViewIfNeeded();
    await popup.screenshot({path: path.join(out, 'popup.png')}); await popup.close();
    await reader.getByRole('button', {name: '打开漫画 ' + comic.title, exact: true}).click();
    await reader.getByRole('button', {name: '阅读设置', exact: true}).click();
    assert.equal(await reader.getByRole('button', {name: '寻找其他语言', exact: true}).count(), 0);
    await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
    await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
    await reader.locator(`[data-comic-id="${comic.id}"]`).click({button: 'right'});
    await reader.getByRole('menuitem', {name: '导出漫画', exact: true}).waitFor();
    assert.equal(await reader.getByRole('menuitem', {name: '寻找其他语言', exact: true}).count(), 0);
    await reader.screenshot({path: path.join(out, 'shelf-menu.png')}); await reader.keyboard.press('Escape');
    checks.push('All supported Pixiv routes show one import entry; SPA cleanup, failed import retry and popup/reader/shelf hide alternative-language search');
  }
  await reader.screenshot({path: path.join(out, 'shelf.png')});
  assert.deepEqual(errors, []); await writeFile(path.join(out, 'result.json'), JSON.stringify({live, checks, entries: imported.entries.length, tagged: tagEntries.length, scopeCounts}, null, 2));
  console.log(JSON.stringify({out, checks}, null, 2));
} catch (error) {
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2000));}
  console.log(JSON.stringify({out, checks, errors})); throw error;
} finally {await context.close();}
