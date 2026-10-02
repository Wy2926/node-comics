// Built MV3 reader in an isolated Chromium profile. RUN_LIVE_MANGABALL=1 enables public source HTTP.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';

const root = process.cwd(), live = process.env.RUN_LIVE_MANGABALL === '1';
const base = path.join(root, 'artifacts/mangaball/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'probe.mjs'},
}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const errors = [], checks = [], sourcePages = [], coverResponses = [];
context.on('page', page => {sourcePages.push(page); page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);});});
context.on('response', async response => {
  const url = new URL(response.url());
  if (!['bulbasaur.poke-black-and-white.net', 'uploads.mangadex.org'].includes(url.hostname) || !url.pathname.startsWith('/covers/')) return;
  const headers = await response.allHeaders();
  coverResponses.push({provider: url.hostname === 'uploads.mangadex.org' ? 'MangaDex' : 'MangaBall', status: response.status(), contentType: headers['content-type'] ?? null,
    cfMitigated: headers['cf-mitigated'] ?? null, cfCacheStatus: headers['cf-cache-status'] ?? null, server: headers.server ?? null});
});
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
let titleId = live ? '685205eb68c513c5035d68c5' : '0123456789abcdef01234567';
const ids = ['123456789abcdef012345678', '123456789abcdef012345679', '123456789abcdef012345670', '123456789abcdef012345671'];
const catalogUrl = 'https://mangaball.com/title-detail/' + titleId;
let addChapter = false, failListing = false, reader, activeEntry, unknownImageRequests = 0;
let longCatalog = false, fixtureName = 'MangaBall fixture', listingBehavior = 'normal', page2Gate;
const listingRequests = new Map();
const success = data => ({status: 'success', code: 200, data});
const row = (id, number, lang) => ({id, _id: id, title_id: titleId, number, chapter_number: number, lang, name: 'Fixture release', status: 'published', group: {name: 'Fixture ' + lang}});
const fixtureChapterId = number => titleId.slice(0, 18) + number.toString(16).padStart(6, '0');
const groups = () => longCatalog
  ? Array.from({length: 101}, (_, index) => ({chapter_number: index + 1, releases: index === 0
    ? ['en', 'es', 'fr'].map((language, index) => row(fixtureChapterId(index), 1, language))
    : [row(fixtureChapterId(1000 + index), index + 1, 'en')]}))
  : [{chapter_number: 1, releases: [row(ids[0], 1, 'en'), row(ids[1], 1, 'es')]}, {chapter_number: 2, releases: [row(ids[2], 2, 'en')]},
    ...(addChapter ? [{chapter_number: 3, releases: [row(ids[3], 3, 'en')]}] : [])];
if (!live) {
  const bytes = await readFile(path.join(root, 'samples/starlight-bookshop.png'));
  await context.route('https://chikorita.red-and-blue.net/**', route => route.fulfill({contentType: 'image/png', body: bytes}));
  await context.route('https://bulbasaur.poke-black-and-white.net/**', route => route.fulfill({contentType: 'image/png', body: bytes}));
  await context.route('https://images.fixture.test/**', route => {unknownImageRequests++; return route.fulfill({contentType: 'image/png', body: bytes});});
  await context.route('https://api.mangaball.com/**', async route => {
    const url = new URL(route.request().url());
    const title = {id: titleId, name: fixtureName, chapters_count: groups().length, image: {cover: {path: titleId + '/cover_123.jpg'}}, author: [], availableTranslatedLanguages: ['en', 'es']};
    let value;
    if (url.pathname.endsWith('/search-advanced')) value = {...success([title]), pagination: {page: 1, limit: 20, total: 1, total_pages: 1}};
    else if (url.pathname.includes('/title/detail/')) value = success(title);
    else if (url.pathname.endsWith('/chapter-listing')) {
      if (failListing) return route.fulfill({status: 503, body: 'Unavailable'});
      const page = Number(url.searchParams.get('page')), count = (listingRequests.get(page) ?? 0) + 1; listingRequests.set(page, count);
      if (longCatalog && page === 2) {
        if (listingBehavior === 'gated') {page2Gate.requested.resolve(); await page2Gate.promise;}
        if (listingBehavior === 'retry-once' && count === 1) return route.fulfill({status: 429, headers: {'Retry-After': '1'}, body: 'Too many requests'});
        if (listingBehavior === 'fail') return route.fulfill({status: 503, body: 'Unavailable'});
      }
      const all = groups(), batch = all.slice((page - 1) * 100, page * 100);
      value = {...success(batch.flatMap(group => group.releases)), grouped_data: batch,
        pagination: {page, limit: 100, total: all.length, total_pages: Math.ceil(all.length / 100)}};
    } else if (url.pathname.endsWith('/chapter-detail')) {
      const id = url.searchParams.get('chapter_id'), chapter = groups().flatMap(group => group.releases).find(row => row.id === id); assert(chapter);
      value = success({chapter: {...chapter, pages: [1, 2, 3].map(n => n === 1
        ? `https://images.fixture.test/scan/${id}/page${n}.png?cache=fixture`
        : `https://chikorita.red-and-blue.net/storage/${titleId}/0/${chapter.number}/example/${chapter.lang}/${id}-00${n}.webp`)}, title});
    } else throw Error('Unexpected source request path: ' + url.pathname);
    return route.fulfill({contentType: 'application/json', body: JSON.stringify(value)});
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000}), positions: await catalog.list('positions'), catalogs: await catalog.list('catalogs')};});
async function waitImage(page = 1) {
  await reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
    {entry: activeEntry, page}, {timeout: 60000});
}
// Playwright's waitForFunction treats an async predicate's Promise as truthy before its value resolves.
// Poll completed evaluations for IndexedDB conditions so false never becomes a successful wait.
async function waitProbe(predicate, argument) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {if (await reader.evaluate(predicate, argument)) return; await delay(50);}
  throw Error('Timed out waiting for an IndexedDB verification condition');
}
async function jump(page) {
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(page)); await waitImage(page);
  await waitProbe(async ({entry, page}) => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
    const data = await catalog.get('entries', entry), pages = await catalog.listPages(data.contentId), position = await catalog.get('positions', entry);
    return position?.pageId === pages[page - 1]?.pageId;}, {entry: activeEntry, page});
}
async function refresh(comicId) {return reader.evaluate(async comicId => {const p = await import(chrome.runtime.getURL('probe.mjs'));
  const comic = comicId ? await p.catalog.get('comics', comicId) : (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;}, comicId);}
async function waitCatalogComplete() {
  await waitProbe(async catalogId => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
    return (await catalog.get('catalogs', catalogId))?.complete === true;}, 'mangaball:' + titleId);
}
async function importLongFixture(nextTitleId, name, behavior) {
  const close = reader.getByRole('button', {name: '关闭面板', exact: true}); if (await close.isVisible()) await close.click();
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
  await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  titleId = nextTitleId; fixtureName = name; longCatalog = true; listingBehavior = behavior; listingRequests.clear();
  await reader.getByLabel('通过链接添加漫画').fill('https://mangaball.com/title-detail/' + titleId);
  await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  const data = await state(), comic = data.comics.find(row => row.sourceUrl === 'https://mangaball.com/title-detail/' + titleId); assert(comic);
  const activeId = await reader.locator('.nc-stream-chapter').first().getAttribute('data-copy-id');
  const active = data.entries.find(row => row.comicId === comic.id && row.id === activeId);
  assert(active); assert.equal(active.indexState, 'ready'); activeEntry = active.id;
  await waitImage(); await jump(3); return {comic, active};
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window', autoTranslateTabs: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('MangaBall'));
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? 'About Teddy Bear' : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? 'About Teddy Bear' : 'MangaBall fixture', exact: true})});
  await hit.waitFor({timeout: 60000}); await hit.scrollIntoViewIfNeeded();
  const searchCover = hit.locator('.nc-search-result-cover img');
  await searchCover.waitFor({timeout: 60000}); await searchCover.evaluate(img => img.decode());
  assert(await searchCover.evaluate(img => img.naturalWidth > 0 && img.naturalHeight > 0));
  checks.push('Search cover is fetched through the MV3 source image transport and decoded');
  await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  const imported = await state(); assert.equal(imported.comics.length, 1); assert.equal(imported.comics[0].sourceUrl, catalogUrl);
  const activeId = await reader.locator('.nc-stream-chapter').first().getAttribute('data-copy-id');
  const active = imported.entries.find(row => row.id === activeId); assert(active); activeEntry = active.id;
  await waitImage(); await jump(3); await reader.screenshot({path: path.join(out, 'reader.png')});
  if (!live) assert(unknownImageRequests > 0, 'A public image on an undeclared HTTPS domain must be fetched and decoded');
  assert.equal(imported.entries.length, live ? 2 : 3);
  checks.push(live ? 'Name search, full catalog import, decoded original and page 3 without a source tab'
    : 'Name search, full catalog import, unknown HTTPS image domain with arbitrary path/query decodes without extra permission setup, and page 3 without a source tab');
  await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = reader.locator('.nc-book .nc-thumbnail img'); await cover.waitFor({timeout: 60000}); await cover.evaluate(img => img.decode());
  assert(await cover.evaluate(img => img.naturalWidth > 0 && img.naturalHeight > 0));
  checks.push('Library cover is fetched through the MV3 source image transport and decoded');
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: live ? '打开漫画 About Teddy Bear' : '打开漫画 MangaBall fixture', exact: true}).click(); await waitImage(3);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
  assert.equal(await refresh(), imported.entries.length);
  checks.push('Reopening the reader and a complete refresh retain the selected release and page 3');
  if (!live) {
    failListing = true; const before = await state(); await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failListing = false; addChapter = true; assert.equal(await refresh(), imported.entries.length + 1); await refresh();
    assert.equal((await state()).comics[0].catalogUpdates.count, 1);
    checks.push('Failed snapshots preserve entries; repeated refresh accounts for a new release once');
    await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
    await reader.getByLabel('通过链接添加漫画').fill('https://mangaball.com/chapter-detail/' + ids[1]);
    await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
    const updated = await state(), spanish = updated.entries.find(row => row.sourceEntryId === 'mangaball:chapter:' + ids[1]); assert(spanish);
    activeEntry = spanish.id; await waitImage(); await jump(2);
    assert.equal((await state()).comics.length, 1);
    checks.push('Bare chapter ownership import selects the exact Spanish release without duplicating the comic');
    page2Gate = {...Promise.withResolvers(), requested: Promise.withResolvers()};
    const early = await importLongFixture('89abcdef0123456701234567', 'MangaBall long fixture', 'gated');
    await new Promise((resolve, reject) => {const timer = setTimeout(() => reject(Error('Catalog page 2 was not requested')), 30000);
      page2Gate.requested.promise.then(() => {clearTimeout(timer); resolve();}, reject);});
    const prefix = await state(), partial = prefix.catalogs.find(row => row.comicId === early.comic.id); assert(partial);
    assert.equal(partial.complete, false); assert.equal(partial.entries.length, 102);
    assert.equal(prefix.entries.filter(row => row.comicId === early.comic.id).length, 102);
    assert.equal(listingRequests.get(1), 1); assert.equal(listingRequests.get(2), 1);
    await reader.getByRole('button', {name: '打开目录', exact: true}).click();
    await reader.getByText('正在获取全部章节…', {exact: true}).waitFor();
    await reader.screenshot({path: path.join(out, 'early-reading.png')});
    page2Gate.resolve(); await waitCatalogComplete();
    const completed = await state(); assert.equal(completed.catalogs.find(row => row.comicId === early.comic.id).entries.length, 103);
    assert.equal(completed.entries.find(row => row.id === activeEntry).contentId, early.active.contentId);
    await waitImage(3); assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
    await reader.getByText('正在获取全部章节…', {exact: true}).waitFor({state: 'hidden'});
    checks.push('A verified 100-group prefix opens and decodes page 3 before gated page 2; completing 103 releases preserves content and position');
    listingBehavior = 'retry-once'; listingRequests.clear();
    assert.equal(await refresh(early.comic.id), 103);
    assert.equal(listingRequests.get(1), 1); assert.equal(listingRequests.get(2), 2);
    assert.equal((await state()).entries.find(row => row.id === activeEntry).contentId, early.active.contentId);
    assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
    checks.push('429 on catalog page 2 respects Retry-After and resumes that page without requesting page 1 again');
    const interrupted = await importLongFixture('98abcdef0123456701234567', 'MangaBall interrupted fixture', 'fail');
    await reader.getByRole('button', {name: '打开目录', exact: true}).click();
    await reader.getByRole('button', {name: '继续加载目录', exact: true}).waitFor();
    const failed = await state(); assert.equal(failed.catalogs.find(row => row.comicId === interrupted.comic.id).complete, false);
    assert.equal(failed.entries.filter(row => row.comicId === interrupted.comic.id).length, 102);
    await reader.screenshot({path: path.join(out, 'partial-catalog-failure.png')});
    await reader.close(); reader = await context.newPage(); await reader.goto(home);
    await reader.getByRole('button', {name: '打开漫画 MangaBall interrupted fixture', exact: true}).click(); await waitImage(3);
    assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
    await reader.getByRole('button', {name: '打开目录', exact: true}).click();
    listingBehavior = 'normal'; listingRequests.clear();
    await reader.getByRole('button', {name: '继续加载目录', exact: true}).click(); await waitCatalogComplete();
    const resumed = await state(); assert.equal(resumed.catalogs.find(row => row.comicId === interrupted.comic.id).entries.length, 103);
    assert.equal(resumed.entries.find(row => row.id === activeEntry).contentId, interrupted.active.contentId);
    assert.equal(resumed.comics.filter(row => row.sourceUrl === interrupted.comic.sourceUrl).length, 1);
    await waitImage(3); assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
    checks.push('An interrupted partial catalog remains readable after reopening and Continue catalog completes the same book without resetting page 3');
  }
  assert(sourcePages.every(page => !page.url().startsWith('https://mangaball.com'))); assert.deepEqual(errors, []);
  await reader.screenshot({path: path.join(out, 'final.png')});
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', live, checks, errors, coverResponses,
    ...(live ? {} : {unknownImageRequests}), sourceTab: false, nativePermissions: false, models: false}, null, 2));
  console.log(JSON.stringify({out, live, checks}, null, 2));
} catch (error) {
  let fixtureState;
  if (!live && reader && !reader.isClosed()) {
    const data = await state();
    fixtureState = {titleId, activeEntry, listingPageAttempts: Object.fromEntries(listingRequests),
      catalogs: data.catalogs.map(row => ({id: row.id, comicId: row.comicId, complete: row.complete, entries: row.entries.length})),
      selectedEntry: data.entries.filter(row => row.id === activeEntry).map(row => ({id: row.id, comicId: row.comicId, contentId: row.contentId}))};
  }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', live, checks, errors, coverResponses, fixtureState, error: error.message, stack: error.stack}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  console.log(JSON.stringify({out, live, checks, errors})); throw error;
} finally {await context.close();}
