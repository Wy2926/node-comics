// Built MV3 extension, isolated profile. RUN_LIVE_MANGADOT=1 enables public source HTTP.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), live = process.env.RUN_LIVE_MANGADOT === '1';
const base = path.join(root, 'artifacts/mangadot', live ? 'live-reader' : 'fixture-reader');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert(manifest.host_permissions.includes('https://*/*'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {comicDirectory} from '${source}/comics/application/library-service.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'},
}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const errors = [], checks = [], sourceTabs = [], failures = [];
context.on('page', page => {sourceTabs.push(page); page.on('pageerror', error => errors.push(error.message));});
context.on('response', response => {if (response.url().startsWith('https://mangadot.net') && response.status() >= 400) failures.push({path: new URL(response.url()).pathname, status: response.status()});});
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
let failCatalog = false, addChapter = false;
const mangaId = live ? 3235 : 7;
const fixtureChapter = (id, language, number, source = 'user') => ({id, chapter_number: number, chapter_title: 'Chapter ' + number,
  source, language, page_count: 3, date_added: '2026-01-01 00:00:00+00', groups: [{name: 'Fixture ' + language}]});
const rows = () => [fixtureChapter(1, 'en', 1, 'scraper'), fixtureChapter(2, 'en', 1), fixtureChapter(3, 'fr', 1), fixtureChapter(4, 'es', 1),
  fixtureChapter(5, 'en', 2, 'scraper'), ...(addChapter ? [fixtureChapter(6, 'en', 3, 'scraper')] : [])];
if (!live) {
  const bytes = await readFile(path.join(root, 'samples/starlight-bookshop.png'));
  await context.route('https://mangadot.net/**', async route => {
    const url = new URL(route.request().url()); let value;
    if (url.pathname.startsWith('/chapters/') || url.pathname.startsWith('/uploads/')) return route.fulfill({status: 200, contentType: 'image/png', body: bytes});
    if (url.pathname === '/api/search') value = {query: url.searchParams.get('search'), manga_list: [{id: 7, title: 'MangaDot multilingual fixture', photo: '/uploads/cover.png', latest_chapter_number: 2}],
      pagination: {current_page: 1, total_pages: 1, total_results: 1, per_page: 12, next_cursor: null}};
    else if (url.pathname.endsWith('/chapters/list')) {
      if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
      value = rows();
    } else if (url.pathname.endsWith('/volumes')) value = [{id: 9, volume_number: 1, language: 'en', page_count: 3, date_added: '2026-01-01 00:00:00+00', groups: []}];
    else if (url.pathname === '/api/manga/7') value = {manga: {id: 7, title: 'MangaDot multilingual fixture', photo: '/uploads/cover.png'}, total_chapters: addChapter ? 3 : 2, total_volumes: 1};
    else if (/^\/api\/(uploads|chapters)\/\d+\/images$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/')[3]), user = url.pathname.startsWith('/api/uploads/'), kind = id === 9 ? 'volume' : 'chapter';
      value = {chapter: {id, manga_id: 7, chapter_number: '1.00', volume_number: '1.00', chapter_title: 'Chapter 1', page_count: 3,
        ...(user ? {status: 'approved', type: kind} : {})}, manga: {id: 7, title: 'MangaDot multilingual fixture'},
        ...(user ? {source: 'user', type: kind} : {}), images: [1, 2, 3].map(n => ({url: `/chapters/manga_7/release_${id}/${n}.png`, w: 0, h: 0}))};
    } else throw Error('Unexpected fixture request: ' + url.pathname);
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
  });
}
let reader, activeEntry;
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('verify-source.js')); return {
  comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000}), positions: await catalog.list('positions')};});
async function waitImage(page = 1) {
  await reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
    {entry: activeEntry, page}, {timeout: 60000});
}
async function jump(page) {
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(page)); await waitImage(page);
  await reader.waitForFunction(async ({entry, page}) => {const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const data = await catalog.get('entries', entry), pages = await catalog.listPages(data.contentId), position = await catalog.get('positions', entry);
    return position?.pageId === pages[page - 1]?.pageId;}, {entry: activeEntry, page});
}
async function directory() {
  const button = reader.getByRole('button', {name: '打开目录', exact: true});
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  const tab = reader.getByRole('tab', {name: /^目录/}); if (await tab.isVisible() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor();
}
async function closePanel() {const close = reader.getByRole('button', {name: '关闭面板', exact: true}); if (await close.isVisible()) await close.click();}
async function choose(entry, page = 1) {
  await directory();
  const model = await reader.evaluate(async id => {const p = await import(chrome.runtime.getURL('verify-source.js')), entry = await p.catalog.get('entries', id);
    return p.comicDirectory(entry.comicId, id, 'en');}, entry.id);
  const chapter = model.chapters.find(row => row.entryIds.includes(entry.id)); assert(chapter);
  const slot = reader.locator(`[data-reading-slot=${JSON.stringify(chapter.id)}]`);
  for (const ancestor of await slot.locator('xpath=ancestor::details[not(@open)]').all()) await ancestor.locator(':scope > summary').click();
  if (chapter.entryIds.length > 1) {
    const expand = slot.getByRole('button', {name: '展开章节选项', exact: true}); if (await expand.isVisible()) await expand.click();
    await slot.locator(`[data-release-choice="true"][data-entry-id="${entry.id}"]`).click();
  } else await slot.locator(`[data-chapter-main="true"][data-entry-id="${entry.id}"]`).click();
  activeEntry = entry.id;
  await reader.waitForFunction(page => document.querySelector('[aria-label="跳转页码"]')?.value === String(page), page);
  await waitImage(page);
}
async function refresh() {return reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('verify-source.js')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window'};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('MangaDot'));
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? 'Haimiya' : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? 'Haimiya-senpai wa Kowakute Kawaii' : 'MangaDot multilingual fixture', exact: true})});
  await hit.waitFor({timeout: 60000});
  assert.match(await hit.locator('.nc-search-result-chapter').innerText(), /^Ch\. -?\d+(?:\.\d+)?$/);
  await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  const imported = await state(); assert.equal(imported.comics.length, 1);
  const en = imported.entries.find(e => e.sourceEntryId === (live ? 'mangadot:scraper:chapter:286652' : 'mangadot:scraper:chapter:1'));
  assert(en); activeEntry = en.id; await waitImage(); await jump(3);
  checks.push('Name search, source candidate import and real reader decoding without a source tab');
  const fr = imported.entries.find(e => e.contentLanguage === 'fr' && e.readingSlotId === en.readingSlotId), es = imported.entries.find(e => e.contentLanguage === 'es' && e.readingSlotId === en.readingSlotId);
  assert(fr && es); await choose(fr); await jump(2); await choose(es); await jump(2); await choose(en, 3); await choose(fr, 2);
  await directory(); await reader.screenshot({path: path.join(out, 'multilingual-directory.png')}); await closePanel();
  const volume = imported.entries.find(e => e.sourceEntryId.includes(':volume:')); assert(volume);
  await choose(volume); await jump(3); await choose(en, 3);
  checks.push('English, French, Spanish and whole-volume releases decode and keep independent reading positions');
  await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = reader.locator('.nc-book .nc-thumbnail img'); await cover.waitFor(); await cover.evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: '继续阅读', exact: true}).click(); await waitImage(3);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
  assert.equal(await refresh(), imported.entries.length);
  checks.push('Dedicated cover, reader reopen and full refresh preserve the selected release and page 3');
  if (!live) {
    failCatalog = true; const before = await state(); await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; addChapter = true; assert.equal(await refresh(), imported.entries.length + 1);
    const updated = await state(); assert.equal(updated.comics[0].catalogUpdates.count, 1); assert.equal(updated.comics[0].catalogSync.nextCheckAt > Date.now(), true);
    await refresh(); assert.equal((await state()).comics[0].catalogUpdates.count, 1);
    checks.push('Failed full snapshots preserve old entries; a new stable ID increments the update count only once');
  }
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(fr.sourceUrl.split('#')[0]); await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  activeEntry = fr.id; await waitImage(2); assert.equal((await state()).comics.length, 1);
  checks.push('Bare uploaded chapter import resolves ownership and restores that exact language release');
  assert(sourceTabs.every(page => !page.url().startsWith('https://mangadot.net'))); assert.deepEqual(errors, []);
  await reader.screenshot({path: path.join(out, 'reader.png')});
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', live, checks, failures, errors, sourceTabs: false, nativePermissions: false, models: false}, null, 2));
  console.log(JSON.stringify({out, live, checks}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', live, checks, failures, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2000));}
  console.log(JSON.stringify({out, failures, errors})); throw error;
} finally {await context.close();}
