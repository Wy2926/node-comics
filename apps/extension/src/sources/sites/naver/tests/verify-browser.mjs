// Real NAVER + isolated unpacked MV3 profile. Host grants are preauthorized; no user profile or login.
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), out = path.join(root, 'artifacts/naver-validation');
await mkdir(out, {recursive: true});
const require = createRequire(import.meta.url), {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = await mkdtemp(path.join(out, 'extension-')), profile = await mkdtemp(path.join(out, 'profile-'));
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://comic.naver.com/*', 'https://image-comic.pstatic.net/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';
export {readNetworkPages} from '${source}/sources/runtime/network.ts';
export {catalog} from '${source}/comics/repositories/index.ts';
export {syncNextCatalog} from '${source}/comics/application/catalog-sync.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'},
}});
const context = await chromium.launchPersistentContext(profile, {headless: true, executablePath: process.env.TEST_CHROMIUM,
  viewport: {width: 1440, height: 1000}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
const checks = [], pages = [], errors = []; let reader;
context.on('page', page => { pages.push(page); page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}); });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  await reader.evaluate(() => localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN'})));
  await reader.reload();
  await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByRole('heading', {name: 'NAVER Webtoon', exact: true}).waitFor();
  await reader.screenshot({path: path.join(out, 'sites.png')});
  const site = await context.newPage();
  await site.goto('https://comic.naver.com/webtoon/list?titleId=758037');
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await button.waitFor({timeout: 30000});
  assert.equal(await button.count(), 1);
  await site.screenshot({path: path.join(out, 'catalog-button.png')});
  const opened = context.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 120000});
  await site.close();
  const before = pages.length;
  const state = await reader.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(row => row.source.connectionId === 'website:naver');
    const source = await catalog.get('catalogs', comic.source.providerItemId);
    const entries = await catalog.list('entries', {index: 'comicId', range: comic.id, limit: 10000});
    return {comicId: comic.id, chapters: source.entries.length, entryId: entries.find(row => row.sourceEntryId === source.defaultEntryId).id};
  });
  assert(state.chapters > 200); checks.push({buttonImport: state.chapters});
  await reader.screenshot({path: path.join(out, 'reader-first.png')});
  for (const number of [2, 10]) {
    await reader.getByLabel('跳转页码').fill(String(number), {force: true});
    await reader.waitForFunction(index => document.querySelector(`[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth > 0, number - 1, {timeout: 60000});
  }
  await reader.screenshot({path: path.join(out, 'reader-page-10.png')});
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
  await reader.getByRole('button', {name: '继续阅读', exact: true}).click();
  await reader.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  const saved = await reader.evaluate(async entryId => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', entryId), position = await catalog.get('positions', entryId);
    const pages = await catalog.listPages(entry.contentId, {limit: 10000});
    return {count: pages.length, ordinal: pages.find(row => row.pageId === position.pageId)?.ordinal};
  }, state.entryId);
  assert.equal(saved.ordinal, 9); assert(saved.count > 100); checks.push({closedSourceReadingAndReopen: saved});
  await reader.screenshot({path: path.join(out, 'reader-reopened.png')});
  const refreshed = await reader.evaluate(async comicId => {
    const {catalog, syncNextCatalog} = await import(chrome.runtime.getURL('verify-source.js'));
    await catalog.mutate(['comics'], async tx => {const comic = await tx.get('comics', comicId); await tx.put('comics', {...comic, catalogSync: {...comic.catalogSync, nextCheckAt: 0}});});
    await syncNextCatalog();
    const comic = await catalog.get('comics', comicId);
    return {lastSuccess: comic.catalogSync.lastSuccessAt, nextCheck: comic.catalogSync.nextCheckAt,
      chapters: (await catalog.get('catalogs', comic.source.providerItemId)).entries.length};
  }, state.comicId);
  assert(refreshed.nextCheck > Date.now()); assert.equal(refreshed.chapters, state.chapters); checks.push({scheduledRefresh: refreshed});
  const other = await reader.evaluate(async () => {
    const {readSourceCatalog, readNetworkPages} = await import(chrome.runtime.getURL('verify-source.js'));
    const rows = [];
    for (const [section, id] of [['bestChallenge', 851953], ['challenge', 842677]]) {
      const source = await readSourceCatalog(`https://comic.naver.com/${section}/list?titleId=${id}`);
      const pages = await readNetworkPages(source.entries[0].url);
      rows.push({section, entries: source.entries.length, images: pages.items.length});
    }
    return rows;
  });
  assert(other.every(row => row.entries > 0 && row.images > 0)); checks.push({otherSections: other});
  assert.equal(pages.length, before); checks.push({sourceTabsCreatedDuringReadingAndRefresh: 0});
  const detail = await context.newPage(); await detail.goto('https://comic.naver.com/webtoon/detail?titleId=758037&no=1');
  await detail.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor({timeout: 30000});
  await detail.screenshot({path: path.join(out, 'reader-button.png')});
  const duplicate = context.waitForEvent('page');
  await detail.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).click();
  const managed = await duplicate;
  await managed.waitForURL(url => url.searchParams.has('catalog'));
  await managed.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 120000});
  assert.equal(await managed.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    return (await catalog.list('comics')).filter(row => row.source.connectionId === 'website:naver').length;
  }), 1);
  checks.push('Reader-page button manages the same comic without duplicating it');
  await managed.close();
  await detail.close();
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, errors}, null, 2));
  console.log(JSON.stringify({checks, errors}));
} catch (error) {
  if (reader && !reader.isClosed()) {console.log((await reader.locator('body').innerText()).slice(-1800)); await reader.screenshot({path: path.join(out, 'failure.png')});}
  throw error;
} finally {await context.close();}
