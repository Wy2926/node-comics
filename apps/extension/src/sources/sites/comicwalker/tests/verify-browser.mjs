// Real public source in an isolated MV3 profile. No translation provider or account is used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/comicwalker/browser');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/comicwalker/tests/browser-probe.ts'),
    formats: ['es'], fileName: () => 'verify-source.mjs'},
}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, viewport: {width: 1440, height: 1000},
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
browser.setDefaultTimeout(30000);
await browser.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
const checks = [], errors = [], timings = {};
const safe = message => String(message).replace(/https:\/\/cdn\.comic-walker\.com\/\S+/g, '[ComicWalker CDN]');
let page, details;
const chapter = 'https://comic-walker.com/detail/KC_008597_S/episodes/KC_0085970000200011_E';
async function waitImage(index) {
  await page.waitForFunction(index => {const image = document.querySelector(`[data-page-index="${index}"] img.nc-page-image`);
    return image?.complete && image.naturalWidth > 0;}, index, {timeout: 60000});
}
const state = () => page.evaluate(async id => {
  const p = await import(chrome.runtime.getURL('verify-source.mjs'));
  const comic = await p.catalog.get('comics', id), entries = await p.catalog.listEntries(id, {limit: 10000});
  return {ids: entries.map(e => e.id), lastEntryId: comic.lastEntryId,
    position: await p.catalog.get('positions', comic.lastEntryId)};
}, details.comicId);
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href;
  page = await browser.newPage();
  page.on('pageerror', e => errors.push(safe(e.message)));
  await page.goto(home);
  await page.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'ja', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await page.reload(); await page.getByRole('button', {name: '漫画网站', exact: true}).click();
  await page.getByRole('heading', {name: 'カドコミ · ComicWalker', exact: true}).waitFor();
  await page.screenshot({path: path.join(out, 'site-directory.png')});
  const started = Date.now();
  await page.getByLabel('通过链接添加漫画').fill('https://comic-walker.com/viewer/KC_0085970000200011_E');
  await page.getByRole('button', {name: '添加到书架', exact: true}).click();
  await page.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000}); await waitImage(0);
  timings.importFirstPageMs = Date.now() - started;
  details = await page.evaluate(async chapter => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs'));
    const comic = (await p.catalog.list('comics')).find(c => c.source.connectionId === 'website:comicwalker');
    const entries = await p.catalog.listEntries(comic.id, {limit: 10000});
    const entry = entries.find(e => e.sourceEntryId === p.sourceLocation(chapter)?.pageKey);
    return {comicId: comic.id, entryId: entry.id, entries: entries.length, pages: entry.pageCount};
  }, chapter);
  assert.equal(details.pages, 56); assert(details.entries > 8);
  checks.push('Registered site, legacy viewer-link ownership resolution and real decoded first page');
  const next = Date.now(); await page.getByLabel('跳转页码', {exact: true}).fill('5', {force: true});
  await page.getByLabel('跳转页码', {exact: true}).press('Enter'); await waitImage(4);
  await page.waitForFunction(async ({id, entryId}) => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), entry = await p.catalog.get('entries', entryId);
    const pages = await p.catalog.listPages(entry.contentId), position = await p.catalog.get('positions', entryId);
    return position?.pageId === pages[4]?.pageId && (await p.catalog.get('comics', id)).lastEntryId === entryId;
  }, {id: details.comicId, entryId: details.entryId});
  timings.pageFiveMs = Date.now() - next;
  await page.screenshot({path: path.join(out, 'reader-page-5.png')});
  const before = await state(); await page.close(); page = await browser.newPage(); await page.goto(home);
  await page.locator(`[data-comic-id="${details.comicId}"] .nc-book-cover`).click(); await waitImage(4);
  assert.equal(await page.getByLabel('跳转页码', {exact: true}).inputValue(), '5'); assert.deepEqual(await state(), before);
  await page.screenshot({path: path.join(out, 'restored.png')});
  checks.push('Closing/reopening retains chapter and page 5');
  await page.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl);
    await p.applyCatalogRefresh(id, comic.source.generation, snapshot); await p.applyCatalogRefresh(id, comic.source.generation, snapshot);
  }, details.comicId);
  assert.deepEqual(await state(), before);
  const failed = await page.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), comic = await p.catalog.get('comics', id), original = fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith('https://comic-walker.com/') ?
      Promise.resolve(new Response('Unavailable', {status: 503})) : original(input, options);
    try {await p.readWebsiteCatalog(comic.sourceUrl); return false;} catch {return true;} finally {globalThis.fetch = original;}
  }, details.comicId);
  assert(failed); assert.deepEqual(await state(), before);
  checks.push('Repeated complete refresh and simulated HTTP failure preserve catalog and reading position');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, timings, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks, details, timings}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, error: safe(error.message), details, errors}, null, 2));
  await page?.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  console.log(JSON.stringify({out, error: safe(error.message)})); throw Error(safe(error.message));
} finally {await browser.close();}
