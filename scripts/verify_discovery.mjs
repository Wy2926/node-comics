// Production MV3 flow with isolated AniList/source HTTP fixtures; --live checks public AniList only, --text-only focuses translation UI.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), live = process.argv.includes('--live'), textOnly = process.argv.includes('--text-only'), detailOnly = process.argv.includes('--detail-only');
const output = process.env.DISCOVERY_OUTPUT || path.join(root, 'artifacts/discovery');
await mkdir(output, {recursive: true});
const out = await mkdtemp(path.join(output, live ? 'live-' : 'fixture-'));
const extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
if (!live && !textOnly && !detailOnly) {
  const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
  const probe = path.join(extension, 'probe.js');
  await writeFile(probe, `export {catalogHtml,readerHtml} from '${source}/sources/sites/guazimanhua/tests/fixtures.ts';
export {listShelfIndex} from '${source}/comics/application/library-service.ts';`);
  const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
  await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'discovery-probe.js'}}});
}
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  headless: true, executablePath: process.env.TEST_CHROMIUM, viewport: {width: 1560, height: 1120}, reducedMotion: 'reduce', locale: 'en-US',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server',
    ...live ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']],
});
context.setDefaultTimeout(20_000);
await context.addInitScript(version => {
  if (location.protocol === 'chrome-extension:') localStorage.setItem('nc-release-notes-version', version);
  if (location.protocol === 'chrome-extension:' && !localStorage.getItem('nc-settings')) {
    localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN', appearance: 'light', language: 'en', layout: 'single', fit: 'window'}));
  }
}, JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')).version);
const checks = [], errors = [], requests = [], sourceRequests = [];
const textRequests = [];
let textActive = 0, textPeak = 0, textFail = false, textDelay = 200;
let descriptionGate;
const check = name => {checks.push(name); console.log('PASS ' + name);};
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const image = await readFile(path.join(root, 'samples/starlight-bookshop.png'));
const reviewTitle = (id, page) => `星光书店 ${id}：${page === 1 ? '把夜色留在两格之间' : '从最后一页读回开头'}`;
const reviewImages = [];
const reviewArt = 'https://review-art.example.test';
const longTitle = '穿越到星光书店之后与异世界伙伴一起寻找失落故事的漫长冒险';
const media = id => ({id, title: {native: detailOnly ? longTitle + ` ${id}` : `星光书店 ${id}`, english: `Starlight Bookshop ${id}`, romaji: `Hoshi ${id}`}, genres: ['Fantasy', 'Drama'], status: 'RELEASING', format: id === 2 ? 'ONE_SHOT' : 'MANGA', averageScore: 88, startDate: {year: detailOnly && id === 2 ? null : 2026}, coverImage: {large: 'https://s4.anilist.co/fixture.png'}});
let page2Fail = true, rateLimit = false, unavailable = false, detailFail = false, slowImport = false, sourceItem = 123, catalog = '', reader = '';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
await context.route(/https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.hostname === 'translate.googleapis.com') {
    assert.equal(request.method(), 'POST');
    assert(!request.headers().authorization && !request.headers().cookie);
    assert(!url.searchParams.has('q'));
    const text = new URLSearchParams(request.postData()).get('q'), language = url.searchParams.get('tl');
    const kind = text.startsWith('A bookshop') ? 'description' : 'title';
    textRequests.push({kind, language});
    textPeak = Math.max(textPeak, ++textActive);
    try {
      if (kind === 'description' && descriptionGate) await descriptionGate.promise;
      await pause(textDelay);
      if (textFail) return await route.fulfill({status: 429, headers: {'Retry-After': '1'}, body: ''}).catch(() => {});
      return await route.fulfill({json: [[[`译文 ${language} · ${text}`, text]], null, 'en']}).catch(() => {});
    } finally {textActive--;}
  }
  if (url.hostname === 'graphql.anilist.co') {
    assert(!request.headers().authorization, 'Public metadata must not include the NodeLane account token');
    const body = request.postDataJSON(); requests.push(body);
    if (live) return route.continue();
    if (rateLimit) {rateLimit = false; return route.fulfill({status: 429, headers: {'Retry-After': '2'}, json: {errors: [{message: 'Fixture rate limit'}]}});}
    if (unavailable) return route.fulfill({status: 503, json: {errors: [{message: 'Fixture offline'}]}});
    if (body.query.includes('query MangaReviews')) {
      const {id, page} = body.variables;
      return route.fulfill({json: {data: {Media: {...media(id), reviews: {pageInfo: {hasNextPage: page === 1},
        nodes: [{id: id * 100 + page * 2, mediaId: id, private: false, summary: reviewTitle(id, page),
          body:`<p>我最喜欢的是<strong>灯亮以前的那一格</strong>。画家让街角安静下来，下一页的对白才有了分量。</p>
            <img src="${reviewArt}/window.png" alt="书店橱窗"><h2>翻页的节奏</h2><blockquote>留白也是对白的一部分。</blockquote>
            <p>仔细看<em>窗框的影子</em>，它在读者察觉之前就交代了时间。<a href="/manga/${id}">作品资料</a></p>
            <ul><li>远景让人物显得很小</li><li>近景让停顿显得很长</li></ul><img src="${reviewArt}/detail.png" alt="画格细节">
            <p><span class="markdown_spoiler"><span>最后一格的秘密<img src="${reviewArt}/ending.png" alt="结尾插图"></span></span></p>`,
          score:83,rating:65,ratingAmount:211,createdAt:1772366400,user:{name:'纸页之间'}},
        {id:id * 100 + page * 2 + 1,mediaId:id,private:false,summary:'一场适合慢慢读的漫游',
          body:'<p>有些故事靠<strong>停顿</strong>推进，这本正是如此。</p>',score:91,rating:18,ratingAmount:23,createdAt:1772280000,user:{name:'灯下客'}}]}}}}});
    }
    if (body.query.includes('query MatchManga')) {
      const matches = [
        {...media(19),title:{native:'星光书店',english:'The Starlight Bookshop'},synonyms:['Hoshi no Shoten','星の書店'],startDate:{year:2019}},
        {...media(21),title:{native:'星光书店',english:'Starlight at the Station'},synonyms:['星の書店・海辺編'],startDate:{year:2021},
          format:'ONE_SHOT',status:'FINISHED',coverImage:{large:'https://s4.anilist.co/station.webp'}},
      ];
      const rows = body.variables.id ? matches.filter(work => work.id === body.variables.id) : body.variables.search === 'no match' ? [] : matches;
      return route.fulfill({json: {data: {Page: {media: rows}}}});
    }
    if (body.variables.id) {
      if (detailFail) return route.fulfill({status: 503, body: 'Unavailable'});
      return route.fulfill({json: {data: {Media: {...media(body.variables.id), synonyms: detailOnly ? Array.from({length: 16}, (_, index) => `${longTitle} ${index}`) : ['星光书店'], description: 'A bookshop between worlds.\n'.repeat(detailOnly ? 60 : 15), staff: {edges: [{role: 'Story & Art', node: {name: {full: 'Fixture author'}}}]}}}}});
    }
    if (body.variables.search === 'slow') await pause(600);
    if (body.variables.page === 2 && page2Fail) {page2Fail = false; return route.fulfill({status: 503, body: 'Offline'});}
    const rows = body.variables.search === 'nothing' ? [] : Array.from({length: 24}, (_, index) => media(index + (body.variables.page === 2 ? 24 : 1)));
    return route.fulfill({json: {data: {Page: {pageInfo: {hasNextPage: body.variables.page === 1}, media: rows}}}}).catch(() => {});
  }
  if (url.origin === reviewArt) {
    assert(!request.headers().referer && !request.headers().cookie);
    reviewImages.push(url.pathname);
    return route.fulfill({contentType:'image/png',headers:{'Access-Control-Allow-Origin':'*'},body:image});
  }
  if (!live && url.href === 'https://s4.anilist.co/station.webp')
    return route.fulfill({path:path.join(root,'apps/extension/tests/fixtures/translation/journey-original.webp'),contentType:'image/webp'});
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

let page, settingsPage, home;
const dictionaries = new Map();
async function label(key, target = page) {
  const language = await target.locator('html').getAttribute('lang');
  if (!dictionaries.has(language)) dictionaries.set(language, JSON.parse(await readFile(path.join(root, 'apps/extension/src/i18n/dictionaries', language + '.json'), 'utf8')));
  return dictionaries.get(language)[key] ?? key;
}
async function waitForTextPreference(target, enabled) {
  await target.waitForFunction(value => JSON.parse(localStorage.getItem('nc-settings')).discoveryTextTranslation === value, enabled);
  const saved = await target.evaluate(() => navigator.locks.request('nc-reader-settings', async () =>
    (await chrome.storage.local.get('nc-reader-settings'))['nc-reader-settings'].discoveryTextTranslation));
  assert.equal(saved, enabled);
}
async function setTextEnabled(enabled) {
  // A second settings view exercises the real storage event while discovery remains active, including cancellation.
  if (!settingsPage) {
    settingsPage = await context.newPage(); await settingsPage.goto(home);
    await settingsPage.getByRole('button', {name: await label('外观与设置', settingsPage), exact: true}).click();
  }
  await settingsPage.waitForFunction(language => document.documentElement.lang === language, await page.locator('html').getAttribute('lang'));
  const toggle = settingsPage.getByRole('switch', {name: await label('翻译书名与简介', settingsPage), exact: true});
  if (await toggle.getAttribute('aria-checked') !== String(enabled)) await toggle.click();
  await waitForTextPreference(settingsPage, enabled);
  await page.bringToFront();
  await page.waitForFunction(value => !!document.querySelector('.nc-discovery-card-entry .nc-discovery-text-status') === value, enabled);
}
const settleUi = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function checkReviewGutter(owner) {
  const list = owner.locator('.nc-comment-scroll');
  const rail = page.locator(`.nc-scrollbar-y[aria-controls="${await list.getAttribute('id')}"]`);
  await rail.waitFor();
  const edge = (await rail.boundingBox()).x;
  assert(await list.locator('.nc-comment-list').evaluate((node, x) => node.getBoundingClientRect().right <= x, edge),
    'The entire scrollbar hit area must be outside the review cards');
}
const setFixtureSettings = patch => page.evaluate(async changes => {
  const key = 'nc-reader-settings';
  await navigator.locks.request(key, async () => {
    const settings = {...(await chrome.storage.local.get(key))[key], ...changes}, next = JSON.stringify(settings);
    await chrome.storage.local.set({[key]: settings});
    localStorage.setItem('nc-settings', next);
    window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: next}));
  });
}, patch);
const setTextScale = async scale => {
  await setFixtureSettings({textScale: scale});
  await page.waitForFunction(scale => parseFloat(getComputedStyle(document.documentElement).fontSize) === 16 * scale, scale);
  await settleUi();
};
const descriptionLayout = dialog => dialog.locator('.nc-discovery-description').evaluate(element => {
  const controls = element.querySelector('.nc-discovery-description-controls'), status = controls.querySelector('.nc-discovery-text-status');
  const button = controls.querySelector(':scope > button'), paragraph = element.querySelector('p');
  const box = node => {const rect = node.getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom};};
  return {controls: box(controls), status: box(status), button: box(button), paragraph: box(paragraph),
    first: element.firstElementChild === controls, statusFits: status.scrollWidth <= status.clientWidth + 1};
});
function sameDescriptionLine(layout) {
  assert(layout.first && layout.controls.bottom <= layout.paragraph.y + 1, 'Description tools must precede its paragraph');
  assert(Math.abs(layout.status.y + layout.status.height / 2 - layout.button.y - layout.button.height / 2) < 2, 'Translation status and expansion must share one line');
  assert(layout.statusFits && layout.status.right <= layout.button.x + 1 && layout.button.right <= layout.controls.right + 1, 'Description tools must fit without overlap or overflow');
}
function fixedDescriptionTools(before, after) {
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(before.controls[key] - after.controls[key]) < 1, `Description tool row ${key} moved: ${JSON.stringify({before, after})}`);
  for (const key of ['x', 'y']) assert(Math.abs(before.status[key] - after.status[key]) < 1, `Translation status ${key} moved: ${JSON.stringify({before, after})}`);
  for (const key of ['right', 'y']) assert(Math.abs(before.button[key] - after.button[key]) < 1, `Description expansion ${key} moved: ${JSON.stringify({before, after})}`);
}
async function checkDescriptionExpansion(dialog) {
  const tools = dialog.locator('.nc-discovery-description-controls'), before = await descriptionLayout(dialog); sameDescriptionLine(before);
  await tools.locator(':scope > button').click(); await settleUi();
  const expanded = await descriptionLayout(dialog); sameDescriptionLine(expanded); fixedDescriptionTools(before, expanded);
  await tools.locator(':scope > button').click(); await settleUi(); fixedDescriptionTools(before, await descriptionLayout(dialog));
  return before;
}
async function checkInlineAction(dialog, action) {
  await dialog.getByRole('button', {name: '关闭弹窗', exact: true}).focus(); await page.mouse.move(5, 5);
  const styles = () => action.evaluate(element => {
    const value = getComputedStyle(element), text = getComputedStyle(element.querySelector('span'));
    return {background: value.backgroundColor, borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => value['border' + side + 'Width']),
      color: value.color, decoration: text.textDecorationLine, decorationColor: text.textDecorationColor,
      decorationThickness: text.textDecorationThickness, focus: element.matches(':focus-visible')};
  });
  const before = await styles(), box = await action.boundingBox();
  assert.equal(before.background, 'rgba(0, 0, 0, 0)'); assert(before.borders.every(width => width === '0px'));
  await action.hover();
  await settleUi();
  const hover = await styles();
  assert.notEqual(hover.color, before.color); assert(hover.decoration.includes('underline')); assert.notEqual(hover.decorationColor, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(await action.boundingBox(), box, 'Hover must not move a text action');
  await page.mouse.move(5, 5); await page.keyboard.press('Tab'); await action.focus(); await settleUi();
  const focus = await styles(); assert(focus.focus && focus.decoration.includes('underline'));
  assert.notEqual(focus.color, before.color); assert.notEqual(focus.decorationColor, 'rgba(0, 0, 0, 0)'); assert(parseFloat(focus.decorationThickness) >= 2);
  assert.deepEqual(await action.boundingBox(), box, 'Keyboard focus must not move a text action');
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  page = await context.newPage();
  home = new URL('reader.html', worker.url()).href; await page.goto(home);
  await page.locator('.nc-library').waitFor();
  assert.equal(requests.length, 0);
  await page.getByRole('button', {name: '外观与设置', exact: true}).click();
  const initialTextToggle = page.getByRole('switch', {name: '翻译书名与简介', exact: true});
  await initialTextToggle.waitFor(); assert.equal(await initialTextToggle.getAttribute('aria-checked'), 'true');
  assert.equal(await initialTextToggle.locator('..').getByRole('combobox').count(), 0);
  await page.locator('.nc-preferences > .settings-card').first().screenshot({path: path.join(out, 'discovery-text-settings-default-on.png')});
  await initialTextToggle.click();
  await waitForTextPreference(page, false);
  await page.reload(); await page.locator('.nc-preferences').waitFor();
  assert.equal(await initialTextToggle.getAttribute('aria-checked'), 'false');
  await page.locator('.nc-preferences > .settings-card').first().screenshot({path: path.join(out, 'discovery-text-settings-persisted-off.png')});
  check('Legacy preferences default discovery text translation on; the settings switch persists off after reload without a separate target selector');
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
  if (detailOnly) {
    await cards.first().click();
    await dialog.getByRole('button', {name: '展开简介', exact: true}).waitFor();
    const titleTools = dialog.locator('.nc-discovery-detail-identity .nc-discovery-text-status');
    const descriptionTools = dialog.locator('.nc-discovery-description-controls');
    assert.equal(await titleTools.getByRole('button', {name: '翻译', exact: true}).count(), 1, 'Settings-off must retain manual title translation');
    assert.equal(await descriptionTools.getByRole('button', {name: '翻译', exact: true}).count(), 1, 'Settings-off must retain manual description translation');
    assert.equal(textRequests.length, 0, 'Opening details with auto translation off must not request text');
    // A failed attempt in a previous language visit must not swallow an explicit new request.
    textFail = true;
    await titleTools.getByRole('button', {name: '翻译', exact: true}).click();
    await titleTools.getByText('文字翻译失败', {exact: true}).waitFor();
    assert.equal(textRequests.length, 1);
    for (const uiLanguage of ['fr', 'zh-CN']) {
      await setFixtureSettings({uiLanguage});
      await page.waitForFunction(language => document.documentElement.lang === language, uiLanguage);
    }
    assert.equal(textRequests.length, 1, 'Language changes with automatic translation off must not issue requests');
    textFail = false;
    await titleTools.getByRole('button', {name: '翻译', exact: true}).click();
    await pause(500);
    assert.equal(textRequests.length, 2, 'Manual translation after a failed language round trip must issue a fresh request');
    await titleTools.getByRole('button', {name: '查看原文', exact: true}).waitFor();
    assert((await dialog.locator('h2').innerText()).startsWith('译文 zh-CN'));
    assert.deepEqual(textRequests.map(row => row.kind), ['title', 'title'], 'A manual title request must not also translate the description or cards');
    await descriptionTools.getByRole('button', {name: '翻译', exact: true}).click();
    await descriptionTools.getByRole('button', {name: '查看原文', exact: true}).waitFor();
    assert.deepEqual(textRequests.map(row => row.kind), ['title', 'title', 'description']);
    for (const tools of [titleTools, descriptionTools]) {
      await tools.getByRole('button', {name: '查看原文', exact: true}).click();
      await tools.getByRole('button', {name: '查看译文', exact: true}).click();
    }
    assert.equal(textRequests.length, 3, 'Original/translated toggles must reuse the completed result');
    check('Settings-off retains independent manual title/description translation and cached original toggles');
    for (const width of [1560, 1280, 700, 390, 320]) {
      await page.setViewportSize({width, height: width >= 1280 ? 1120 : 740});
      await setTextScale(1.25);
      await dialog.locator('h2').scrollIntoViewIfNeeded(); await settleUi();
      const heading = await dialog.locator('.nc-discovery-detail-heading').boundingBox(), score = await dialog.locator('.nc-discovery-detail-rating').boundingBox();
      assert(Math.abs(score.y - heading.y) < 2 && Math.abs(score.x + score.width - heading.x - heading.width) < 2, `Score must remain at the heading's top right at ${width}px`);
      assert.equal(await dialog.locator('.nc-discovery-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      if (width <= 700) {
        const titleAction = await titleTools.boundingBox(), year = await dialog.locator('time').boundingBox();
        assert(titleAction.x >= year.x + year.width && titleAction.y < year.y + year.height && titleAction.y + titleAction.height > year.y, 'Mobile title translation action must sit beside the actual year');
      }
      if (width === 390 || width === 1560) await page.screenshot({path: path.join(out, `detail-heading-${width}.png`)});
      const footerPosition = () => dialog.evaluate(element => element.querySelector('.nc-discovery-detail-footer').getBoundingClientRect().top + element.querySelector('.nc-discovery-detail-copy').scrollTop + element.querySelector('.nc-discovery-detail').scrollTop);
      const before = await footerPosition(), beforeBounds = await dialog.locator('.nc-discovery-detail-footer').boundingBox();
      await descriptionTools.getByRole('button', {name: '展开简介', exact: true}).click();
      await dialog.locator('.nc-discovery-aliases summary').click();
      const bounds = await dialog.evaluate(element => {
        const box = selector => {const node = element.querySelector(selector), rect = node.getBoundingClientRect(); return {top: rect.top, bottom: rect.bottom, height: rect.height};};
        return {description: box('.nc-discovery-description'), aliases: box('.nc-discovery-aliases'), body: box('.nc-discovery-detail-body'), footer: box('.nc-discovery-detail-footer')};
      });
      if (width <= 700) {
        assert(bounds.aliases.top >= bounds.description.bottom - 1 && bounds.footer.top >= bounds.aliases.bottom - 1, `Expanded content must not overlap aliases or footer at ${width}px`);
        assert(bounds.body.height > 1500 && await footerPosition() > before + 1000, `Mobile long content must grow naturally and push the footer down at ${width}px: ${JSON.stringify(bounds)}`);
      } else {
        assert.deepEqual(await dialog.locator('.nc-discovery-detail-footer').boundingBox(), beforeBounds, 'Desktop footer stays fixed while only description/aliases scroll');
        assert(await dialog.locator('.nc-discovery-detail-body').evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto'));
      }
      await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).scrollIntoViewIfNeeded();
      const footer = await dialog.locator('.nc-discovery-detail-footer').boundingBox(), viewport = await dialog.boundingBox();
      assert(footer.y >= viewport.y && footer.y < viewport.y + viewport.height, 'Footer must be reachable by scrolling');
      if (width === 390 || width === 1560) await page.screenshot({path: path.join(out, `detail-expanded-footer-${width}.png`)});
      const scrollBefore = await dialog.evaluate(element => [...element.querySelectorAll('*')].filter(node => node.scrollTop > 0).map(node => ({className: node.className, top: node.scrollTop})));
      await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).click();
      assert.equal(await dialog.getByRole('textbox', {name: '搜索名称', exact: true}).inputValue(), longTitle + ' 1');
      await dialog.getByRole('button', {name: '返回作品详情', exact: true}).click();
      assert.deepEqual(await dialog.evaluate(element => [...element.querySelectorAll('*')].filter(node => node.scrollTop > 0).map(node => ({className: node.className, top: node.scrollTop}))), scrollBefore, 'Returning from source search must restore detail scrolling');
      await dialog.locator('.nc-discovery-aliases summary').click();
      await descriptionTools.getByRole('button', {name: '收起简介', exact: true}).click();
    }
    check('Mobile 320–700px long titles keep scores top-right and actions beside the year; long descriptions/aliases grow naturally; desktop 1280/1560px retains its fixed footer at 125% text scale');
    for (const uiLanguage of ['de', 'ru']) {
      await setFixtureSettings({uiLanguage});
      await page.waitForFunction(language => document.documentElement.lang === language, uiLanguage);
      textFail = true; textDelay = 800;
      await titleTools.getByRole('button', {name: await label('翻译'), exact: true}).click();
      await titleTools.getByText(await label('翻译中…'), {exact: true}).waitFor();
      assert(await dialog.locator('.nc-discovery-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Long ${uiLanguage} pending labels must fit the mobile detail`);
      await titleTools.getByText(await label('文字翻译失败'), {exact: true}).waitFor();
      assert(await dialog.locator('.nc-discovery-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Long ${uiLanguage} failure/retry labels must fit the mobile detail`);
      textFail = false; textDelay = 200;
      await titleTools.getByRole('button', {name: await label('重试'), exact: true}).click();
      await titleTools.getByRole('button', {name: await label('查看原文'), exact: true}).click();
      await titleTools.getByRole('button', {name: await label('查看译文'), exact: true}).waitFor();
      assert(await dialog.locator('.nc-discovery-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Long ${uiLanguage} original/translation controls must not cause mobile horizontal scrolling`);
      assert(await dialog.locator('.nc-discovery-format > span').evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) * 2), 'Publication labels must use their own wrapping row, not squeeze into the year/action columns');
      await dialog.locator('h2').scrollIntoViewIfNeeded(); await settleUi();
      if (uiLanguage === 'de') await page.screenshot({path: path.join(out, 'detail-german-320.png')});
    }
    check('German and Russian pending, failure/retry and original/translated controls wrap within the 320px mobile detail at 125% text scale');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert(await cards.first().evaluate(element => element === document.activeElement));
    await page.setViewportSize({width: 390, height: 740});
    await setFixtureSettings({uiLanguage: 'zh-CN'});
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await cards.nth(1).click();
    await descriptionTools.getByRole('button', {name: '翻译', exact: true}).waitFor();
    assert.equal(await dialog.locator('time').count(), 0);
    assert.equal(await titleTools.getByRole('button', {name: '翻译', exact: true}).count(), 1, 'Missing year must not hide the title translation action');
    descriptionGate = Promise.withResolvers();
    // Use a fresh target language so the description cannot hit the completed zh-CN cache.
    await setFixtureSettings({uiLanguage: 'en'});
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await descriptionTools.getByRole('button', {name: await label('翻译'), exact: true}).click();
    await descriptionTools.getByText(await label('翻译中…'), {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    descriptionGate.resolve(); descriptionGate = undefined;
    await pause(300);
    const closedRequests = textRequests.length;
    await cards.nth(1).click();
    await descriptionTools.getByRole('button', {name: await label('翻译'), exact: true}).waitFor();
    assert.equal(textRequests.length, closedRequests, 'Reopening with automatic translation off must not restart a cancelled manual request');
    assert((await dialog.locator('.nc-discovery-description p').innerText()).startsWith('A bookshop'));
    assert.equal(await dialog.locator('[role=status]').count(), 0, 'Cancelled requests must not leave stale pending or failure UI');
    await page.keyboard.press('Escape');
    check('Missing years preserve manual controls; closing a pending manual translation ignores late responses and reopening does not auto-request');
  } else if (live) {
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
    await setFixtureSettings({appearance: 'dark'});
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
    if (!textOnly) {
    const toolbarLayout = () => page.evaluate(() => {
      const selectors = ['.nc-discovery-overview', '.nc-discovery-count', '.nc-discovery-tools > button', '.nc-discovery-grid'];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
        const box = element.getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width, height: box.height};
      }));
    });
    for (const width of [1560, 1280, 1024]) for (const textScale of [1, 1.25]) {
      await page.setViewportSize({width, height: 1120});
      await setTextScale(textScale);
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
    await setTextScale(1);
    check('Search expansion/collapse keeps rankings, count, tools and cards fixed across desktop widths and text sizes');
    const fixtures = await page.evaluate(async () => {const probe = await import(chrome.runtime.getURL('discovery-probe.js')); return {catalog: probe.catalogHtml(['11']), reader: probe.readerHtml()};});
    catalog = fixtures.catalog.replaceAll('Fixture comic', '星光书店'); reader = fixtures.reader;
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
    await dialog.getByText('所选阅读来源将关联到 AniList 的《星光书店 19》。', {exact:true}).waitFor();
    assert.equal(sourceRequests.length, 0);
    await dialog.locator('.nc-search-scope-trigger').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 1, 'Scope Escape must not close the discovery dialog');
    await dialog.locator('.nc-search-scope-expand').click();
    await dialog.getByRole('button', {name: '反选', exact: true}).click();
    await dialog.getByRole('checkbox', {name: '瓜子漫画', exact: true}).check();
    await dialog.locator('.nc-search-scope-expand').click();
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
    const reviewIds = () => requests.filter(row => row.query.includes('query MangaReviews')).map(row => [row.variables.id, row.variables.page]);
    assert.deepEqual(reviewIds(), []);
    const tool = page.locator('.nc-reader-rail.right').getByRole('button', {name:'评论', exact:true});
    const viewport = page.locator('.nc-reading-viewport');
    await viewport.locator('img.nc-page-image').first().evaluate(img => img.decode());
    const geometry = () => viewport.evaluate(v => [v.getBoundingClientRect().toJSON(),v.querySelector('img.nc-page-image').getBoundingClientRect().toJSON(),v.scrollTop,v.scrollLeft]);
    const original = await geometry();
    await tool.click();
    const links = page.getByRole('complementary', {name: '评论', exact: true});
    await links.getByText(reviewTitle(19,1), {exact:true}).waitFor();
    const first = links.locator('.nc-review-card').first(), lead = first.locator('.nc-review-cover'), headline = first.getByRole('heading',{name:reviewTitle(19,1)});
    await page.waitForFunction(() => document.querySelector('.nc-review-cover img')?.naturalWidth > 0);
    assert.deepEqual(await geometry(),original);
    assert.equal(await first.getByRole('meter',{name:'作者评分'}).getAttribute('aria-valuenow'),'83');
    await first.getByText('211 位读者中有 65 位喜欢这篇书评',{exact:true}).waitFor();
    assert.deepEqual(reviewImages,['/window.png']);
    assert.equal(await first.locator('.nc-review-excerpt strong').first().innerText(),'灯亮以前的那一格');
    assert.equal(await links.getByRole('button',{name:'本章评论'}).count(),0);
    assert.equal(await page.locator('dialog[open],.nc-drawer-scrim').count(), 0);
    const dock = await links.boundingBox();
    assert(dock.width <= 352 && (await headline.boundingBox()).y > (await lead.boundingBox()).y);
    await page.screenshot({path:path.join(out,'reader-review-rail.png')});
    await links.getByRole('button',{name:'展开评论面板'}).click();
    assert((await links.boundingBox()).width > dock.width + 100);
    assert((await headline.boundingBox()).x >= (await lead.boundingBox()).x + (await lead.boundingBox()).width);
    assert.deepEqual(await geometry(),original);
    await page.screenshot({path:path.join(out,'reader-review-wide.png')});
    await first.getByRole('button',{name:'展开全文'}).click();
    const article = first.locator('> .nc-review-prose');
    await article.getByRole('heading',{name:'翻页的节奏'}).waitFor();
    await checkReviewGutter(links);
    await article.getByRole('img',{name:'画格细节'}).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.nc-review-prose img[alt="画格细节"]')?.naturalWidth > 0);
    assert(!reviewImages.includes('/ending.png'));
    await article.getByRole('button',{name:'显示剧透'}).click();
    await article.getByText('最后一格的秘密',{exact:true}).waitFor();
    await article.getByRole('button',{name:'隐藏剧透'}).click();
    await first.getByRole('button',{name:'收起全文'}).click();
    assert.deepEqual(await geometry(),original);
    await links.getByRole('button',{name:'恢复紧凑面板'}).click();
    await links.getByRole('button', {name: '下一页'}).click();
    await links.getByText(reviewTitle(19,2), {exact: true}).waitFor();
    await links.getByRole('button', {name: '上一页'}).click();
    await links.getByText(reviewTitle(19,1), {exact: true}).waitFor();
    assert.deepEqual(reviewIds(), [[19, 1], [19, 2]]);
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(() => document.querySelector('.nc-reading-viewport img.nc-page-image').getBoundingClientRect().width <= innerWidth);
    const phone = await geometry();
    await links.getByRole('button',{name:'展开评论面板'}).click();
    await first.getByRole('button',{name:'展开全文'}).click();
    await article.getByRole('heading',{name:'翻页的节奏'}).waitFor();
    assert(await article.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.deepEqual(await geometry(),phone);
    await page.waitForFunction(() => document.querySelector('.nc-review-prose img[alt="书店橱窗"]')?.naturalWidth > 0);
    await page.screenshot({path:path.join(out,'reader-review-phone-article.png')});
    await links.getByRole('button', {name: '关闭面板'}).click();
    assert(await tool.evaluate(button => button === document.activeElement));
    assert.deepEqual(await geometry(),phone);
    await page.setViewportSize({width:1560,height:1120});
    check('Reviewer scores, vote tallies, safe illustrations and inline articles reflow across panel widths without moving the manga');
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
    await page.locator('.nc-shelf-grid .nc-book').first().getByRole('button', {name:/ · 评论$/}).click();
    await links.getByText(reviewTitle(19,1), {exact: true}).waitFor();
    const masthead = await page.locator('.nc-app-header').boundingBox();
    assert((await links.boundingBox()).y >= masthead.y + masthead.height);
    const changeLink = links.getByRole('button', {name:'更换关联'}), field = links.getByRole('searchbox');
    const savedLink = () => page.evaluate(async () => (await (await import(chrome.runtime.getURL('discovery-probe.js'))).listShelfIndex()).comics[0].workLinks.anilist);
    const searches = () => requests.filter(row => row.query.includes('query MatchManga')).length;
    await changeLink.click();
    assert(await field.evaluate(input => input === document.activeElement));
    assert.equal(await field.inputValue(),'星光书店');
    await field.fill('no match'); assert.equal(searches(),0);
    await field.press('Enter'); await links.getByText('试试其他译名，或粘贴作品链接。').waitFor();
    await links.getByRole('button',{name:'取消'}).click();
    assert(await changeLink.evaluate(button => button === document.activeElement)); assert.equal(await savedLink(),'19');
    await changeLink.click();
    await field.press('Enter');
    const candidates = links.locator('.nc-work-matches article');
    await candidates.nth(1).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.nc-match-cover img')].filter(img => img.naturalWidth > 0).length === 2);
    assert.equal(await candidates.first().getAttribute('aria-current'),'true');
    assert.equal(await candidates.nth(1).getByRole('link').getAttribute('href'),'https://anilist.co/manga/21');
    const cardBoxes = () => candidates.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    let [a,b] = await cardBoxes();
    assert(b.y >= a.bottom && b.x === a.x);
    await links.screenshot({path:path.join(out,'work-link-compact.png')});
    await links.getByRole('button',{name:'展开评论面板'}).click();
    [a,b] = await cardBoxes(); assert(b.x >= a.right && b.y === a.y);
    await candidates.first().locator('summary').press('Enter');
    await candidates.first().getByText('星の書店',{exact:true}).waitFor();
    await links.screenshot({path:path.join(out,'work-link-wide.png')});
    await candidates.first().locator('summary').press('Enter');
    await page.setViewportSize({width:390,height:844});
    await setFixtureSettings({appearance:'dark'});
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await links.getByRole('button',{name:'恢复紧凑面板'}).click();
    await field.fill('Starlight'); await field.press('Enter'); await candidates.nth(1).waitFor();
    assert(await links.locator('.nc-work-matches').evaluate(section => {
      const bounds = section.parentElement.getBoundingClientRect(), heading = section.querySelector('h4').getBoundingClientRect();
      const search = section.parentElement.querySelector('form').getBoundingClientRect();
      return search.top >= bounds.top - 1 && heading.top >= search.bottom + 3 && heading.bottom + 40 < bounds.bottom;
    }));
    await links.getByRole('button',{name:'展开评论面板'}).click();
    [a,b] = await cardBoxes(); assert(b.y >= a.bottom && b.x === a.x);
    assert(await links.locator('.nc-link-editor').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({path:path.join(out,'work-link-mobile.png')});
    assert.equal(searches(),3); assert.equal(await savedLink(),'19');
    assert.deepEqual(reviewIds(), [[19, 1], [19, 2]]);
    await candidates.filter({hasText: '2021'}).getByRole('button', {name: '关联此作品'}).click();
    await links.getByText(reviewTitle(21,1), {exact: true}).waitFor();
    assert.equal(await links.getByText(reviewTitle(19,1), {exact: true}).count(), 0);
    assert.equal(await savedLink(),'21');
    await changeLink.click();
    await links.getByRole('button', {name: '解除关联'}).click();
    await links.getByText('尚未关联',{exact:true}).waitFor();
    await field.fill('id:21'); await field.press('Enter');
    await candidates.first().waitFor();
    assert.equal(await candidates.count(),1); assert.equal(await savedLink(),null);
    await links.getByRole('button', {name: '关闭面板'}).click();
    await page.setViewportSize({width:1560,height:1120});
    await setFixtureSettings({appearance:'light'});
    check('Title matching keeps the shelf identity in view; keyboard lookup, namesake comparison, explicit replacement and unlink work in compact, wide and mobile layouts');
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
    await dialog.getByRole('button', {name: '展开简介', exact: true}).click();
    const reviewButton = dialog.getByRole('button', {name:'作品评论', exact:true});
    const reviews = dialog.getByRole('region', {name:'作品评论', exact:true});
    for (const size of [{width:1560,height:1120},{width:1280,height:720},{width:390,height:740}]) {
      await page.setViewportSize(size); await settleUi();
      const detail = dialog.locator(size.width > 700 ? '.nc-discovery-detail-body' : '.nc-discovery-detail');
      const top = await detail.evaluate(node => {node.scrollTop = 64; return node.scrollTop;});
      assert(top > 0);
      const bounds = await dialog.boundingBox(), cover = dialog.locator('.nc-discovery-detail-art');
      await reviewButton.click();
      await reviews.getByRole('heading', {name:reviewTitle(1,1)}).waitFor();
      assert(await dialog.evaluate(node => node.matches(':modal')));
      assert.equal(await page.locator('.nc-comments-panel').count(),0);
      assert.deepEqual(await dialog.boundingBox(),bounds);
      assert(await cover.isVisible() && await dialog.getByRole('heading',{name:'星光书店 1',exact:true}).isVisible());
      const feed = await reviews.boundingBox(), art = await cover.boundingBox();
      assert(size.width > 700 ? feed.x >= art.x + art.width && feed.height > bounds.height * .75 : feed.y >= art.y + art.height && feed.width > bounds.width * .85);
      await page.waitForFunction(() => document.querySelector('.nc-discovery-reviews .nc-review-cover img')?.naturalWidth > 0);
      await page.screenshot({path:path.join(out,`discovery-reviews-${size.width}.png`)});
      if (size.width === 1280) {
        for (const width of [844, 1440]) {
          await page.setViewportSize({width,height:390}); await settleUi();
          const sheet = await dialog.boundingBox(), pager = await reviews.getByRole('navigation').boundingBox(), art = await cover.boundingBox();
          assert((await reviews.boundingBox()).x >= art.x + art.width - 1, 'A short desktop keeps reviews beside the cover');
          assert(pager.y + pager.height <= sheet.y + sheet.height, 'Pagination must remain reachable in a short window');
        }
        await page.setViewportSize(size); await settleUi();
      }
      await reviews.getByRole('button',{name:'展开全文'}).click();
      await checkReviewGutter(reviews);
      await reviews.getByRole('button',{name:'下一页'}).click();
      await reviews.getByRole('heading',{name:reviewTitle(1,2)}).waitFor();
      await page.keyboard.press('Escape');
      assert(await reviewButton.evaluate(button => button === document.activeElement));
      assert.equal(await detail.evaluate(node => node.scrollTop),top);
    }
    await page.setViewportSize({width:1560,height:1120});
    check('Reviews share the open work dialog, reserve their scrollbar gutter and restore details on desktop and phone');
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
    const importDeadline = Date.now() + 20_000;
    while (!await page.evaluate(async () => (await (await import(chrome.runtime.getURL('discovery-probe.js'))).listShelfIndex()).comics.length === 2)) {
      assert(Date.now() < importDeadline, 'The authorized background import must finish');
      await pause(50);
    }
    assert.equal(await page.locator('.nc-reader').count(), 0);
    assert.equal(await dialog.count(), 0);
    check('Closing discovery during an authorized import allows completion without late reader navigation');
    }
    assert.equal(textRequests.length, 0, 'The disabled settings preference prevents all text translation requests');
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.locator('.nc-discovery-text-controls').count(), 0);
    await setTextEnabled(true);
    await page.getByText('翻译中…', {exact: true}).first().waitFor();
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card h2')?.textContent.startsWith('译文 zh-CN'));
    await page.waitForFunction(() => ![...document.querySelectorAll('.nc-discovery-card-entry [role=status]')].some(node => node.textContent.includes('翻译中')));
    assert.equal(textPeak, 2);
    assert(textRequests.length < 24, 'Only visible titles are translated');
    const firstEntry = page.locator('.nc-discovery-card-entry').first(), beforeOriginal = textRequests.length;
    await firstEntry.getByRole('button', {name: '查看原文', exact: true}).click();
    assert.equal(await cards.first().locator('h2').innerText(), '星光书店 1');
    await firstEntry.getByRole('button', {name: '查看译文', exact: true}).click();
    assert.equal(textRequests.length, beforeOriginal);
    await page.screenshot({path: path.join(out, 'discovery-translated-titles.png')});
    descriptionGate = Promise.withResolvers();
    await cards.first().click();
    await dialog.locator('.nc-discovery-description').getByText('翻译中…', {exact: true}).waitFor();
    const pendingLayouts = new Map();
    for (const width of [1560, 1280]) for (const scale of [1, 1.25]) {
      await page.setViewportSize({width, height: 1120}); await setTextScale(scale);
      assert.equal(await dialog.locator('.nc-discovery-description-controls').getByText('翻译中…', {exact: true}).count(), 1);
      pendingLayouts.set(width + ':' + scale, await checkDescriptionExpansion(dialog));
      if (scale === 1.25) await page.screenshot({path: path.join(out, `discovery-description-pending-${width}.png`)});
    }
    descriptionGate.resolve(); descriptionGate = undefined;
    await dialog.locator('.nc-discovery-description').getByRole('button', {name: '查看原文', exact: true}).waitFor();
    assert((await dialog.locator('.nc-discovery-description p').innerText()).startsWith('译文 zh-CN'));
    for (const width of [1560, 1280]) for (const scale of [1, 1.25]) {
      await page.setViewportSize({width, height: 1120}); await setTextScale(scale);
      const translated = await checkDescriptionExpansion(dialog);
      fixedDescriptionTools(pendingLayouts.get(width + ':' + scale), translated);
      await dialog.locator('.nc-discovery-description-controls').getByRole('button', {name: '查看原文', exact: true}).click();
      sameDescriptionLine(await descriptionLayout(dialog)); fixedDescriptionTools(translated, await descriptionLayout(dialog));
      await dialog.locator('.nc-discovery-description-controls').getByRole('button', {name: '查看译文', exact: true}).click();
      fixedDescriptionTools(translated, await descriptionLayout(dialog));
    }
    await page.setViewportSize({width: 1560, height: 1120}); await setTextScale(1);
    const descriptionControls = dialog.locator('.nc-discovery-description-controls');
    await checkInlineAction(dialog, descriptionControls.getByRole('button', {name: '查看原文', exact: true}));
    await checkInlineAction(dialog, dialog.getByRole('link', {name: '在 AniList 查看', exact: true}));
    const detailTextRequests = textRequests.length, translatedScroll = await dialog.locator('.nc-discovery-detail-body').evaluate(element => element.scrollTop);
    await dialog.locator('.nc-discovery-description').getByRole('button', {name: '查看原文', exact: true}).click();
    assert((await dialog.locator('.nc-discovery-description p').innerText()).startsWith('A bookshop'));
    await dialog.locator('.nc-discovery-description').getByRole('button', {name: '查看译文', exact: true}).click();
    assert.equal(textRequests.length, detailTextRequests);
    assert.equal(await dialog.locator('.nc-discovery-detail-body').evaluate(element => element.scrollTop), translatedScroll);
    await page.screenshot({path: path.join(out, 'discovery-translated-detail.png')});
    await dialog.getByRole('button', {name: '查找阅读来源', exact: true}).click();
    assert.equal(await dialog.getByRole('textbox', {name: '搜索名称', exact: true}).inputValue(), '星光书店 1');
    await dialog.getByRole('button', {name: '返回作品详情', exact: true}).click();
    await page.keyboard.press('Escape');
    const beforeReopen = textRequests.length;
    await cards.first().click();
    await dialog.locator('.nc-discovery-description').getByRole('button', {name: '查看原文', exact: true}).waitFor();
    assert.equal(textRequests.length, beforeReopen);
    await page.keyboard.press('Escape');
    check('The saved settings switch enables visible titles and detail description with two slots, original toggle and exact-input cache');
    check('Description pending, translated and original controls share a fixed row above the paragraph at 1560/1280 widths and 100/125 percent text size');
    check('Original toggles and the AniList link are unboxed text actions with hover/keyboard feedback and stable geometry');
    textFail = true;
    const setUiLanguage = uiLanguage => setFixtureSettings({uiLanguage});
    await setUiLanguage('ja');
    await page.waitForFunction(() => document.documentElement.lang === 'ja');
    await page.getByText('テキストの翻訳に失敗しました', {exact: true}).first().waitFor();
    await firstEntry.getByRole('button', {name: /Retry in .* seconds/}).waitFor();
    assert(await firstEntry.getByRole('button', {name: /Retry in .* seconds/}).isDisabled());
    assert.equal(await cards.first().locator('h2').innerText(), '星光书店 1');
    textFail = false;
    await firstEntry.getByRole('button', {name: 'もう一度試してください', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card h2')?.textContent.startsWith('译文 ja'));
    await setTextEnabled(false);
    assert.equal(await cards.first().locator('h2').innerText(), '星光书店 1');
    textDelay = 600;
    await setUiLanguage('auto');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.evaluate(() => navigator.language), 'en-US');
    await setTextEnabled(true);
    await page.getByText('Translating…', {exact: true}).first().waitFor();
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card h2')?.textContent.startsWith('译文 en'));
    assert.equal(textRequests.at(-1).language, 'en');
    await setTextEnabled(false);
    textFail = true; textDelay = 200;
    await setUiLanguage('fr');
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    await setTextEnabled(true);
    await firstEntry.getByText('Échec de la traduction du texte', {exact: true}).waitFor();
    await cards.first().click();
    await dialog.locator('.nc-discovery-description-controls').getByText('Échec de la traduction du texte', {exact: true}).waitFor();
    await page.setViewportSize({width: 1280, height: 800}); await setTextScale(1.25);
    await checkDescriptionExpansion(dialog);
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({path: path.join(out, 'discovery-description-failure-fr-small.png')});
    await page.keyboard.press('Escape');
    await page.setViewportSize({width: 1560, height: 1120}); await setTextScale(1);
    textFail = false;
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card-entry .nc-discovery-text-status button')?.disabled === false);
    await setTextEnabled(false);
    await setUiLanguage('auto');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await setTextEnabled(true);
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card h2')?.textContent.startsWith('译文 en'));
    await setTextEnabled(false);
    await setUiLanguage('fr');
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    await setTextEnabled(true);
    await page.waitForFunction(() => document.querySelector('.nc-discovery-card h2')?.textContent.startsWith('译文 fr'));
    await setTextEnabled(false);
    textDelay = 600;
    await setUiLanguage('zh-TW');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
    await setTextEnabled(true);
    await page.getByText('翻譯中…', {exact: true}).first().waitFor();
    await setTextEnabled(false);
    await pause(700);
    assert.equal(await cards.first().locator('h2').innerText(), '星光书店 1');
    assert.equal(await page.getByText('翻譯中…', {exact: true}).count(), 0);
    const disabledRequests = textRequests.length;
    await settingsPage.reload(); await settingsPage.locator('.nc-preferences').waitFor();
    assert.equal(await settingsPage.getByRole('switch', {name: await label('翻译书名与简介', settingsPage), exact: true}).getAttribute('aria-checked'), 'false');
    await pause(250); assert.equal(textRequests.length, disabledRequests);
    await setUiLanguage('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    check('Text follows UI/browser language; same-line failure retry and persistent settings-off cancel pending work and preserve originals');
    await setTextEnabled(true);
    await settingsPage.close();
    for (const appearance of ['light', 'dark']) for (const accent of ['sky', 'rose', 'mint', 'iris', 'amber', 'slate']) {
      await setFixtureSettings({appearance, accentTheme: accent, textScale: 1.25});
      await page.waitForFunction(({appearance, accent}) => document.documentElement.dataset.appearance === appearance && document.documentElement.dataset.accent === accent, {appearance, accent});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: path.join(out, 'discovery-dark.png')});
    await cards.first().click();
    await dialog.getByRole('button', {name: '展开简介', exact: true}).waitFor();
    await dialog.locator('.nc-discovery-description-controls').getByRole('button', {name: '查看原文', exact: true}).waitFor();
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({path: path.join(out, 'discovery-detail-large.png')});
    await page.setViewportSize({width: 1280, height: 800});
    assert((await dialog.boundingBox()).height <= 736);
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await checkDescriptionExpansion(dialog);
    await page.screenshot({path: path.join(out, 'discovery-detail-small-window.png')});
    check('Six accent themes in light/dark render without horizontal overflow');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({live, textOnly, detailOnly, checks, errors, metadataRequests: requests.length, textRequests: textRequests.length, textPeak}, null, 2));
  console.log(JSON.stringify({out, checks: checks.length, errors}));
} catch (error) {
  if (page) await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  console.error('Artifacts: ' + out);
  throw error;
} finally {
  await context.close();
}
