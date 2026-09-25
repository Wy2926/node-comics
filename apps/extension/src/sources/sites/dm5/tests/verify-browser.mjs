// Real DM5, isolated preauthorized MV3 profile; no product API or model calls.
// Run from repo root after npm run build in apps/extension.
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
// waitForFunction treats an async predicate's Promise as truthy before its boolean resolves.
async function waitForState(page, predicate, arg, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    if (await page.evaluate(predicate, arg)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for persisted DM5 test state');
}
const catalogUrl = process.env.DM5_CATALOG_URL || 'https://www.dm5.com/manhua-zuixihuanxuejiedetudingmen/';
const slug = /^\/manhua-([a-z0-9-]+)\/$/.exec(new URL(catalogUrl).pathname)?.[1];
assert(slug && new URL(catalogUrl).origin === 'https://www.dm5.com');
const injectEmpty = process.env.DM5_EMPTY_FIRST_RESPONSE === '1';
const root = process.cwd(), out = path.join(root, 'artifacts/dm5-validation', slug + (injectEmpty ? '-empty-recovery' : ''));
await mkdir(out, {recursive: true});
const require = createRequire(import.meta.url), {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = await mkdtemp(path.join(out, 'extension-')), profile = await mkdtemp(path.join(out, 'profile-'));
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://www.dm5.com/*', 'https://dm5.com/*', 'https://*.cdndm5.com/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';export {readNetworkPages} from '${source}/sources/runtime/network.ts';export {readSourceImage} from '${source}/sources/runtime/source-image.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const context = await chromium.launchPersistentContext(profile, {headless: true, executablePath: process.env.TEST_CHROMIUM,
  viewport: {width: 1440, height: 1000}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const created = [], errors = [], pages = [];
context.on('page', page => {created.push(page);page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);});});
let injected = false;
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}'}));
if (injectEmpty) await context.route('https://www.dm5.com/**/chapterfun.ashx?*', async route => {
  if (injected) return route.continue();
  injected = true;
  console.log('Injected one synthetic empty image list before the live retry');
  const cid = new URL(route.request().url()).searchParams.get('cid'), key = 'a'.repeat(32);
  const program = `var cid=${Number(cid)};var key='${key}';var pix='https://images.cdndm5.com/1/1/${Number(cid)}';var pvalue=[];for(var i=0;i<pvalue.length;i++){pvalue[i]=pix+pvalue[i]+'?cid=${Number(cid)}&key=${key}'};`;
  await route.fulfill({status: 200, contentType: 'text/javascript', body: `eval(function(p,a,c,k,e,d){}(${JSON.stringify(program)},2,1,''.split('|'),0,{}))`});
});
let reader, site;
try {
  const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', background.url()).href;
  const setup = await context.newPage(); await setup.goto(home);
  await setup.evaluate(() => localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN'})));
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: '动漫屋 DM5', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'sites.png')});
  site = await context.newPage();
  await site.goto(catalogUrl, {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await button.waitFor({timeout: 30000}); await button.scrollIntoViewIfNeeded();
  await site.screenshot({path: path.join(out, 'embedded-button.png')});
  const before = created.length;
  const opened = context.waitForEvent('page', {predicate: p => p !== site});
  await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码').waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 90000});
  console.log('Embedded button imported the live catalog and displayed page 1');
  const details = await reader.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(c => c.source.connectionId === 'website:dm5');
    const entries = await catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.indexState === 'ready');
    return {comicId: comic.id, entryId: entry.id, chapters: entries.length, total: entry.pageCount};
  });
  for (let number = 1; number <= details.total; number++) {
    await reader.getByLabel('跳转页码').fill(String(number), {force: true});
    await reader.waitForFunction(index => {
      const cell = document.querySelector(`[data-page-index="${index}"]`);
      return cell?.querySelector('img.nc-page-image')?.naturalWidth > 0 || !!cell?.querySelector('.nc-image-failure');
    }, number - 1, {timeout: 60000});
    const shown = await reader.locator(`[data-page-index="${number - 1}"] img.nc-page-image`).evaluateAll(images => images.some(image => image.naturalWidth > 0));
    pages.push({number, shown}); assert(shown, `page ${number} failed`);
    if (number === 1 || number === 10 || number === details.total) await reader.screenshot({path: path.join(out, `reader-${number}.png`)});
    if (number % 10 === 0) console.log(`Reader displayed ${number}/${details.total} pages`);
  }
  await reader.getByLabel('跳转页码').fill('10', {force: true});
  await reader.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0);
  await waitForState(reader, async id => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', id), descriptors = await catalog.listPages(entry.contentId), position = await catalog.get('positions', id);
    return position?.pageId === descriptors[9]?.pageId;
  }, details.entryId);
  const route = reader.url(); await reader.close();
  reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: /继续阅读/}).click();
  await reader.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  await reader.screenshot({path: path.join(out, 'reopened-10.png')});
  // Re-import the same URL from the directory with the source tab closed. The existing
  // comic and its persisted reading position must be reused without a source tab.
  await site.close();
  await setup.getByLabel('通过链接添加漫画').fill(catalogUrl);
  await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0);
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  const started = Date.now();
  // Playwright page request events do not include this extension worker's fetches.
  await background.evaluate(() => {
    const paths = [], listener = details => paths.push(new URL(details.url).pathname);
    chrome.webRequest.onBeforeRequest.addListener(listener, {urls: ['https://www.dm5.com/*']});
    globalThis.dm5UpdateProbe = {paths, restore: () => chrome.webRequest.onBeforeRequest.removeListener(listener)};
  });
  await reader.evaluate(async id => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = await catalog.get('comics', id);
    await catalog.put('comics', {...comic, catalogSync: {...comic.catalogSync, nextCheckAt: 0, lastSuccessAt: 0, lastAttemptAt: 0}});
    await chrome.runtime.sendMessage({type: 'NC_CHECK_DUE_CATALOGS'});
  }, details.comicId);
  await waitForState(reader, async ({id, started}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const sync = (await catalog.get('comics', id))?.catalogSync;
    return sync?.lastSuccessAt >= started && sync?.lastAttemptAt >= started && !sync.lease;
  }, {id: details.comicId, started}, 45000);
  const updateRequests = await background.evaluate(() => {
    const probe = globalThis.dm5UpdateProbe; probe.restore(); delete globalThis.dm5UpdateProbe;
    return probe.paths;
  });
  assert.deepEqual(updateRequests, [new URL(catalogUrl).pathname]);
  const largeCatalog = await reader.evaluate(async () => {
    const {readSourceCatalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const source = await readSourceCatalog('https://www.dm5.com/manhua-yaoshenji/');
    return {chapters: source.entries.length, groups: source.groups.map(g => ({title: g.title, count: g.entryIds.length}))};
  });
  assert(largeCatalog.chapters > 900);
  const oddChapter = await reader.evaluate(async () => {
    const {readNetworkPages,readSourceImage} = await import(chrome.runtime.getURL('verify-source.js'));
    const manifest = await readNetworkPages('https://www.dm5.com/m426475/#nodelane-dm5=yaoshenji');
    const last = manifest.items.at(-1), blob = await readSourceImage({manifestId: manifest.id, pageId: last.id, expectedUrl: last.url});
    const bitmap = await createImageBitmap(blob), size = {width: bitmap.width, height: bitmap.height}; bitmap.close();
    return {total: manifest.items.length, ...size};
  });
  assert.equal(oddChapter.total, 15); assert(oddChapter.width > 0 && oddChapter.height > 0);
  const diagnostics = await reader.evaluate(async id => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', id);
    return {managed: Object.keys(await chrome.storage.session.get(null)).filter(k => /^nc-(managed|catalog-tab):/.test(k)),
      rules: (await chrome.declarativeNetRequest.getSessionRules()).filter(r => r.id >= 800000 && r.id < 900000).length,
      materialized: (await catalog.list('materializations', {index: 'contentId', range: entry.contentId, limit: 1500})).length};
  }, details.entryId);
  // Two expected app pages: button opens the reader, then this test reopens it once.
  // Count every creation, including any already-closed transient source tab.
  const extraSourceTabs = created.length - before - 2;
  assert.equal(extraSourceTabs, 0); assert.deepEqual(diagnostics.managed, []); assert.equal(diagnostics.rules, 0); assert.equal(diagnostics.materialized, details.total); assert.deepEqual(errors, []);
  assert.equal(injected, injectEmpty);
  const result = {catalogUrl, chapters: details.chapters, total: details.total, displayed: pages.filter(p => p.shown).length,
    reopenedAt: 10, directLinkImport: true, backgroundRefresh: true, updateRequests, injectedEmptyRecovery: injected,
    largeCatalog, oddChapter, extraSourceTabs, ...diagnostics, errors};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-1600));}
  throw error;
} finally {await context.close();}
