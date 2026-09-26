// Explicit live HTTP acceptance in a fresh MV3 profile using the built manifest host access. No product API/model calls.
// From repository root, after building: node apps/extension/src/sources/sites/guazimanhua/tests/verify-browser.mjs
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const root = process.cwd(), out = path.join(root, 'artifacts/guazimanhua/browser');
await mkdir(out, {recursive: true});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = await mkdtemp(path.join(out, 'extension-')), profile = await mkdtemp(path.join(out, 'profile-'));
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert(manifest.host_permissions?.includes('http://*/*'));
assert(manifest.host_permissions?.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
const bgPath=path.join(extension,'background.js');
await writeFile(bgPath,`globalThis.sourceRequests=[];chrome.webRequest.onBeforeRequest.addListener(details=>{if(details.initiator?.startsWith('chrome-extension://'))globalThis.sourceRequests.push(details.url);},{urls:['https://www.guazimanhua.com/*']});\n`+await readFile(bgPath,'utf8'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';export {readNetworkPages} from '${source}/sources/runtime/network.ts';export {readSourceImage} from '${source}/sources/runtime/source-image.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const context = await chromium.launchPersistentContext(profile, {headless: true, executablePath: process.env.TEST_CHROMIUM,
  viewport: {width: 1440, height: 1000}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const checks = [], created = [], errors = [];
context.on('page', page => {created.push(page); page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);});});
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, body: '{}'}));
async function waitState(page, predicate, arg, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {if (await page.evaluate(predicate, arg)) return; await delay(100);} while (Date.now() < deadline);
  throw Error('Timed out waiting for persisted state');
}
let reader;
try {
  const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', background.url()).href;
  const setup = await context.newPage(); await setup.goto(home);
  await setup.evaluate(() => localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN'})));
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: '瓜子漫画', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'sites.png')});
  const site = await context.newPage();
  await site.goto('https://www.guazimanhua.com/chapter.php?id=1977711', {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await button.waitFor();
  const tabId=await background.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,site.url());
  await background.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
  const popupOpened=context.waitForEvent('page');await background.evaluate(home=>chrome.tabs.create({url:new URL('popup.html',home).href,active:false}),home);
  const popup=await popupOpened;await popup.setViewportSize({width:420,height:650});
  await popup.getByRole('button',{name:'开始阅读',exact:true}).waitFor();
  await popup.screenshot({path:path.join(out,'popup-chapter.png')});
  const before = created.length;
  const opened = context.waitForEvent('page'); await popup.getByRole('button',{name:'开始阅读',exact:true}).click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  console.log('Catalog imported; waiting for reader images');
  await reader.getByLabel('跳转页码').waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 90000});
  const details = await reader.evaluate(async () => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(c => c.source.connectionId === 'website:guazimanhua');
    const entries = await catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.indexState === 'ready');
    return {comicId: comic.id, entryId: entry.id, chapters: entries.length, total: entry.pageCount};
  });
  assert(details.chapters >= 812); assert.equal(details.total, 18);
  const chapterRequests=await background.evaluate(()=>globalThis.sourceRequests.filter(url=>url==='https://www.guazimanhua.com/chapter.php?id=1977711').length);
  assert.equal(chapterRequests,1,'Parent discovery HTML must be reused across worker and reader');
  checks.push('Popup bare-chapter import creates the complete work; worker-to-reader handoff fetches chapter HTML only once');
  for (let number = 1; number <= details.total; number++) {
    await reader.getByLabel('跳转页码').fill(String(number), {force: true});
    await reader.waitForFunction(index => document.querySelector(`[data-page-index="${index}"] img.nc-page-image`)?.naturalWidth > 0, number - 1, {timeout: 60000});
    if (number === 1 || number === details.total) await reader.screenshot({path: path.join(out, `reader-${number}.png`)});
  }
  checks.push('Live catalog imported through popup action; all 18 pages decoded in the reader');
  console.log(checks.at(-1));
  await reader.getByLabel('跳转页码').fill('10', {force: true});
  await waitState(reader, async id => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', id), pages = await catalog.listPages(entry.contentId), position = await catalog.get('positions', id);
    return position?.pageId === pages[9]?.pageId;
  }, details.entryId);
  const route = reader.url(); await reader.close(); reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: /继续阅读/}).click();
  await reader.waitForFunction(() => document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth > 0);
  assert.equal(await reader.getByLabel('跳转页码').inputValue(), '10');
  await reader.screenshot({path: path.join(out, 'reopened-10.png')});
  checks.push('Reopening restores page 10');
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`);
  await cover.waitFor(); await cover.evaluate(img => img.decode());
  assert(await cover.evaluate(img => img.naturalWidth > 0));
  await setup.screenshot({path: path.join(out, 'cover.png')});
  checks.push('Shelf displays the dedicated live cover');
  await site.close();
  const started = Date.now();
  await reader.evaluate(async id => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = await catalog.get('comics', id);
    await catalog.put('comics', {...comic, catalogSync: {...comic.catalogSync, nextCheckAt: 0, lastSuccessAt: 0, lastAttemptAt: 0}});
    await chrome.runtime.sendMessage({type: 'NC_CHECK_DUE_CATALOGS'});
  }, details.comicId);
  await waitState(reader, async ({id, started}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const sync = (await catalog.get('comics', id))?.catalogSync;
    return sync?.lastSuccessAt >= started && !sync.lease;
  }, {id: details.comicId, started});
  assert.equal(created.length - before, 2, 'HTTP import and refresh must not create collection tabs');
  checks.push('Background refresh succeeds with the source tab closed and no collection tabs');
  // Pasting either URL must preserve the same comic, entry IDs and existing reading position.
  for(const link of ['https://www.guazimanhua.com/chapter.php?id=1977711','https://www.guazimanhua.com/comic.php?id=26470']){
    await setup.getByRole('button',{name:'漫画网站',exact:true}).click();
    await setup.getByLabel('通过链接添加漫画').fill(link);
    await setup.getByRole('button',{name:'添加到书架',exact:true}).click();
    await setup.getByLabel('跳转页码').waitFor();
    await setup.waitForFunction(()=>document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth>0);
    assert.equal(await setup.getByLabel('跳转页码').inputValue(),'10');
    assert.equal(await setup.evaluate(async()=> (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length),1);
    await setup.screenshot({path:path.join(out,'link-import-restored.png')});
    await setup.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  }
  checks.push('Pasted chapter and catalog links preserve one comic and restore its existing page 10 position');
  const longChapter = await reader.evaluate(async () => {
    const {readNetworkPages, readSourceImage} = await import(chrome.runtime.getURL('verify-source.js'));
    const manifest = await readNetworkPages('https://www.guazimanhua.com/chapter.php?id=955039#nodelane-guazimanhua=18741');
    const last = manifest.items.at(-1), blob = await readSourceImage({manifestId: manifest.id, pageId: last.id, expectedUrl: last.url});
    const bitmap = await createImageBitmap(blob), dimensions = [bitmap.width, bitmap.height]; bitmap.close();
    return {total: manifest.items.length, dimensions};
  });
  assert.equal(longChapter.total, 59); assert(longChapter.dimensions.every(n => n > 0));
  checks.push('59-page chapter is complete beyond the SEO preview; last page decodes');
  const chapter = await context.newPage();
  await chapter.goto('https://www.guazimanhua.com/chapter.php?id=1977722', {waitUntil: 'domcontentloaded'});
  const chapterButton = chapter.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await chapterButton.waitFor(); await chapterButton.scrollIntoViewIfNeeded();
  await chapter.screenshot({path: path.join(out, 'reader-button.png')});
  const openedAgain = context.waitForEvent('page'); await chapterButton.click(); const managed = await openedAgain;
  await managed.waitForURL('**/reader.html?catalog=*');
  await managed.getByRole('button', {name: /继续阅读/}).click();
  await managed.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  assert.equal(await managed.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push('Bare chapter URL resolves to the same complete catalog without duplicating the comic');
  await chapter.goto('https://www.guazimanhua.com/comic.php?id=26470',{waitUntil:'domcontentloaded'});
  await chapterButton.waitFor();await chapterButton.scrollIntoViewIfNeeded();await chapter.screenshot({path:path.join(out,'catalog-button.png')});
  const catalogOpened=context.waitForEvent('page');await chapterButton.click();const catalogReader=await catalogOpened;
  await catalogReader.waitForURL('**/reader.html?catalog=*');await catalogReader.getByRole('button',{name:/继续阅读/}).waitFor();
  assert.equal(await catalogReader.evaluate(async()=> (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length),1);
  checks.push('Embedded catalog and chapter actions share the popup/link identity');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, details, longChapter, errors}, null, 2));
  console.log(JSON.stringify({checks, details, longChapter, errors}));
} catch (error) {
  if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-1500));}
  throw error;
} finally {await context.close();}
