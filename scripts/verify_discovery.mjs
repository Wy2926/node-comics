// Production MV3 flow with isolated AniList/source HTTP fixtures; --live checks public AniList only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), live = process.argv.includes('--live');
const output = path.join(root, 'artifacts/discovery');
await mkdir(output, {recursive: true});
const out = await mkdtemp(path.join(output, live ? 'live-' : 'fixture-'));
const extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalogHtml,readerHtml} from '${source}/sources/sites/guazimanhua/tests/fixtures.ts';
export {listShelfIndex} from '${source}/comics/application/library-service.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'discovery-probe.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  headless: true, executablePath: process.env.TEST_CHROMIUM, viewport: {width: 1560, height: 1120}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server',
    ...live ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']],
});
context.setDefaultTimeout(20_000);
await context.addInitScript(() => {
  if (location.protocol === 'chrome-extension:') {
    localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN', appearance: 'light', language: 'en', layout: 'single', fit: 'window'}));
  }
});
const checks = [], errors = [], requests = [], sourceRequests = [];
const check = name => {checks.push(name); console.log('PASS ' + name);};
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const image = await readFile(path.join(root, 'samples/starlight-bookshop.png'));
const media = id => ({id, title: {native: `星光书店 ${id}`, english: `Starlight Bookshop ${id}`, romaji: `Hoshi ${id}`}, genres: ['Fantasy', 'Drama'], status: 'RELEASING', format: id === 2 ? 'ONE_SHOT' : 'MANGA', averageScore: 88, startDate: {year: 2026}, coverImage: {large: 'https://s4.anilist.co/fixture.png'}});
let page2Fail = true, rateLimit = false, unavailable = false, detailFail = false, slowImport = false, sourceItem = 123, catalog = '', reader = '';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
await context.route(/https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.hostname === 'graphql.anilist.co') {
    assert(!request.headers().authorization, 'Public metadata must not include the NodeLane account token');
    const body = request.postDataJSON(); requests.push(body);
    if (live) return route.continue();
    if (rateLimit) {rateLimit = false; return route.fulfill({status: 429, headers: {'Retry-After': '2'}, json: {errors: [{message: 'Fixture rate limit'}]}});}
    if (unavailable) return route.fulfill({status: 503, json: {errors: [{message: 'Fixture offline'}]}});
    if (body.variables.id) {
      if (detailFail) return route.fulfill({status: 503, body: 'Unavailable'});
      return route.fulfill({json: {data: {Media: {...media(body.variables.id), synonyms: ['星光书店'], description: 'A bookshop between worlds.\n'.repeat(15), staff: {edges: [{role: 'Story & Art', node: {name: {full: 'Fixture author'}}}]}}}}});
    }
    if (body.variables.search === 'slow') await pause(600);
    if (body.variables.page === 2 && page2Fail) {page2Fail = false; return route.fulfill({status: 503, body: 'Offline'});}
    const rows = body.variables.search === 'nothing' ? [] : Array.from({length: 24}, (_, index) => media(index + (body.variables.page === 2 ? 24 : 1)));
    return route.fulfill({json: {data: {Page: {pageInfo: {hasNextPage: body.variables.page === 1}, media: rows}}}}).catch(() => {});
  }
  if (/^(?:[a-z0-9-]+\.)?anilist\.co$/.test(url.hostname)) return live ? route.continue() : route.fulfill({contentType: 'image/png', body: image});
  if (url.hostname === 'www.guazimanhua.com') {
    sourceRequests.push(url.pathname);
    if (url.pathname === '/category.php') return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<script type="application/ld+json">${JSON.stringify({'@type': 'CollectionPage', name: '搜索：' + url.searchParams.get('keyword') + '漫画', mainEntity: {'@type': 'ItemList', numberOfItems: 1, itemListElement: [{'@type': 'ListItem', position: 1, name: '星光书店', url: 'https://www.guazimanhua.com/comic.php?id=' + sourceItem}]}})}</script><article class="card"><img class="cover" src="https://img.guazicdn.com/fixture.png"><h3><a href="/comic.php?id=${sourceItem}">星光书店</a></h3><div class="meta">Fixture author · 连载中</div></article><nav class="pager"><a class="on" href="/category.php?keyword=${encodeURIComponent(url.searchParams.get('keyword'))}">1</a></nav>`});
    if (url.pathname === '/comic.php' && slowImport) await pause(600);
    const body = url.pathname === '/chapter.php' ? reader : catalog;
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: sourceItem === 456 ? body.replaceAll('id=123', 'id=456').replaceAll('id=11', 'id=21') : body});
  }
  if (url.hostname === 'img.guazicdn.com') return route.fulfill({contentType: 'image/png', body: image});
  if (url.pathname.startsWith('/v1/')) return route.fulfill({status: 503, json: {error: {code: 'FIXTURE_OFFLINE', message: 'Isolated fixture'}}});
  return route.abort();
});

let page;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  page = await context.newPage();
  await page.goto(new URL('reader.html', worker.url()).href);
  await page.locator('.nc-library').waitFor();
  assert.equal(requests.length, 0);
  await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '发现', exact: true}).click();
  const cards = page.locator('.nc-discovery-card'), dialog = page.locator('dialog.nc-discovery-dialog[open]');
  await cards.first().waitFor();
  assert.equal(await page.locator('.nc-discovery-count strong').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 20), true);
  assert.equal(await page.locator('.nc-discovery-overview').evaluate(element => {
    const rankings = element.querySelector('.nc-discovery-rankings').getBoundingClientRect();
    const count = element.querySelector('.nc-discovery-count').getBoundingClientRect();
    return count.left >= rankings.right && count.top < rankings.bottom;
  }), true);
  assert.equal(await page.locator('.nc-discovery-controls').getByText('AniList', {exact: true}).count(), 0);
  if (live) {
    assert(requests.length >= 1);
    await cards.first().click();
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('[role=status]')].some(node => node.textContent?.includes('正在加载作品资料')));
    assert.equal(await dialog.locator('.nc-discovery-notice').count(), 0);
    await page.waitForFunction(() => {const image = document.querySelector('.nc-discovery-detail-art img'); return image?.complete && image.naturalWidth > 0;});
    assert.equal(await dialog.locator('.nc-discovery-detail-art .nc-discovery-detail-rating').count(), 0);
    assert.equal(await dialog.locator('.nc-discovery-detail-rating').getByText('AniList', {exact: true}).count(), 0);
    await dialog.locator('.nc-discovery-format').waitFor();
    assert.equal(await dialog.locator('.nc-discovery-detail-copy .nc-discovery-detail-rating b').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 64), true);
    assert.equal(await dialog.locator('.nc-discovery-detail-heading').evaluate(element => {
      const title = element.querySelector('h2').getBoundingClientRect();
      const rating = element.querySelector('.nc-discovery-detail-rating').getBoundingClientRect();
      return rating.left >= title.right && Math.abs(rating.top - title.top) < 2;
    }), true);
    await page.screenshot({path: path.join(out, 'live-detail.png')});
    await dialog.getByRole('button', {name: '关闭弹窗', exact: true}).click();
    await page.screenshot({path: path.join(out, 'live-discovery.png')});
    await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
    await page.screenshot({path: path.join(out, 'live-discovery-search.png')});
    await page.getByRole('textbox', {name: '搜索作品名称', exact: true}).press('Escape');
    await page.evaluate(() => {const value = JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings')), appearance: 'dark'}); localStorage.setItem('nc-settings', value); window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: value}));});
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await page.screenshot({path: path.join(out, 'live-discovery-dark.png')});
    await cards.first().click();
    await page.waitForFunction(() => {const image = document.querySelector('.nc-discovery-detail-art img'); return image?.complete && image.naturalWidth > 0;});
    await page.screenshot({path: path.join(out, 'live-detail-dark.png')});
    check('Live public AniList list/detail rendered inside the production extension');
  } else {
    assert.equal(await cards.count(), 24);
    assert.equal(requests.length, 1);
    await page.screenshot({path: path.join(out, 'discovery-light.png')});
    check('Navigation loads bounded public metadata; opening the library does not prefetch');
    const toolbarLayout = () => page.evaluate(() => {
      const selectors = ['.nc-discovery-overview', '.nc-discovery-count', '.nc-discovery-tools > button', '.nc-discovery-grid'];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
        const box = element.getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width, height: box.height};
      }));
    });
    for (const width of [1560, 1280, 1024]) for (const textScale of [1, 1.25]) {
      await page.setViewportSize({width, height: 1120});
      await page.evaluate(textScale => {const next = JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings')), textScale}); localStorage.setItem('nc-settings', next); window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: next}));}, textScale);
      await page.waitForFunction(textScale => parseFloat(getComputedStyle(document.documentElement).fontSize) === 16 * textScale, textScale);
      const before = await toolbarLayout();
      await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
      assert.deepEqual(await toolbarLayout(), before, `Search expansion shifted the layout at ${width}px / ${textScale}`);
      if (width === 1024 && textScale === 1.25) await page.screenshot({path: path.join(out, 'discovery-search-compact.png')});
      await page.getByRole('textbox', {name: '搜索作品名称', exact: true}).press('Escape');
      assert.deepEqual(await toolbarLayout(), before, `Search collapse shifted the layout at ${width}px / ${textScale}`);
      await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
      await page.locator('.nc-discovery-count').click();
      assert.deepEqual(await toolbarLayout(), before, `Search blur shifted the layout at ${width}px / ${textScale}`);
    }
    await page.setViewportSize({width: 1560, height: 1120});
    await page.evaluate(() => {const next = JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings')), textScale: 1}); localStorage.setItem('nc-settings', next); window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: next}));});
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).fontSize) === 16);
    check('Search expansion/collapse keeps rankings, count, tools and cards fixed across desktop widths and text sizes');
    const fixtures = await page.evaluate(async () => {const probe = await import(chrome.runtime.getURL('discovery-probe.js')); return {catalog: probe.catalogHtml(['11']), reader: probe.readerHtml()};});
    catalog = fixtures.catalog; reader = fixtures.reader;
    assert.equal(await page.getByRole('button', {name: '加载更多', exact: true}).count(), 0);
    await page.locator('.nc-discovery-pagination').scrollIntoViewIfNeeded();
    await page.getByText('AniList 暂不可用，请稍后重试。', {exact: false}).waitFor();
    assert.equal(await cards.count(), 24);
    await page.mouse.wheel(0, 100);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(requests.map(row => row.variables.page), [1, 2]);
    await page.getByRole('button', {name: '重试', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.nc-discovery-card').length === 47);
    assert.deepEqual(requests.map(row => row.variables.page), [1, 2, 2]);
    assert.equal(await page.locator('.nc-discovery-pagination').count(), 0);
    check('Lazy pagination pauses on failure, retries without duplicates and stops at the final page');
    await cards.nth(18).scrollIntoViewIfNeeded();
    const listScroll = await page.evaluate(() => window.scrollY);
    await cards.nth(18).click();
    await dialog.getByRole('button', {name: '展开简介', exact: true}).waitFor();
    const detailBounds = await dialog.boundingBox(), artBounds = await dialog.locator('.nc-discovery-detail-art').boundingBox();
    const headingBounds = await dialog.locator('.nc-discovery-detail-heading').boundingBox(), footerBounds = await dialog.locator('.nc-discovery-detail-footer').boundingBox();
    assert(detailBounds.width > 1080 && detailBounds.height > 800);
    assert.equal(await dialog.locator('.nc-discovery-format').innerText(), '漫画');
    await dialog.getByRole('button', {name: '展开简介', exact: true}).click();
    assert.equal(await dialog.getByRole('button', {name: '收起简介', exact: true}).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await dialog.boundingBox(), detailBounds);
    await dialog.locator('.nc-discovery-aliases summary').click();
    assert.deepEqual(await dialog.boundingBox(), detailBounds);
    assert.deepEqual(await dialog.locator('.nc-discovery-detail-art').boundingBox(), artBounds);
    assert.deepEqual(await dialog.locator('.nc-discovery-detail-heading').boundingBox(), headingBounds);
    assert.deepEqual(await dialog.locator('.nc-discovery-detail-footer').boundingBox(), footerBounds);
    await page.screenshot({path: path.join(out, 'discovery-detail-expanded.png')});
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).scrollIntoViewIfNeeded();
    const detailScroll = await dialog.locator('.nc-discovery-detail-body').evaluate(element => element.scrollTop);
    assert(detailScroll > 0);
    check('Only the description/aliases area scrolls; the larger dialog, cover, heading and footer stay fixed');
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).click();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(sourceRequests.length, 0);
    assert.equal(await dialog.getByRole('textbox', {name: '搜索名称', exact: true}).inputValue(), '星光书店 19');
    await dialog.getByRole('button', {name: '星光书店', exact: true}).click();
    assert.equal(sourceRequests.length, 0);
    for (const option of await dialog.locator('.nc-search-site-option').all()) {
      const input = option.locator('input');
      if (!(await option.innerText()).includes('瓜子漫画') && await input.isChecked()) await input.uncheck();
    }
    await dialog.getByRole('button', {name: '搜索网站', exact: true}).click();
    await dialog.getByRole('button', {name: '导入并阅读', exact: true}).waitFor();
    await page.screenshot({path: path.join(out, 'discovery-sources.png')});
    check('One native dialog embeds existing search; choosing titles never submits requests');
    // Import failure stays local, then a retry enters the reader and restores search on return.
    const validCatalog = catalog; catalog = '<html>Unavailable</html>';
    await dialog.getByRole('button', {name: '导入并阅读', exact: true}).click();
    await dialog.locator('.nc-search-inline-error[role=alert]').waitFor();
    catalog = validCatalog;
    await dialog.getByRole('button', {name: '导入并阅读', exact: true}).click();
    await page.locator('.nc-reader').waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.getByRole('button', {name: '返回发现', exact: true}).click();
    await dialog.getByRole('button', {name: '继续阅读', exact: true}).waitFor();
    await dialog.getByRole('button', {name: '返回作品详情', exact: true}).click();
    assert(Math.abs(await dialog.locator('.nc-discovery-detail-body').evaluate(element => element.scrollTop) - detailScroll) < 2);
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).click();
    await dialog.getByRole('button', {name: '继续阅读', exact: true}).waitFor();
    await dialog.getByRole('button', {name: '返回作品详情', exact: true}).click();
    await page.screenshot({path: path.join(out, 'discovery-detail.png')});
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await cards.nth(18).evaluate(element => element === document.activeElement), true);
    assert(Math.abs(await page.evaluate(() => window.scrollY) - listScroll) < 3);
    check('Failed import retries in place; reader return restores source results, list scroll and card focus');
    await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '我的漫画', exact: true}).click();
    await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '发现', exact: true}).click();
    assert.equal(await cards.count(), 47);
    assert(Math.abs(await page.evaluate(() => window.scrollY) - listScroll) < 3);
    await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
    const search = page.getByRole('textbox', {name: '搜索作品名称', exact: true});
    assert.equal(await search.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    assert.equal(await page.locator('.nc-discovery-search button').count(), 0);
    const beforeDraft = requests.length;
    await search.fill('unsubmitted draft');
    await page.locator('.nc-discovery-count').click();
    assert.equal(await search.count(), 0);
    assert.equal(requests.length, beforeDraft);
    await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
    assert.equal(await search.inputValue(), '');
    await search.fill('nothing'); await search.press('Enter');
    await page.getByText('没有符合条件的作品', {exact: true}).waitFor();
    await page.locator('.nc-discovery-count').click();
    assert.equal(await search.count(), 0);
    await page.getByRole('button', {name: '搜索作品名称', exact: true}).click();
    assert.equal(await search.inputValue(), 'nothing');
    await page.getByRole('button', {name: '清除搜索', exact: true}).click(); await cards.first().waitFor();
    check('Navigation retains the list session; explicit query submission and empty-state recovery work');
    await page.getByRole('button', {name: '更多筛选', exact: true}).click();
    await page.getByRole('combobox', {name: '连载状态', exact: true}).click();
    await page.getByRole('option', {name: '已完结', exact: true}).click();
    await page.getByRole('button', {name: '高分', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('.nc-discovery-grid')?.getAttribute('aria-busy') === 'false');
    assert.equal(requests.at(-1).variables.status, 'FINISHED');
    assert.equal(requests.at(-1).variables.sort[0], 'SCORE_DESC');
    await page.getByRole('button', {name: '移除筛选：连载状态', exact: true}).click();
    await page.getByRole('combobox', {name: '地区', exact: true}).click();
    await page.getByRole('option', {name: '日本', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('.nc-discovery-grid')?.getAttribute('aria-busy') === 'false');
    assert.equal(requests.at(-1).variables.country, 'JP');
    check('Ranking and filters combine; removable chips and advanced region filter send correct variables');
    rateLimit = true;
    await page.getByRole('button', {name: '刷新', exact: true}).click();
    await page.getByText('请求受限', {exact: false}).waitFor();
    assert(await page.getByRole('button', {name: /秒后重试/}).isDisabled());
    await page.getByRole('button', {name: '重试', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('.nc-discovery-notice'));
    unavailable = true;
    await page.getByRole('button', {name: '刷新', exact: true}).click();
    await page.getByText('正在显示已缓存的结果。', {exact: false}).waitFor();
    assert.equal(await cards.count(), 24);
    unavailable = false;
    await page.getByRole('button', {name: '重试', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('.nc-discovery-notice'));
    check('Rate-limit countdown gates retries and outage preserves cached cards');
    detailFail = true;
    await cards.first().click();
    await dialog.getByText('AniList 暂不可用，请稍后重试。').waitFor();
    detailFail = false;
    await dialog.getByRole('button', {name: '重试', exact: true}).click();
    await dialog.getByRole('button', {name: '展开简介', exact: true}).waitFor();
    await page.keyboard.press('Escape');
    check('Detail failure can retry independently without clearing the discovery list');
    sourceItem = 456; slowImport = true;
    await cards.nth(1).click();
    assert.equal(await dialog.locator('.nc-discovery-format').innerText(), '单篇');
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).click();
    await dialog.getByRole('button', {name: '搜索网站', exact: true}).click();
    await dialog.getByRole('button', {name: '导入并阅读', exact: true}).waitFor();
    const importRequest = context.waitForEvent('request', request => request.url().includes('/comic.php?id=456'));
    await dialog.getByRole('button', {name: '导入并阅读', exact: true}).click();
    await importRequest;
    await page.keyboard.press('Escape');
    await page.waitForFunction(async () => (await (await import(chrome.runtime.getURL('discovery-probe.js'))).listShelfIndex()).comics.length === 2);
    assert.equal(await page.locator('.nc-reader').count(), 0);
    assert.equal(await dialog.count(), 0);
    check('Closing discovery during an authorized import allows completion without late reader navigation');
    for (const appearance of ['light', 'dark']) for (const accent of ['sky', 'rose', 'mint', 'iris', 'amber', 'slate']) {
      await page.evaluate(({appearance, accent}) => {const saved = JSON.parse(localStorage.getItem('nc-settings')); const next = JSON.stringify({...saved, appearance, accentTheme: accent, textScale: 1.25}); localStorage.setItem('nc-settings', next); window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: next}));}, {appearance, accent});
      await page.waitForFunction(({appearance, accent}) => document.documentElement.dataset.appearance === appearance && document.documentElement.dataset.accent === accent, {appearance, accent});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: path.join(out, 'discovery-dark.png')});
    await cards.first().click();
    await dialog.getByRole('button', {name: '展开简介', exact: true}).waitFor();
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({path: path.join(out, 'discovery-detail-large.png')});
    await page.setViewportSize({width: 1280, height: 800});
    assert((await dialog.boundingBox()).height <= 736);
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({path: path.join(out, 'discovery-detail-small-window.png')});
    check('Six accent themes in light/dark render without horizontal overflow');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({live, checks, errors, metadataRequests: requests.length}, null, 2));
  console.log(JSON.stringify({out, checks: checks.length, errors}));
} catch (error) {
  if (page) await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  console.error('Artifacts: ' + out);
  throw error;
} finally {
  await context.close();
}
