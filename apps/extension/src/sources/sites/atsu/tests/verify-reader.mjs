// Built MV3 extension in an isolated profile. RUN_LIVE_ATSU=1 enables public source HTTP/CDN reads.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), live = process.env.RUN_LIVE_ATSU === '1';
const base = path.join(root, 'artifacts/atsu', live ? 'live-reader' : 'fixture-reader');
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
context.on('response', response => {if (response.url().startsWith('https://atsu.moe') && response.status() >= 400) failures.push({path: new URL(response.url()).pathname, status: response.status()});});
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}', contentType: 'application/json'}));
let failCatalog = false, addChapter = false;
const liveUrl = process.env.ATSU_CATALOG_URL || 'https://atsu.moe/manga/RkOOE';
let title = 'Atsumaru grouped fixture', sourceCatalog;
let firstSourceId = 'atsu:Work1:chapter:Chap1', secondSourceId = 'atsu:Work1:chapter:Chap3';
const chapter = (id, index, scanlator = 'Scan1') => ({id, scanlationMangaId: scanlator, title: 'Chapter ' + (index + 1),
  index, number: index + 1, pageCount: 3});
const rows = () => [chapter('Chap2', 1), chapter('Chap3', 0, 'Scan2'), chapter('Chap1', 0), ...(addChapter ? [chapter('Chap4', 2)] : [])];
if (!live) {
  const bytes = await readFile(path.join(root, 'samples/starlight-bookshop.png'));
  await context.route('https://cdn.atsu.moe/**', route => route.fulfill({status: 200, contentType: 'image/png', body: bytes}));
  await context.route('https://atsu.moe/**', async route => {
    const url = new URL(route.request().url()); let value;
    if (url.pathname === '/collections/manga/documents/search') value = {found: 1, page: 1, hits: [{document: {id: 'Work1', title,
      authors: ['Fixture author'], medium: 'Comic', poster: '/static/posters/fixture.png'}}]};
    else if (url.pathname === '/api/manga/page') value = {mangaPage: {id: 'Work1', title, medium: 'Comic', type: 'Manga',
      poster: {image: 'posters/fixture.png'}, totalChapterCount: addChapter ? 3 : 2,
      chapters: rows().map(({id, scanlationMangaId}) => ({id, scanlationMangaId})), hasMoreChapters: false,
      scanlators: [{id: 'Scan1', name: 'First group'}, {id: 'Scan2', name: 'Second group'}]}};
    else if (url.pathname === '/api/manga/allChapters') {
      if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
      value = {chapters: rows()};
    } else if (url.pathname === '/api/read/chapter') {
      const selected = rows().find(row => row.id === url.searchParams.get('chapterId')); assert(selected);
      // Exercise current scanlation namespaces; the adapter must independently verify the parent work.
      value = {readChapter: {id: selected.id, title: selected.title, scanlationMangaId: selected.scanlationMangaId,
        pages: [0, 1, 2].map(number => ({id: `${selected.id}-${number}`, number, width: 800, height: 1100,
          image: `/static/pages/${selected.scanlationMangaId}/${selected.id}/${number}.png`}))}};
    } else throw Error('Unexpected Atsumaru fixture request: ' + url.pathname);
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
  });
}
let reader, activeEntry, worker;
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('verify-source.js')); return {
  comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000}),
  catalogs: await catalog.list('catalogs'), positions: await catalog.list('positions')};});
async function waitImage(page = 1) {
  await reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
    {entry: activeEntry, page}, {timeout: 60000});
  await reader.evaluate(async ({entry, page}) => {
    const image = document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`);
    await image.decode();
  }, {entry: activeEntry, page});
}
async function pageCount(entry) {return reader.evaluate(async id => {const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
  return (await catalog.listPages((await catalog.get('entries', id)).contentId)).length;}, entry.id);}
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
  await slot.locator(`[data-chapter-main="true"][data-entry-id="${entry.id}"]`).click(); activeEntry = entry.id;
  await reader.waitForFunction(page => document.querySelector('[aria-label="跳转页码"]')?.value === String(page), page); await waitImage(page);
}
async function refresh() {return reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('verify-source.js')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});}
try {
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href;
  if (!live) await worker.evaluate(({title, bytes}) => {
    globalThis.atsuReaderFixture = {failCatalog: false, addChapter: false};
    const original = fetch, body = Uint8Array.from(atob(bytes), character => character.charCodeAt(0));
    const chapter = (id, index, scanlator = 'Scan1') => ({id, scanlationMangaId: scanlator, title: 'Chapter ' + (index + 1), index, number: index + 1, pageCount: 3});
    const rows = () => [chapter('Chap2', 1), chapter('Chap3', 0, 'Scan2'), chapter('Chap1', 0), ...(globalThis.atsuReaderFixture.addChapter ? [chapter('Chap4', 2)] : [])];
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input)); let value;
      if (url.origin === 'https://cdn.atsu.moe' && /^\/static\/(?:pages\/(?:Scan1|Scan2)\/Chap[1-4]\/[0-2]\.png|posters\/fixture\.png)$/.test(url.pathname) && !url.search)
        return Promise.resolve(new Response(body, {status: 200, headers: {'Content-Type': 'image/png'}}));
      if (url.origin !== 'https://atsu.moe') return original(input, options);
      if (url.pathname === '/collections/manga/documents/search') value = {found: 1, page: 1, hits: [{document: {id: 'Work1', title, authors: ['Fixture author'], medium: 'Comic', poster: '/static/posters/fixture.png'}}]};
      else if (url.pathname === '/api/manga/page' && url.searchParams.get('id') === 'Work1') value = {mangaPage: {id: 'Work1', title, medium: 'Comic', type: 'Manga', poster: {image: 'posters/fixture.png'}, totalChapterCount: globalThis.atsuReaderFixture.addChapter ? 3 : 2,
        chapters: rows().map(({id, scanlationMangaId}) => ({id, scanlationMangaId})), hasMoreChapters: false,
        scanlators: [{id: 'Scan1', name: 'First group'}, {id: 'Scan2', name: 'Second group'}]}};
      else if (url.pathname === '/api/manga/allChapters' && url.searchParams.get('mangaId') === 'Work1') {
        if (globalThis.atsuReaderFixture.failCatalog) return Promise.resolve(new Response('Unavailable', {status: 503}));
        value = {chapters: rows()};
      } else if (url.pathname === '/api/read/chapter' && url.searchParams.get('mangaId') === 'Work1') {
        const selected = rows().find(row => row.id === url.searchParams.get('chapterId'));
        if (!selected) return Promise.reject(Error('Unknown Atsumaru fixture chapter'));
        value = {readChapter: {id: selected.id, title: selected.title, scanlationMangaId: selected.scanlationMangaId, pages: [0, 1, 2].map(number => ({id: `${selected.id}-${number}`, number, width: 800, height: 1100,
          image: `/static/pages/${selected.scanlationMangaId}/${selected.id}/${number}.png`}))}};
      } else return original(input, options);
      return Promise.resolve(new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}}));
    };
  }, {title, bytes: (await readFile(path.join(root, 'samples/starlight-bookshop.png'))).toString('base64')});
  reader = await context.newPage(); await reader.goto(home);
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window'};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  if (live) {
    // Use the production catalog transport/parser to choose current public work and chapter identities.
    sourceCatalog = await reader.evaluate(async url => {const {readWebsiteCatalog} = await import(chrome.runtime.getURL('verify-source.js'));
      return readWebsiteCatalog(url);}, liveUrl);
    assert(sourceCatalog.complete && sourceCatalog.groups.every(group => group.complete));
    const readable = sourceCatalog.entries.filter(entry => entry.readable !== false);
    assert(readable.length >= 2, 'Reader verification needs at least two readable source chapters');
    const first = readable[0], second = readable.find(entry => entry.id !== first.id && entry.sequenceId !== first.sequenceId) || readable[1];
    title = sourceCatalog.title; firstSourceId = first.id; secondSourceId = second.id;
  }
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all()) await option.locator('input').setChecked((await option.innerText()).includes('Atsumaru'));
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? title : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: title, exact: true})});
  await hit.waitFor({timeout: 60000}); await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  const imported = await state(); assert.equal(imported.comics.length, 1);
  if (live) {
    assert.equal(imported.entries.length, sourceCatalog.entries.length);
    assert.deepEqual(new Set(imported.entries.map(entry => entry.sourceEntryId)), new Set(sourceCatalog.entries.map(entry => entry.id)));
    const stored = imported.catalogs.find(catalog => catalog.id === sourceCatalog.id); assert(stored?.complete);
    assert.deepEqual(stored.groups, sourceCatalog.groups);
    for (const sourceEntry of sourceCatalog.entries) {
      const entry = imported.entries.find(entry => entry.sourceEntryId === sourceEntry.id);
      assert.equal(entry.sequenceId, sourceEntry.sequenceId);
    }
  } else assert.equal(imported.entries.length, rows().length);
  const first = imported.entries.find(entry => entry.sourceEntryId === firstSourceId);
  assert(first); activeEntry = first.id; await waitImage();
  const firstPage = Math.min(3, await pageCount(first)); assert(firstPage > 0); await jump(firstPage);
  checks.push('Name search, source candidate import and actual reader image decoding without a source tab');
  const second = imported.entries.find(entry => entry.sourceEntryId === secondSourceId);
  assert(second); await choose(second);
  const secondPage = Math.min(2, await pageCount(second)); assert(secondPage > 0);
  await jump(secondPage); await choose(first, firstPage); await choose(second, secondPage); await choose(first, firstPage);
  await directory(); await reader.screenshot({path: path.join(out, 'directory.png')}); await closePanel();
  checks.push(live ? `Two public chapters decode and preserve independent page ${secondPage}/page ${firstPage} positions` : 'Source groups keep independent chapter chains and selected chapters preserve page 2/page 3');
  await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = reader.locator('.nc-book .nc-thumbnail img'); await cover.waitFor(); await cover.evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: '打开漫画 ' + title, exact: true}).click(); await waitImage(firstPage);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(firstPage));
  assert.equal(await refresh(), imported.entries.length);
  checks.push(`Dedicated cover decoding, reader reopening and a complete refresh retain chapter/page ${firstPage}`);
  if (!live) {
    failCatalog = true; await worker.evaluate(() => {globalThis.atsuReaderFixture.failCatalog = true;});
    const beforePage = await reader.getByLabel('跳转页码', {exact: true}).inputValue(), before = await state();
    await assert.rejects(refresh()); const after = await state();
    assert.deepEqual(after.entries, before.entries); assert.deepEqual(after.positions, before.positions);
    assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), beforePage); await waitImage(Number(beforePage));
    failCatalog = false; addChapter = true; await worker.evaluate(() => {globalThis.atsuReaderFixture.failCatalog = false; globalThis.atsuReaderFixture.addChapter = true;});
    assert.equal(await refresh(), imported.entries.length + 1);
    const updated = await state(); assert.equal(updated.comics[0].catalogUpdates.count, 1); assert(updated.comics[0].catalogSync.nextCheckAt > Date.now());
    await refresh(); assert.equal((await state()).comics[0].catalogUpdates.count, 1);
    checks.push('Failed full catalogs preserve entries, positions and the current decoded page; one new stable chapter creates one update notification');
  }
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(second.sourceUrl); await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  activeEntry = second.id; await waitImage(secondPage); assert.equal((await state()).comics.length, 1);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(secondPage));
  checks.push(`Explicit chapter import verifies membership and restores that exact chapter/page ${secondPage} without a duplicate comic`);
  assert(sourceTabs.every(page => !page.url().startsWith('https://atsu.moe'))); assert.deepEqual(errors, []);
  await reader.screenshot({path: path.join(out, 'reader.png')});
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', live, catalog: live ? {url: sourceCatalog.url, title, releases: sourceCatalog.entries.length,
    groups: sourceCatalog.groups.length, selectedChapters: [firstSourceId, secondSourceId]} : undefined,
    checks, failures, errors, sourceTabs: false, nativePermissions: false, models: false}, null, 2));
  console.log(JSON.stringify({out, live, checks}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', live, checks, failures, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2000));}
  console.log(JSON.stringify({out, failures, errors})); throw error;
} finally {await context.close();}
