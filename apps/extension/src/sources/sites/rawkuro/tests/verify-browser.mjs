import {setReaderProgress} from '../../../../../tests/reader-progress-driver.mjs';
// Real public source/CDN in an isolated built MV3 extension; no translation provider calls.
// Uses a public 17-page chapter; each image must decode in the reader.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/rawkuro/browser');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.resolve(process.env.TEST_EXTENSION_DIR || path.join(root, 'apps/extension/.output/chrome-mv3')), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  headless: true, executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
context.setDefaultTimeout(30000);
const checks = [], errors = [];
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
let reader, details;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const setup = await context.newPage(); await setup.goto(new URL('reader.html', worker.url()).href);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'width', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'RawKuro', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  for (const siteId of ['rawkuro', 'raw1001']) {
    const found = await setup.evaluate(async siteId => {
      const p = await import(chrome.runtime.getURL('verify-source.js')), sessionId = 'rawkuro-browser-search';
      const registered = p.listSearchSites().some(site => site.key === 'rawkuro:' + siteId);
      try {
        const results = await p.searchSource('rawkuro', {siteId, query: 'ワンピース'}, {sessionId});
        const hit = results.items.find(hit => hit.cover);
        if (!hit) throw Error('Search has no artwork candidate');
        return {registered, hits: results.items.length, owned: results.items.every(hit => hit.sourceId === 'rawkuro' && hit.siteId === siteId),
          coverBytes: (await p.readSearchCover(hit)).size, comics: (await p.catalog.list('comics')).length};
      } finally {p.releaseSourceSearchSession(sessionId);}
    }, siteId);
    assert(found.registered && found.hits > 0 && found.owned && found.coverBytes > 1000 && found.comics === 0);
  }
  checks.push('Both mirrors return validated search candidates and artwork without creating a library record');
  const chapter = process.env.RAWKURO_READER_URL || 'https://rawkuro.net/manga/wanpisu002/di1195hua';
  const site = await context.newPage(), response = await site.goto(chapter, {waitUntil: 'domcontentloaded'});
  assert(response?.ok(), `Public chapter HTTP ${response?.status() ?? 'missing response'}`);
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await button.waitFor();
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = context.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByRole('slider', {name: '阅读进度', exact: true}).waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  details = await reader.evaluate(async chapter => {
    const {catalog, sourceLocation} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(comic => comic.source.connectionId === 'website:rawkuro');
    if (!comic) throw Error('Imported RawKuro comic is missing');
    const entries = await catalog.listEntries(comic.id, {limit: 10000});
    const entry = entries.find(entry => entry.sourceEntryId === sourceLocation(chapter)?.pageKey);
    if (!entry) throw Error('Requested chapter was not selected from its catalog');
    return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl, chapters: entries.length, total: entry.pageCount};
  }, chapter);
  assert(details.chapters > 0 && details.total > 0);
  const readingState = () => reader.evaluate(async ({comicId, entryId}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')), comic = await catalog.get('comics', comicId);
    return {position: (await catalog.get('positions', entryId)) ?? null, lastEntryId: comic.lastEntryId};
  }, details);
  for (let number = 1; number <= details.total; number++) {
    await setReaderProgress(reader.getByRole('slider', {name: '阅读进度', exact: true}), String(number));

    await reader.waitForFunction(({id, index}) => {
      const image = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"] img.nc-page-image`);
      return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }, {id: details.entryId, index: number - 1}, {timeout: 60000});
    console.log(`Decoded original page ${number}/${details.total}`);
  }
  checks.push(`Floating chapter import binds the complete ${details.chapters}-entry catalog and decodes all ${details.total} original pages`);
  const restorePage = Math.min(10, details.total), restoreIndex = restorePage - 1;
  await setReaderProgress(reader.getByRole('slider', {name: '阅读进度', exact: true}), String(restorePage));

  const restoreImage = `[data-copy-id="${details.entryId}"] [data-page-index="${restoreIndex}"] img.nc-page-image`;
  await reader.waitForFunction(selector => {
    const image = document.querySelector(selector); return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, restoreImage);
  const savedScroll = await reader.evaluate(({id, index}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const page = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"]`);
    viewport.scrollTop = page.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.dispatchEvent(new Event('scroll', {bubbles: true})); return viewport.scrollTop;
  }, {id: details.entryId, index: restoreIndex});
  await reader.waitForFunction(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', id), comic = await catalog.get('comics', entry.comicId);
    const pages = await catalog.listPages(entry.contentId), position = await catalog.get('positions', id);
    return position?.contentId === entry.contentId && position?.pageId === pages[index]?.pageId &&
      comic.lastEntryId === id && Math.abs(position.relativeOffset) < 0.002;
  }, {id: details.entryId, index: restoreIndex});
  details.savedPosition = await readingState();
  await reader.screenshot({path: path.join(out, 'reader-position.png')});
  const route = reader.url(); await reader.close(); reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 ' + details.title, exact: true}).click();
  await reader.waitForFunction(({selector, top}) => {
    const image = document.querySelector(selector), viewport = document.querySelector('.nc-reading-viewport');
    return image?.complete && image.naturalWidth > 0 && viewport && Math.abs(viewport.scrollTop - top) < 2;
  }, {selector: restoreImage, top: savedScroll}, {timeout: 60000});
  assert.equal(await reader.getByRole('slider', {name: '阅读进度', exact: true}).inputValue(), String(restorePage));
  assert.equal((await readingState()).lastEntryId, details.entryId);
  await reader.screenshot({path: path.join(out, 'reopened-position.png')});
  checks.push(`Reader close/reopen restores chapter, page ${restorePage} and scroll position`);
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`); await cover.waitFor(); await cover.evaluate(image => image.decode());
  assert(await cover.evaluate(image => image.naturalWidth > 0)); await setup.screenshot({path: path.join(out, 'cover.png')});
  checks.push('Shelf decodes the dedicated work artwork');
  await site.close(); const count = context.pages().length;
  const refreshed = await reader.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    return {complete: snapshot.complete, total: (await p.catalog.listEntries(comic.id, {limit: 10000})).length,
      updates: (await p.catalog.get('comics', id)).catalogUpdates?.count ?? 0};
  }, details.comicId);
  assert(refreshed.complete); assert.equal(refreshed.total, details.chapters); assert.equal(refreshed.updates, 0); assert.equal(context.pages().length, count);
  checks.push('Full catalog refresh with the source tab closed creates no source tabs or duplicate updates');
  details.beforeFailure = await readingState();
  assert(details.beforeFailure.position?.pageId && details.beforeFailure.lastEntryId === details.entryId);
  await reader.evaluate(() => {
    globalThis.rawkuroFailureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => ['rawkuro.net', 'raw1001.net'].includes(new URL(typeof input === 'string' ? input : input.url ?? input).hostname)
      ? Promise.resolve(new Response('Unavailable', {status: 503})) : globalThis.rawkuroFailureFetch(input, options);
  });
  try {
    const preserved = await reader.evaluate(async ({comicId}) => {
      const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', comicId);
      let failed = false;
      try {const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);} catch {failed = true;}
      return {failed, entries: (await p.catalog.listEntries(comicId, {limit: 10000})).length};
    }, details);
    details.afterFailure = await readingState();
    assert(preserved.failed && preserved.entries === details.chapters, JSON.stringify(preserved));
    assert.deepEqual(details.afterFailure, details.beforeFailure);
  } finally {await reader.evaluate(() => {globalThis.fetch = globalThis.rawkuroFailureFetch; delete globalThis.rawkuroFailureFetch;});}
  checks.push('Simulated catalog HTTP failure preserves the complete catalog and saved reading position');
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  const mirror = new URL(details.catalogUrl);
  mirror.hostname = mirror.hostname === 'rawkuro.net' ? 'raw1001.net' : 'rawkuro.net';
  await setup.getByLabel('通过链接添加漫画').fill(mirror.href);
  await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.getByRole('slider', {name: '阅读进度', exact: true}).waitFor({timeout: 60000});
  await setup.waitForFunction(top => Math.abs(document.querySelector('.nc-reading-viewport')?.scrollTop - top) < 2, savedScroll, {timeout: 60000});
  assert.equal(await setup.getByRole('slider', {name: '阅读进度', exact: true}).inputValue(), String(restorePage));
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push('Mirror catalog link reimport keeps one comic, selected chapter/page and in-page reading offset');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, errors, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, details, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await context.close();}
