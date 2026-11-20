import {setReaderProgress} from '../../../../../tests/reader-progress-driver.mjs';
// Isolated MV3 profile, fixture by default; RUN_LIVE_WEBTOONS=1 exercises real public pages.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), live = process.env.RUN_LIVE_WEBTOONS === '1';
const liveTitle = process.env.WEBTOONS_TITLE || 'Not So Silent';
const base = path.join(root, 'artifacts/webtoons/browser'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, live ? 'live-' : 'fixture-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {search} from '${source}/sources/sites/webtoons/search.ts';
export {createPage} from '${source}/sources/sites/webtoons/page.ts';
export {definition} from '${source}/sources/sites/webtoons/definition.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: {probe, fixtures: path.join(source, 'sources/sites/webtoons/tests/fixtures.ts')}, formats: ['es'], fileName: (_f, name) => name + '.mjs'}}});
const fixture = await import(pathToFileURL(path.join(extension, 'fixtures.mjs')).href);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
if (live) {
  const describe = request => {const u = new URL(request.url()); return u.hostname === 'www.webtoons.com' ? u.pathname + (u.searchParams.has('page') ? '?page=' + u.searchParams.get('page') : '') : undefined;};
  context.on('request', request => {const url = describe(request); if (url) console.log('request', url);});
  context.on('requestfinished', request => {const url = describe(request); if (url) console.log('finished', url);});
  context.on('requestfailed', request => {const url = describe(request); if (url) console.log('failed', url, request.failure()?.errorText);});
}
const errors = [], checks = []; let reader, imageBytes, failCatalog = false, addChapter = false, activeEntry;
const commentRequests = []; let holdPage, failCommentPage = false;
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
// Block product API calls in the isolated reader without intercepting source traffic.
await context.addInitScript(() => {
  const request = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href);
    return url.hostname.endsWith('.nodelane.net') ? Promise.resolve(new Response('{}', {status: 503})) : request(input, options);
  };
});
if (!live) {
  await context.route('https://webtoon-phinf.pstatic.net/**', route => route.fulfill({contentType: 'image/png', body: imageBytes}));
  await context.route('https://www.webtoons.com/**', async route => {
    const url = new URL(route.request().url()); let html;
    if (url.pathname === '/p/api/community/v2/posts') {
      const id = url.searchParams.get('pageId'), cursor = url.searchParams.get('cursor');
      assert.equal(route.request().headers()['service-ticket-id'], 'epicom');
      assert(!route.request().headers().cookie && !route.request().headers().referer);
      commentRequests.push(id);
      if (cursor && holdPage) await holdPage.promise;
      if (cursor && failCommentPage) {failCommentPage = false; return route.fulfill({status:503,body:'Unavailable'});}
      return route.fulfill({json:fixture.commentsPage(id, !!cursor)}).catch(() => {});
    }
    if (url.pathname.includes('/search/')) html = fixture.searchHtml(url.pathname.split('/').at(-1), url.searchParams.get('keyword'));
    else if (url.pathname.endsWith('/viewer')) html = fixture.readerHtml(Number(url.searchParams.get('episode_no')));
    else html = fixture.catalogHtml();
    return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' + html});
  });
  await context.route('https://m.webtoons.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/canvas/')) {
      if (failCatalog) return route.fulfill({status: 503, body: 'Unavailable'});
      const page = url.searchParams.has('cursor') ? fixture.episodePage(addChapter ? [3, 4] : [3]) : fixture.episodePage([1, 2], 2);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(page)});
    }
    return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' +
      (url.pathname.endsWith('/viewer') ? fixture.mobileReaderHtml(Number(url.searchParams.get('episode_no'))) : fixture.mobileCatalogHtml)});
  });
}
const state = () => reader.evaluate(async () => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs'));
  return {comics: await catalog.list('comics'), entries: await catalog.list('entries', {limit: 10000})};});
const waitImage = (page = 1) => reader.waitForFunction(({entry, page}) => document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${page - 1}"] img.nc-page-image`)?.naturalWidth > 0,
  {entry: activeEntry, page}, {timeout: 90000});
const refresh = () => reader.evaluate(async () => {const p = await import(chrome.runtime.getURL('probe.mjs')), comic = (await p.catalog.list('comics'))[0];
  const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return snapshot.entries.length;});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(home);
  if (!live) imageBytes = Buffer.from(await reader.evaluate(() => {const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#25638a'; ctx.fillRect(0, 0, 800, 1200); ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText('WEBTOON fixture', 100, 300); return c.toDataURL().split(',')[1];}), 'base64');
  await reader.evaluate(async () => {const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false};
     localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});}); await reader.reload();
  if (!live) {
    const metadata = await reader.evaluate(async ({html, url}) => {
      const {createPage, definition} = await import(chrome.runtime.getURL('probe.mjs'));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const session = createPage({document: doc, location: definition.identify(new URL(url)), signal: new AbortController().signal});
      const work = session.describeWork(), anchor = session.importAnchor()?.className;
      doc.querySelector('link').href = url.replace('title_no=7', 'title_no=8');
      const wrongOwner = session.describeWork(); session.dispose();
      return {work, anchor, wrongOwner};
    }, {html: fixture.mobileCatalogHtml, url: fixture.catalogUrl.replace('www.', 'm.')});
    assert.equal(metadata.work.status, 'ready'); assert.equal(metadata.work.value.title, 'WEBTOON fixture');
    assert.equal(metadata.work.value.catalogUrl, fixture.catalogUrl); assert.equal(metadata.anchor, 'info_area');
    assert.equal(metadata.wrongOwner.status, 'not-ready'); checks.push('Mobile metadata uses canonical ownership and visible title');
  }
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = reader.locator('.nc-search-page');
  await search.locator('.nc-search-scope-expand').click();
  await search.getByRole('button', {name:'反选',exact:true}).click();
  await search.getByRole('checkbox', {name:'WEBTOON · English',exact:true}).check();
  await search.locator('.nc-search-scope-expand').click();
  const input = search.getByPlaceholder('输入漫画名称或别名'); await input.fill(live ? liveTitle : 'fixture'); await input.press('Enter');
  const hit = search.locator('.nc-search-result').filter({has: reader.getByRole('heading', {name: live ? liveTitle : 'WEBTOON fixture', exact: true})});
  await hit.waitFor({timeout: 60000}); await reader.screenshot({path: path.join(out, 'search.png')});
  await hit.getByRole('button', {name: '导入并阅读', exact: true}).click();
  await reader.getByRole('slider', {name: '阅读进度', exact: true}).waitFor({timeout: 120000});
  const imported = await state(); assert.equal(imported.comics.length, 1); activeEntry = imported.entries.find(e => e.indexState === 'ready')?.id; assert(activeEntry);
  const active = imported.entries.find(e => e.id === activeEntry);
  await waitImage(); await setReaderProgress(reader.getByRole('slider', {name: '阅读进度', exact: true}), '3'); await waitImage(3);
  await reader.waitForFunction(async entry => {const {catalog} = await import(chrome.runtime.getURL('probe.mjs')), e = await catalog.get('entries', entry);
    return (await catalog.get('positions', entry))?.pageId === (await catalog.listPages(e.contentId))[2]?.pageId;}, activeEntry);
  await reader.screenshot({path: path.join(out, 'reader.png')}); checks.push('Search -> full catalog -> real image decode -> page 3');
  if (!live) {
    assert.deepEqual(commentRequests, []);
    const tools = reader.locator('.nc-reader-rail.right'), toggle = tools.getByRole('button',{name:'评论',exact:true});
    await toggle.click();
    const panel = reader.getByRole('complementary',{name:'评论'}), pages = reader.locator('.nc-reader-navigation');
    await panel.getByText('Comment c_7_1/d',{exact:true}).waitFor();
    assert.equal(await panel.getByText('Comment c_7_1/c',{exact:true}).count(),0);
    await panel.getByRole('button',{name:'显示剧透'}).click();
    await panel.getByText('Comment c_7_1/c',{exact:true}).waitFor();
    const progress = reader.getByRole('slider',{name:'阅读进度',exact:true});
    await panel.locator('.nc-comment-scroll').press('PageUp');
    assert.equal(await progress.inputValue(),'3');
    await reader.locator('.nc-reading-viewport').click();
    await reader.keyboard.press('PageUp'); await waitImage(2);
    await reader.keyboard.press('PageDown'); await waitImage(3);
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert.deepEqual(commentRequests,['c_7_1']);
    holdPage = Promise.withResolvers();
    const started = reader.waitForRequest(req => new URL(req.url()).searchParams.get('cursor')?.endsWith('c_7_1-c'));
    await panel.getByRole('button',{name:'下一页'}).click(); await started;
    await pages.getByRole('button',{name:'下一页'}).click();
    await panel.getByText('Comment c_7_2/d',{exact:true}).waitFor();
    holdPage.resolve(); holdPage = undefined;
    assert.equal(await panel.getByText(/Comment c_7_1\//).count(),0);
    failCommentPage = true;
    await panel.getByRole('button',{name:'下一页'}).click();
    await panel.getByText('WEBTOON 暂不可用，请稍后重试。').waitFor();
    assert.equal(await panel.locator('.nc-comment').count(),0);
    await panel.getByRole('button',{name:'重试'}).click();
    await panel.getByText('Comment c_7_2/b',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'上一页'}).click();
    await panel.getByText('Comment c_7_2/d',{exact:true}).waitFor();
    await reader.setViewportSize({width:390,height:844});
    await reader.waitForFunction(() => document.querySelector('.nc-reading-viewport img.nc-page-image')?.getBoundingClientRect().width <= innerWidth);
    const sheet = await panel.boundingBox(), canvas = await reader.locator('.nc-reading-viewport').boundingBox();
    assert(sheet.y < canvas.y + canvas.height && sheet.height < 844 / 2 && canvas.height > 844 / 2);
    const imageBounds = () => reader.locator('.nc-reading-viewport img.nc-page-image').first().boundingBox();
    const compactImage = await imageBounds();
    await panel.getByRole('button',{name:'展开评论面板'}).click();
    assert((await panel.boundingBox()).height > sheet.height + 100);
    assert.deepEqual(await reader.locator('.nc-reading-viewport').boundingBox(),canvas);
    assert.deepEqual(await imageBounds(),compactImage);
    await panel.getByRole('button',{name:'恢复紧凑面板'}).click();
    assert.equal(await reader.locator('dialog[open],.nc-drawer-scrim').count(),0);
    await reader.screenshot({path:path.join(out,'mobile-chapter-comments.png')});
    await pages.getByRole('button',{name:'上一页'}).click();
    await panel.getByText('Comment c_7_1/d',{exact:true}).waitFor();
    await reader.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.deepEqual(await reader.locator('.nc-reading-viewport').boundingBox(),canvas);
    await reader.setViewportSize({width:1440,height:1000}); await waitImage(3);
    assert.equal(await reader.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'3');
    checks.push('Chapter comments follow release changes, suppress stale pages and spoilers, and leave mobile reading controls usable');
  }
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const directory = reader.getByRole('tab', {name: /^目录/}); if (await directory.isVisible()) await directory.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor(); await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click(); await reader.getByRole('button', {name: '返回搜索', exact: true}).click();
  await reader.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '我的漫画', exact: true}).click();
  await reader.locator('.nc-book .nc-thumbnail img').evaluate(img => img.decode());
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.getByRole('button', {name: '打开漫画 ' + imported.comics[0].title, exact: true}).click(); await waitImage(3);
  assert.equal(await reader.getByRole('slider', {name: '阅读进度', exact: true}).inputValue(), '3'); assert.equal(await refresh(), imported.entries.length);
  checks.push('Cover decode, reopen and refresh preserve page 3');
  if (!live) {failCatalog = true; const before = await state(); await assert.rejects(refresh()); assert.deepEqual((await state()).entries, before.entries);
    failCatalog = false; addChapter = true; assert.equal(await refresh(), imported.entries.length + 1); await refresh();
    assert.equal((await state()).comics[0].catalogUpdates.count, 1); checks.push('Failed refresh preserves old entries; new chapter counts once');}
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click(); await reader.getByRole('button', {name: '漫画网站', exact: true}).click();
  await reader.getByLabel('通过链接添加漫画').fill(active.sourceUrl.replace('www.', 'm.')); await reader.getByRole('button', {name: '添加到书架', exact: true}).click(); await waitImage(3);
  assert.equal((await state()).comics.length, 1); checks.push('Chapter import deduplicates and restores position');
  const site = await context.newPage(); await site.goto(active.sourceUrl, {waitUntil: 'domcontentloaded'});
  await site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor({timeout: 60000});
  await site.screenshot({path: path.join(out, 'source-entry.png')}); await site.close(); checks.push('Source page import button mounted');
  if (!live) {
    const mobile = await context.newPage(); await mobile.setViewportSize({width: 390, height: 844});
    for (const url of [fixture.catalogUrl, active.sourceUrl]) {
      await mobile.goto(url.replace('www.', 'm.'));
      await mobile.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).waitFor();
    }
    await mobile.screenshot({path: path.join(out, 'mobile-entry.png')}); await mobile.close(); checks.push('Mobile catalog and reader import entries mounted');
  }
  assert.deepEqual(errors, []); await writeFile(path.join(out, 'result.json'), JSON.stringify({live, checks, entries: imported.entries.length}, null, 2)); console.log(JSON.stringify({out, checks}));
} catch (error) {if (reader && !reader.isClosed()) {await reader.screenshot({path: path.join(out, 'failure.png')}); console.log((await reader.locator('body').innerText()).slice(-2000));}
  console.log(JSON.stringify({out, checks, errors})); throw error;
} finally {await context.close();}
