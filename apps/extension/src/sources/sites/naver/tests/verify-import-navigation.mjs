// Synthetic NAVER SPA + isolated MV3 profile; no account, remote images or translation calls.
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), out = path.join(root, 'artifacts/naver-import-navigation');
await mkdir(out, {recursive: true});
const require = createRequire(import.meta.url), {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = await mkdtemp(path.join(out, 'extension-')), profile = await mkdtemp(path.join(out, 'profile-'));
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://comic.naver.com/*', 'https://image-comic.pstatic.net/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(profile, {headless: true, executablePath: process.env.TEST_CHROMIUM,
  viewport: {width: 1440, height: 1000}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
const catalogPath = '/webtoon/list?titleId=123', readerPath = '/webtoon/detail?titleId=123&no=1';
const sample = await readFile(path.join(root, 'apps/extension/public/samples/starlight-bookshop.png'));
const checks = [], errors = []; let failCatalog = false;
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === 'image-comic.pstatic.net') return route.fulfill({contentType: 'image/png', body: sample});
    if (url.hostname !== 'comic.naver.com') return route.abort();
    if (url.pathname === '/api/article/list/info') return route.fulfill({
      status: failCatalog ? 503 : 200, json: {titleId: 123, webtoonLevelCode: 'WEBTOON', titleName: 'NAVER SPA fixture'},
    });
    if (url.pathname === '/api/article/list') return route.fulfill({json: {
      titleId: 123, webtoonLevelCode: 'WEBTOON', sort: 'ASC', totalCount: 1,
      pageInfo: {page: 1, totalPages: 1, totalRows: 1, pageSize: 20}, articleList: [{no: 1, subtitle: 'Episode 1'}],
    }});
    if (url.pathname === '/webtoon/detail') return route.fulfill({contentType: 'text/html', body:
      `<html><head><meta property="og:title" content="Fixture"></head><body><a aria-current="true" href="${readerPath}">Episode 1</a><div id="viewerHeader"></div><div class="wt_viewer"><img id="content_image_0" src="https://image-comic.pstatic.net/webtoon/123/1/fixture.png"></div></body></html>`});
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <h1>NAVER SPA import fixture</h1><button onclick="history.pushState({},'', '${catalogPath}');document.getElementById('entry').className='EpisodeListInfo__info_area--fixture'">Open comic</button>
      <div id="entry" class="${url.pathname === '/webtoon/list' ? 'EpisodeListInfo__info_area--fixture' : ''}"></div></body></html>`});
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({'nc-reader-settings': {uiLanguage: 'zh-CN', autoTranslateTabs: false}});
    globalThis.importMessages = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message.type === 'NC_IMPORT_CURRENT') globalThis.importMessages.push({url: sender.url, tabUrl: sender.tab?.url});
    });
  });
  const source = await context.newPage();
  await source.goto('https://comic.naver.com/webtoon');
  // Query the isolated world to ensure injection happened on the original route.
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url: 'https://comic.naver.com/*'});
    await chrome.scripting.executeScript({target: {tabId: tabs[0].id}, files: ['content-scripts/content.js']});
  });
  await source.getByRole('button', {name: 'Open comic', exact: true}).click();
  const button = source.getByRole('button', {name: /NodeLane Comics/});
  await button.waitFor();
  await source.screenshot({path: path.join(out, 'before-first-click.png')});
  let opened = context.waitForEvent('page'); await button.click(); let reader = await opened;
  const waitImage = page => page.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 30000});
  await waitImage(reader);
  const messages = await worker.evaluate(() => globalThis.importMessages);
  assert.equal(messages[0].url, 'https://comic.naver.com/webtoon');
  assert.equal(messages[0].tabUrl, 'https://comic.naver.com' + catalogPath);
  assert.equal(messages.length, 1);
  checks.push('First click after pushState imports and decodes the image with a stale sender URL');
  await reader.screenshot({path: path.join(out, 'first-click-reader.png')});
  await reader.getByRole('button', {name: '返回我的漫画', exact: true}).click();
  await reader.getByRole('button', {name: '继续阅读', exact: true}).click(); await waitImage(reader);
  checks.push('Reopening the imported comic restores reading');
  await reader.close();
  await source.reload();
  opened = context.waitForEvent('page'); await button.click(); reader = await opened; await waitImage(reader);
  checks.push('Direct catalog entry still opens the comic'); await reader.close();
  failCatalog = true;
  // Use an unimported ID so the application's existing-catalog cache cannot mask the failure.
  await source.evaluate(() => history.pushState({}, '', '/webtoon/list?titleId=456'));
  await source.waitForTimeout(500);
  await button.click();
  await source.getByRole('status').filter({hasText: '目录读取失败'}).waitFor();
  await source.screenshot({path: path.join(out, 'catalog-failure.png')});
  failCatalog = false;
  await source.evaluate(path => history.pushState({}, '', path), catalogPath);
  await button.waitFor(); opened = context.waitForEvent('page'); await button.click(); reader = await opened; await waitImage(reader);
  checks.push('Failed catalog read is visible and a subsequent import succeeds');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({checks, messages, errors}, null, 2));
  console.log(JSON.stringify({checks, errors}));
} finally {await context.close();}
