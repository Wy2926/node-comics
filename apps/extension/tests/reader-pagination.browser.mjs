import {setReaderProgress} from './reader-progress-driver.mjs';
// Start Vite in apps/extension on 127.0.0.1:5181, then run from the repository root:
// node --test apps/extension/tests/reader-pagination.browser.mjs
// Uses installed PLAYWRIGHT_MODULE / CHROMIUM_PATH, isolated storage and synthetic images.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5181';
const artifacts = resolve(process.env.READER_PAGINATION_ARTIFACTS || 'artifacts/reader-pagination');
let browser, page, errors;
before(async () => {
  await mkdir(artifacts, {recursive: true});
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
});
after(async () => {await browser?.close();});
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce', serviceWorkers: 'block'});
  page.setDefaultTimeout(7000);
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('isolated-pagination-fixture', JSON.stringify({mode: 'classic', preference: 'original', fit: 'window', zoom: 100}));
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.__paginationUrls = {active: new Set(), revoked: new Set(), created: 0};
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.__paginationUrls.active.add(url);
      window.__paginationUrls.created++;
      return url;
    };
    URL.revokeObjectURL = url => {
      window.__paginationUrls.active.delete(url);
      window.__paginationUrls.revoked.add(url);
      revoke(url);
    };
  });
});
afterEach(async () => {await page?.close(); assert.deepEqual(errors, []);});

const viewport = () => page.locator('.nc-reading-viewport');
const cells = () => viewport().locator('.nc-manga-page');
const pageNumber = () => page.getByRole('slider', {name: '阅读进度', exact: true});
const settings = () => page.getByRole('dialog', {name: '阅读设置', exact: true});
const pageId = (number, chapter = 0) => `window-page-${chapter}-${number - 1}`;
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const snapshot = name => page.locator(`[data-testid="${name}"]`).textContent().then(JSON.parse);

async function reader({failure = false, long = false, chapters = false, layoutSettings = false} = {}) {
  await page.goto(`${origin}/tests/reader-window-fixture.html?pagination=1${failure ? '&failure=1' : ''}${long ? '&long=1' : ''}${chapters ? '&chapters=2' : ''}${layoutSettings ? '&layoutSettings=1' : ''}`);
  await viewport().waitFor();
  await page.waitForFunction(async () => (await import('/src/shortcuts/store.ts')).getShortcutSnapshot().ready);
  await shown(1, [1]);
  // Startup may outlast immersive chrome's idle timer. Reveal through the real shortcut.
  await page.keyboard.press('Escape');
  await pageNumber().waitFor();
}

async function shown(number, visible, imageCount = visible.length, chapter = 0) {
  await page.waitForFunction(({number, visible, imageCount}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const pages = [...(viewport?.querySelectorAll('.nc-manga-page') || [])];
    const ids = pages.map(element => element.getAttribute('data-page-id'));
    const images = [...(viewport?.querySelectorAll('img.nc-page-image') || [])];
    return document.querySelector('[aria-label="阅读进度"]')?.value === String(number)
      && JSON.stringify(ids) === JSON.stringify(visible)
      && images.length === imageCount && images.every(image => image.complete && image.naturalWidth > 0)
      && !viewport?.querySelector('.nc-page-image-pending');
  }, {number, visible: visible.map(number => pageId(number, chapter)), imageCount});
  await settle();
}

async function openSettings() {
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: '阅读设置', exact: true}).click();
  await settings().waitFor();
}
async function openMore(dialog = settings()) {
  const more = dialog.locator('details.nc-reader-more');
  if (await more.getAttribute('open') === null) await more.locator(':scope > summary').click();
}
async function closeSettings() {
  await settings().getByRole('button', {name: '关闭面板', exact: true}).click();
  await settings().waitFor({state: 'hidden'});
  await settle();
}
async function layout(value) {
  await openSettings();
  await settings().getByRole('group', {name: '阅读布局', exact: true}).getByRole('button', {name: value, exact: true}).click();
  await closeSettings();
}
async function direction(value) {
  await openSettings();
  await settings().getByRole('group', {name: '阅读方向', exact: true}).getByRole('button', {name: value, exact: true}).click();
  await closeSettings();
}
const comicView = comic => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), `isolated-layout-comic-${comic}`);
async function expectLayout(value) {
  await page.waitForFunction(value => document.querySelector('.nc-reading-viewport')?.getAttribute('data-layout') === value, value);
  await settle();
}
async function expectLayoutChoice(value) {
  await openSettings();
  assert.equal(await settings().getByRole('group', {name: '阅读布局', exact: true}).getByRole('button', {name: value, exact: true}).getAttribute('aria-pressed'), 'true');
  await closeSettings();
}
async function globalPreference(name, value) {
  await page.getByRole('button', {name: '全局阅读偏好', exact: true}).click();
  if (name === '默认缩放') {
    const control = page.getByRole('group', {name, exact: true}), target = Number.parseInt(value);
    let current = Number.parseInt(await control.locator(':scope > span').textContent());
    while (current !== target) {
      await control.getByRole('button', {name: current < target ? '放大' : '缩小', exact: true}).click();
      const next = Number.parseInt(await control.locator(':scope > span').textContent());
      assert.equal(next, current + (current < target ? 10 : -10)); current = next;
    }
  } else {
    await page.getByRole('combobox', {name, exact: true}).click();
    await page.getByRole('option', {name: value, exact: true}).click();
  }
  await page.getByRole('button', {name: '返回阅读器', exact: true}).click();
  await viewport().waitFor(); await page.keyboard.press('Escape'); await pageNumber().waitFor(); await settle();
}
const globalLayout = value => globalPreference('默认阅读布局', value);
const globalDirection = value => globalPreference('翻页方向', value);
async function switchComic(comic) {
  await page.getByRole('button', {name: `漫画 ${comic}`, exact: true}).click();
  await viewport().waitFor(); await page.keyboard.press('Escape'); await pageNumber().waitFor(); await settle();
}
async function assertTurnCursor(side) {
  const value = await viewport().evaluate(async element => {
    const cursor = getComputedStyle(element).cursor, src = cursor.match(/url\("([^"]+)"\)/)?.[1];
    if (!src) return {cursor};
    const svg = new DOMParser().parseFromString(await (await fetch(src)).text(), 'image/svg+xml');
    const path = svg.querySelector('path'), image = new Image(); image.src = src; await image.decode();
    return {cursor, size: [image.naturalWidth, image.naturalHeight], path: path?.getAttribute('d'), transform: path?.getAttribute('transform')};
  });
  assert.match(value.cursor, new RegExp(`\\) ${side === 'right' ? 29 : 3} 16, pointer$`));
  assert.deepEqual(value.size, [32, 32]);
  assert.equal(value.path, 'M2 9h11V4l9 8-9 8v-5H2Z');
  assert.equal(value.transform, side === 'left' ? 'translate(24 0) scale(-1 1)' : null);
}
async function jump(number) {
  await setReaderProgress(pageNumber(), String(number));

  await settle();
}
async function assertFits(label) {
  const metrics = await viewport().evaluate(element => {
    const outer = element.getBoundingClientRect(), surface = getComputedStyle(element.querySelector('.nc-reading-surface'));
    return {width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
      padding: [surface.paddingTop, surface.paddingRight, surface.paddingBottom, surface.paddingLeft].map(parseFloat),
      pages: [...element.querySelectorAll('.nc-manga-page')].map(page => {
        const box = page.getBoundingClientRect();
        return {left: box.left - outer.left, top: box.top - outer.top, right: box.right - outer.left, bottom: box.bottom - outer.top};
      }), ends: [...element.querySelectorAll('.nc-reader-end')].map(end => ({height: end.getBoundingClientRect().height, text: end.textContent.trim()}))};
  });
  assert(metrics.height > 0 && metrics.width > 0, `${label}: reading viewport has usable area`);
  assert(metrics.scrollWidth <= metrics.width + 1, `${label}: horizontal overflow ${metrics.scrollWidth} > ${metrics.width}`);
  assert(metrics.scrollHeight <= metrics.height + 1, `${label}: vertical overflow ${metrics.scrollHeight} > ${metrics.height}`);
  assert.equal(metrics.scrollLeft, 0, `${label}: horizontal position stays at zero`);
  assert.equal(metrics.scrollTop, 0, `${label}: vertical position stays at zero`);
  assert.deepEqual(metrics.padding, [0, 0, 0, 0], `${label}: the reading surface reserves no decorative padding`);
  for (const box of metrics.pages) {
    assert(box.left >= -1 && box.right <= metrics.width + 1, `${label}: full page width stays in the viewport`);
    assert(box.top >= -1 && box.bottom <= metrics.height + 1, `${label}: full page height stays in the viewport`);
  }
  for (const end of metrics.ends) {
    assert.equal(end.height, 0, `${label}: end sentinel cannot reserve footer space`);
    assert.equal(end.text, '', `${label}: pagination has no in-flow page-number/footer copy`);
  }
  const usedWidth = Math.max(...metrics.pages.map(box => box.right)) - Math.min(...metrics.pages.map(box => box.left));
  const usedHeight = Math.max(...metrics.pages.map(box => box.bottom)) - Math.min(...metrics.pages.map(box => box.top));
  assert(Math.abs(usedWidth - metrics.width) <= 2 || Math.abs(usedHeight - metrics.height) <= 2,
    `${label}: fit uses a complete viewport axis (${usedWidth}x${usedHeight} in ${metrics.width}x${metrics.height}), with only aspect-ratio letterboxing`);
}

test('single-page window fit removes footer space at the first, middle, landscape and final pages', async () => {
  await reader();
  assert.equal(await viewport().getAttribute('data-layout'), 'single');
  for (const number of [1, 2, 4, 8]) {
    await jump(number); await shown(number, [number]); await assertFits(`single page ${number}`);
    assert.equal(Number(await viewport().getAttribute('data-decoded-pages')), 1);
  }
  await page.screenshot({path: resolve(artifacts, 'single-last-page.png')});
});

test('explicit RTL double pages separate the cover and landscape and navigate by a whole spread', async () => {
  await reader(); await direction('从右向左'); await layout('双页'); await shown(1, [1]);
  assert.equal(await viewport().getAttribute('data-layout'), 'double');
  assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), 'rtl');
  await page.keyboard.press('ArrowLeft'); await shown(2, [2, 3]);
  const pair = await cells().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  assert(pair[0] > pair[1], 'Earlier manga page appears on the right');
  await page.keyboard.press('ArrowLeft'); await shown(4, [4]);
  await page.keyboard.press('ArrowRight'); await shown(2, [2, 3]);
  await page.keyboard.press('PageDown'); await shown(4, [4]);
  await page.keyboard.press('PageDown'); await shown(5, [5, 6]);
  await page.keyboard.press('PageUp'); await shown(4, [4]);
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(5, [5, 6]);
  await page.getByRole('button', {name: '上一页', exact: true}).click(); await shown(4, [4]);
  await jump(7); await shown(7, [7, 8]);
  assert(await page.getByRole('button', {name: '下一页', exact: true}).isDisabled(), 'Last spread is the end even when the selected page is its first half');
  await assertFits('last spread');
});

test('LTR reverses visual and arrow navigation without changing the selected page', async () => {
  await reader(); await direction('从右向左'); await layout('双页'); await jump(3); await shown(3, [2, 3]);
  await openSettings();
  await settings().getByRole('group', {name: '阅读方向', exact: true}).getByRole('button', {name: '从左向右', exact: true}).click();
  await closeSettings(); await shown(3, [2, 3]);
  const pair = await cells().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  assert(pair[0] < pair[1], 'Earlier page appears on the left in LTR');
  await page.keyboard.press('ArrowRight'); await shown(4, [4]);
  await page.keyboard.press('ArrowLeft'); await shown(2, [2, 3]);
});

test('a complete double spread fits desktop, narrow and short viewports without scrolling', async () => {
  await reader(); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  for (const size of [{width: 1280, height: 900}, {width: 360, height: 740}, {width: 1280, height: 360}]) {
    await page.setViewportSize(size); await settle(); await shown(2, [2, 3]);
    await assertFits(`${size.width}x${size.height}`);
    await page.screenshot({path: resolve(artifacts, `double-${size.width}x${size.height}.png`)});
  }
});

test('direct jumps, layout changes and reopen preserve the selected page identity inside a spread', async () => {
  await reader(); await layout('双页'); await jump(3); await shown(3, [2, 3]);
  await layout('单页'); await shown(3, [3]);
  await layout('双页'); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), /^window-page-0-2 · 0\.000$/);
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [2, 3]);
  await page.getByRole('button', {name: /^更新模拟翻译状态/}).click(); await shown(3, [2, 3]);
  await assertFits('reopened third-page selection');
});

test('double inspection zoom leaves saved single-page fit and zoom intact', async () => {
  await reader(); await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await settings().getByRole('button', {name: '放大', exact: true}).click();
  await closeSettings(); await layout('双页'); await shown(1, [1]);
  await openSettings();
  assert.equal(await settings().getByRole('group', {name: '图片适应方式', exact: true}).count(), 0);
  await settings().getByRole('button', {name: '放大', exact: true}).click();
  assert(Math.abs(Number(await viewport().getAttribute('data-spread-zoom')) - 110) < .01);
  await closeSettings();
  await page.keyboard.press('0'); await page.keyboard.press('w');
  await assertFits('double reset restores its fitted size');
  await layout('单页'); await openSettings();
  assert.equal(await settings().getByRole('group', {name: '图片适应方式', exact: true}).locator('[aria-pressed="true"]').textContent(), '铺满宽度');
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByText('110%', {exact: true}).waitFor();
});

const zoomMetrics = () => viewport().evaluate(element => {
  const stack = element.querySelector('.nc-page-stack'), box = stack.getBoundingClientRect();
  const matrix = new DOMMatrixReadOnly(getComputedStyle(stack).transform === 'none' ? undefined : getComputedStyle(stack).transform);
  return {scale: Number(element.dataset.spreadZoom || 100), x: matrix.m41, y: matrix.m42,
    box: {x: box.x, y: box.y, width: box.width, height: box.height},
    scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, urls: window.__paginationUrls.created,
    images: element.querySelectorAll('img.nc-page-image').length, hidden: element.closest('.nc-reader').classList.contains('controls-hidden')};
});
async function wheelAt(delta, x = .55, y = .55) {
  const box = await viewport().boundingBox();
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await page.mouse.wheel(0, delta); await settle();
}

async function inspectSpread() {
  const initial = await zoomMetrics();
  await wheelAt(-300);
  const enlarged = await zoomMetrics(), outer = await viewport().boundingBox();
  assert(enlarged.scale > 100, 'A real wheel event enlarges the fitted spread');
  await page.mouse.move(outer.x + outer.width * .5, outer.y + outer.height * .5);
  await page.mouse.down();
  await page.mouse.move(outer.x + outer.width * .5 + 90, outer.y + outer.height * .5 + 70, {steps: 8});
  await page.mouse.up(); await settle();
  const panned = await zoomMetrics();
  assert(Math.abs(panned.x - enlarged.x) > 20 || Math.abs(panned.y - enlarged.y) > 20, 'The enlarged spread is also panned before changing layout');
  assert.equal(panned.urls, initial.urls, 'Inspection reuses the displayed image resources');
}

async function assertNormalZoom(layout, number, zoom, mounted) {
  await expectLayout(layout);
  await page.waitForFunction(id => {
    const image = document.querySelector(`.nc-manga-page[data-page-id="${id}"] img.nc-page-image`);
    return image?.complete && image.naturalWidth > 0;
  }, pageId(number));
  await settle();
  const metrics = await viewport().evaluate((element, id) => {
    const cell = element.querySelector(`.nc-manga-page[data-page-id="${id}"]`), image = cell.querySelector('img.nc-page-image');
    return {width: element.clientWidth, pageWidth: cell.getBoundingClientRect().width, imageWidth: image.getBoundingClientRect().width,
      stacks: [...element.querySelectorAll('.nc-page-stack')].map(stack => ({inline: stack.style.transform, computed: getComputedStyle(stack).transform})),
      zoomed: element.getAttribute('data-zoomed'), spreadZoom: element.getAttribute('data-spread-zoom'), dragging: element.getAttribute('data-zoom-dragging'),
      pages: element.querySelectorAll('.nc-manga-page').length, images: element.querySelectorAll('img.nc-page-image').length,
      urls: window.__paginationUrls.active.size};
  }, pageId(number));
  for (const stack of metrics.stacks) {
    assert.equal(stack.inline, '', `${layout}: no spread transform remains on a reused stack`);
    assert.equal(stack.computed, 'none', `${layout}: the stack is not visually enlarged or panned`);
  }
  assert.deepEqual([metrics.zoomed, metrics.spreadZoom, metrics.dragging], [null, null, null]);
  assert(Math.abs(metrics.pageWidth - metrics.width * zoom / 100) < 2, `${layout}: actual page width ${metrics.pageWidth} agrees with saved ${zoom}% of ${metrics.width}`);
  assert(Math.abs(metrics.imageWidth - metrics.pageWidth) < 2, `${layout}: the displayed image has the same untransformed width as its page`);
  assert.equal(await pageNumber().inputValue(), String(number), `${layout}: the selected page identity is retained`);
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), new RegExp(`^${pageId(number)} · 0\\.000$`));
  assert.equal(await mounted.evaluate(element => element === document.querySelector('.nc-reading-viewport')), true, 'Recovery does not remount the reader');
  const saved = await comicView('A');
  assert.equal(saved.zoom, zoom); assert.equal(saved.fit, 'width');
  const limit = layout === 'continuous' ? 4 : 1;
  assert(metrics.pages <= limit && metrics.images <= limit && metrics.urls <= limit, `${layout}: decoded pages and active images stay bounded`);
  return metrics;
}

for (const scenario of [
  {name: 'continuous on the cover', target: 'continuous', choice: '连续', number: 1},
  {name: 'single on a selected second spread page', target: 'single', choice: '单页', number: 3},
  {name: 'the inherited global single default', target: 'single', choice: '默认', number: 3},
  {name: 'continuous through the layout shortcut', target: 'continuous', shortcut: true, number: 3},
]) test(`leaving double inspection restores saved zoom for ${scenario.name} without reopening`, async t => {
  await reader({layoutSettings: true});
  const mounted = await viewport().elementHandle();
  assert.deepEqual([(await comicView('A')).fit, (await comicView('A')).zoom], ['width', 50]);
  await layout('双页'); await jump(scenario.number); await shown(scenario.number, scenario.number === 1 ? [1] : [2, 3]);
  const leave = async () => {
    if (scenario.shortcut) await page.keyboard.press('m');
    else await layout(scenario.choice);
  };
  await inspectSpread(); await leave();
  const restored = await assertNormalZoom(scenario.target, scenario.number, 50, mounted);
  t.diagnostic(JSON.stringify({layout: scenario.target, page: scenario.number, savedZoom: 50, ...restored}));
  assert.equal((await comicView('A')).layout, scenario.choice === '默认' ? undefined : scenario.target);
  assert.equal((await snapshot('global-reading-settings')).layout, 'single');
  await openSettings();
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByText('50%', {exact: true}).waitFor();
  if (scenario.target === 'continuous' && scenario.number === 1) await page.screenshot({path: resolve(artifacts, 'spread-zoom-reset-continuous-50.png')});
  await settings().getByRole('button', {name: '放大', exact: true}).click();
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByText('60%', {exact: true}).waitFor();
  await closeSettings(); await assertNormalZoom(scenario.target, scenario.number, 60, mounted);
  await page.screenshot({path: resolve(artifacts, `spread-zoom-reset-${scenario.target}-${scenario.number}-${scenario.shortcut ? 'shortcut' : scenario.choice === '默认' ? 'default' : 'choice'}.png`)});
  await layout('双页'); await shown(scenario.number, scenario.number === 1 ? [1] : [2, 3]);
  assert.equal((await zoomMetrics()).scale, 100); await assertFits('Re-entered double mode starts fitted');
  await inspectSpread(); await leave();
  await assertNormalZoom(scenario.target, scenario.number, 60, mounted);
  await mounted.dispose();
});

test('double wheel zoom is pointer-anchored, bounded, and reuses displayed images', async () => {
  await reader(); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  const before = await zoomMetrics(), outer = await viewport().boundingBox();
  const point = {x: outer.x + outer.width * .55, y: outer.y + outer.height * .55};
  const u = (point.x - before.box.x) / before.box.width, v = (point.y - before.box.y) / before.box.height;
  await wheelAt(-300);
  const enlarged = await zoomMetrics();
  assert(enlarged.scale > 100 && enlarged.scale < 400);
  assert(Math.abs(enlarged.box.x + enlarged.box.width * u - point.x) < 2, 'pointer X stays over the same pixels');
  assert(Math.abs(enlarged.box.y + enlarged.box.height * v - point.y) < 2, 'pointer Y stays over the same pixels');
  assert.equal(enlarged.urls, before.urls); assert.equal(enlarged.images, 2);
  assert.equal(await viewport().getAttribute('data-swipe-enabled'), 'false');
  await page.mouse.move(outer.x + outer.width * .15, point.y);
  assert.equal(await viewport().evaluate(element => getComputedStyle(element).cursor), 'grab');
  await page.screenshot({path: resolve(artifacts, 'double-pointer-zoom.png')});
  await wheelAt(-10000); await wheelAt(-10000); assert.equal((await zoomMetrics()).scale, 400);
  for (let i = 0; i < 3; i++) await wheelAt(10000);
  await assertFits('minimum is the whole fitted spread');
  assert.equal((await zoomMetrics()).scale, 100);
  assert.equal(await viewport().getAttribute('data-swipe-enabled'), 'true');
});

test('zoomed spread drags in both axes without turning pages or toggling controls', async () => {
  await reader(); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  await wheelAt(-300); const before = await zoomMetrics(), outer = await viewport().boundingBox();
  await page.mouse.move(outer.x + outer.width * .5, outer.y + outer.height * .5);
  await page.mouse.down(); await page.mouse.move(outer.x + outer.width * .5 + 100, outer.y + outer.height * .5 + 80, {steps: 8}); await page.mouse.up(); await settle();
  const moved = await zoomMetrics();
  assert(Math.abs(moved.x - before.x - 100) < 2); assert(Math.abs(moved.y - before.y - 80) < 2);
  assert.equal(moved.hidden, before.hidden); assert.equal(await pageNumber().inputValue(), '2');
  assert.equal(moved.scrollLeft, 0); assert.equal(moved.scrollTop, 0);
  assert.equal(await viewport().getAttribute('data-zoom-dragging'), null);
  await page.getByRole('button', {name: /^更新模拟翻译状态/}).click();
  const refreshed = await zoomMetrics(); assert.equal(refreshed.scale, moved.scale); assert.equal(refreshed.x, moved.x); assert.equal(refreshed.y, moved.y);
  await page.keyboard.press('PageDown'); await shown(4, [4]); await assertFits('explicit navigation resets inspection zoom');
  await wheelAt(-300); await page.setViewportSize({width: 980, height: 740}); await settle();
  await assertFits('resize resets inspection zoom');
});

test('translated image replacement keeps double zoom and pan with a bounded DOM', async () => {
  await reader(); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  await page.getByRole('button', {name: '翻译', exact: true}).click();
  await wheelAt(-300); const before = await zoomMetrics();
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.nc-reading-viewport img.nc-page-image')].every(image => image.dataset.resultJob !== 'original'));
  const after = await zoomMetrics();
  assert.equal(after.scale, before.scale); assert.equal(after.x, before.x); assert.equal(after.y, before.y); assert.equal(after.images, 2);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), /^window-page-0-1 · 0\.000$/);
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(2, [2, 3]); await assertFits('reopen retains page, not temporary pan');
});

for (const mode of ['单页', '双页']) for (const direction of ['从左向右', '从右向左']) test(`${mode} edge clicks follow ${direction}, center toggles controls and hover hints match`, async () => {
  await reader(); await layout(mode); await jump(2); await shown(2, mode === '双页' ? [2, 3] : [2]);
  await openSettings(); await settings().getByRole('group', {name: '阅读方向', exact: true}).getByRole('button', {name: direction, exact: true}).click(); await closeSettings();
  const box = await viewport().boundingBox(), left = {x: box.x + box.width * .15, y: box.y + box.height * .5}, right = {x: box.x + box.width * .85, y: left.y};
  const next = direction === '从左向右' ? right : left;
  await page.mouse.move(next.x, next.y);
  assert.equal(await viewport().getAttribute('title'), '下一页');
  await assertTurnCursor(direction === '从左向右' ? 'right' : 'left');
  await page.mouse.click(next.x, next.y); await shown(mode === '双页' ? 4 : 3, mode === '双页' ? [4] : [3]);
  const previous = direction === '从左向右' ? left : right;
  await page.mouse.move(previous.x, previous.y);
  await assertTurnCursor(direction === '从左向右' ? 'left' : 'right');
  await page.mouse.click(previous.x, previous.y); await shown(2, mode === '双页' ? [2, 3] : [2]);
  await page.mouse.move(box.x + box.width * .5, left.y);
  assert.equal(await viewport().getAttribute('title'), null);
  assert.doesNotMatch(await viewport().evaluate(element => getComputedStyle(element).cursor), /url\(|resize/);
  const hidden = (await zoomMetrics()).hidden;
  await page.mouse.click(box.x + box.width * .5, left.y);
  assert.equal((await zoomMetrics()).hidden, !hidden); assert.equal(await pageNumber().inputValue(), '2');
});

test('continuous modified clicks leave controls untouched while plain center taps still toggle them', async () => {
  await reader(); await layout('连续');
  const box = await viewport().boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const hidden = () => page.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden'));
  assert.equal(await hidden(), false);
  await page.keyboard.down('Control');
  try {await page.mouse.click(x, y);} finally {await page.keyboard.up('Control');}
  await settle(); assert.equal(await hidden(), false, 'Modified clicks must not hide reader controls');
  await page.mouse.click(x, y); await settle(); assert.equal(await hidden(), true);
  await page.mouse.click(x, y); await settle(); assert.equal(await hidden(), false);
  assert.equal(await pageNumber().inputValue(), '1');
});

test('double touch pan suppresses its synthetic tap and minimum zoom restores swipe', async () => {
  await reader(); await direction('从右向左'); await layout('双页'); await jump(2); await shown(2, [2, 3]); await wheelAt(-300);
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true});
  const box = await viewport().boundingBox(), x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2), before = await zoomMetrics();
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y, id: 1}]});
  for (let n = 1; n <= 5; n++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: x + 20 * n, y: y + 10 * n, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await settle();
  const after = await zoomMetrics(); assert(after.x > before.x + 80); assert(after.y > before.y + 30);
  assert.equal(await pageNumber().inputValue(), '2'); assert.equal(after.hidden, before.hidden);
  await page.keyboard.press('0'); await assertFits('touch pan reset');
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 220, y, {steps: 8}); await page.mouse.up(); await shown(4, [4]);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: Math.round(box.x + box.width * .15), y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await shown(5, [5, 6]);
});

test('both spread pages are translation targets and four comparison images still fit the window', async () => {
  await reader(); await layout('双页'); await jump(3); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.getByRole('button', {name: '翻译', exact: true}).click(); await shown(3, [2, 3]);
  await page.waitForFunction(() => {
    const value = JSON.parse(document.querySelector('[data-testid="reading-window"]').textContent);
    return value.targets?.[0] === 'window-page-0-1' && value.targets?.[1] === 'window-page-0-2';
  });
  const window = await snapshot('reading-window');
  assert.deepEqual(window.visible, [pageId(2), pageId(3)]);
  assert.equal(window.immediate, true);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.nc-reading-viewport img.nc-page-image:not([data-result-job="original"])')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  await openSettings(); await openMore(); await settings().getByRole('switch', {name: '并排对照', exact: true}).click(); await closeSettings();
  await shown(3, [2, 3], 4); await assertFits('double comparison desktop');
  await page.setViewportSize({width: 360, height: 740}); await shown(3, [2, 3], 4); await assertFits('double comparison narrow');
  await page.screenshot({path: resolve(artifacts, 'double-comparison-narrow.png')});
});

test('one failed page does not block its partner or navigation and never marks the chapter read', async () => {
  await reader({failure: true}); await layout('双页');
  for (const [number, visible] of [[2, [2, 3]], [4, [4]], [5, [5, 6]]]) {
    await jump(number); await shown(number, visible, number === 5 ? 1 : visible.length);
  }
  const failure = viewport().locator(`[data-page-id="${pageId(6)}"]`);
  await failure.getByText('图片暂不可用', {exact: true}).waitFor();
  assert.equal(await viewport().locator(`[data-page-id="${pageId(5)}"] img.nc-page-image`).count(), 1);
  await assertFits('independent failed half');
  await page.screenshot({path: resolve(artifacts, 'double-independent-failure.png')});
  await page.keyboard.press('PageDown'); await shown(7, [7, 8]);
  assert.deepEqual(await snapshot('marked-read'), []);
});

test('skipping pages does not mark read; displaying every spread marks read exactly once at the final pair', async () => {
  await reader(); await layout('双页'); await jump(7); await shown(7, [7, 8]);
  assert.deepEqual(await snapshot('marked-read'), []);
  for (const [number, visible] of [[1, [1]], [2, [2, 3]], [4, [4]], [5, [5, 6]], [7, [7, 8]]]) {
    await jump(number); await shown(number, visible);
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="marked-read"]').textContent === '["window-fixture-0"]');
  await page.keyboard.press('PageUp'); await shown(5, [5, 6]);
  await page.keyboard.press('PageDown'); await shown(7, [7, 8]);
  assert.deepEqual(await snapshot('marked-read'), ['window-fixture-0']);
});

test('spread navigation keeps at most two decoded pages and releases off-screen image URLs', async () => {
  await reader(); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  const oldUrls = await viewport().locator('img.nc-page-image').evaluateAll(images => images.map(image => image.src));
  await jump(5); await shown(5, [5, 6]);
  await page.waitForFunction(urls => urls.every(url => window.__paginationUrls.revoked.has(url)), oldUrls);
  for (const [number, visible] of [[7, [7, 8]], [4, [4]], [2, [2, 3]], [8, [7, 8]]]) {
    await jump(number); await shown(number, visible);
    assert.equal(await cells().count(), visible.length);
    assert.equal(Number(await viewport().getAttribute('data-decoded-pages')), visible.length);
    await page.waitForFunction(() => window.__paginationUrls.active.size <= 2);
  }
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__paginationUrls.active.size === 0);
  assert.deepEqual((await snapshot('reading-window')).visible, []);
  assert.deepEqual((await snapshot('reading-window')).targets, []);
});

test('continuous to single-page switching preserves a long page offset when the window resizes', async () => {
  await reader({long: true}); await layout('连续'); await jump(9);
  await layout('单页'); await shown(9, [9]);
  await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await closeSettings(); await shown(9, [9]);
  await viewport().evaluate(element => {element.scrollTop = element.querySelector('.nc-manga-page').getBoundingClientRect().height * .42;});
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="保存位置"]').textContent.split(' · ')[1]) > .4);
  const position = () => viewport().evaluate(element => {
    const box = element.querySelector('.nc-manga-page').getBoundingClientRect(), outer = element.getBoundingClientRect();
    return {offset: (outer.top - box.top) / box.height, top: element.scrollTop};
  });
  const before = await position();
  await page.setViewportSize({width: 960, height: 700}); await shown(9, [9]);
  const after = await position();
  assert(Number.isFinite(after.top) && after.top > 0, 'Resize must not restore a NaN or zero scroll position');
  assert(Math.abs(after.offset - before.offset) < .003, `Relative offset changed from ${before.offset} to ${after.offset}`);
});

test('fitting the final already-loaded long page into a spread marks read without requiring another image load', async () => {
  await reader({long: true}); await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await closeSettings();
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {await jump(number); await shown(number, [number]);}
  const finalImage = viewport().locator(`[data-page-id="${pageId(9)}"] img.nc-page-image`);
  const source = await finalImage.getAttribute('src');
  assert.deepEqual(await snapshot('marked-read'), [], 'A loaded final page is not read while its bottom remains below the viewport');
  assert(await viewport().evaluate(element => element.scrollHeight > element.clientHeight + 1000));
  await layout('双页'); await shown(9, [9]); await assertFits('long final page fitted into spread');
  assert.equal(await cells().count(), 1, 'No partner can mount and trigger another pageShown callback for this regression');
  assert.equal(await finalImage.getAttribute('src'), source, 'Changing geometry reuses the displayed image and does not fabricate a new load event');
  await page.waitForFunction(() => document.querySelector('[data-testid="marked-read"]').textContent === '["window-fixture-0"]');
});

test('one forward action from the final spread opens the next chapter cover without pairing across chapters', async () => {
  await reader({chapters: true}); await layout('双页'); await jump(8); await shown(8, [7, 8]);
  assert(await page.getByRole('button', {name: '下一页', exact: true}).isEnabled());
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(1, [1], 1, 1);
  assert.equal(await viewport().locator('.nc-stream-chapter').count(), 1);
  assert.equal(await viewport().locator('.nc-stream-chapter').getAttribute('data-copy-id'), 'window-fixture-1');
  await assertFits('next chapter cover');
  await page.keyboard.press('PageDown'); await shown(2, [2, 3], 2, 1);
  assert.deepEqual(await snapshot('marked-read'), [], 'Skipping a chapter cannot mark it read while crossing the boundary');
});

for (const device of [
  {name: 'desktop', width: 1280, height: 900, touch: false, fit: 'width'},
  {name: 'narrow-desktop', width: 650, height: 900, touch: false, fit: 'width'},
  {name: 'phone-portrait', width: 390, height: 844, touch: true, fit: 'window'},
  {name: 'phone-landscape', width: 844, height: 390, touch: true, fit: 'window'},
  {name: 'tablet', width: 768, height: 1024, touch: true, fit: 'width'},
  {name: 'large-tablet-portrait', width: 1024, height: 1366, touch: true, fit: 'width'},
  {name: 'large-tablet-landscape', width: 1366, height: 1024, touch: true, fit: 'width'},
]) test(`first-open zoom is 100% on touch devices and 50% on desktop: ${device.name}`, async () => {
  await page.setViewportSize({width: device.width, height: device.height});
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', {enabled: device.touch});
  await reader({layoutSettings: true});
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse), (hover: none)').matches), device.touch);
  const expected = {mode: 'classic', preference: 'original', zoom: device.touch ? 100 : 50, fit: device.fit};
  assert.deepEqual(await comicView('A'), expected);
  if (device.fit === 'window') await assertFits(device.name);
  else assert(Math.abs((await cells().first().boundingBox()).width - await viewport().evaluate(element => element.clientWidth) * expected.zoom / 100) < 2, 'Rendered width matches the opening zoom');
  await openSettings();
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByText(`${expected.zoom}%`, {exact: true}).waitFor();
  await page.screenshot({path: resolve(artifacts, `default-zoom-${device.name}.png`)});
  await closeSettings(); await jump(3); await shown(3, [3]);
  await globalPreference('默认缩放', '140%'); await shown(3, [3]);
  assert.deepEqual(await comicView('A'), expected, 'Changing the global zoom leaves this comic and its page intact');
  await switchComic('B');
  assert.equal((await comicView('B')).zoom, 140, 'Only the unread comic receives the new global zoom');
  await switchComic('A'); assert.deepEqual(await comicView('A'), expected);
  if (device.name === 'desktop' || device.name === 'phone-portrait') {
    await page.getByRole('button', {name: '全局阅读偏好', exact: true}).click();
    await page.locator('.settings-card').filter({has: page.getByRole('heading', {name: '阅读偏好', exact: true})})
      .screenshot({path: resolve(artifacts, `global-zoom-${device.name}.png`)});
  }
});

test('first-open global zoom survives chapter switches, manual zoom, reopening, and reload', async () => {
  await reader({layoutSettings: true, chapters: true});
  await globalPreference('默认缩放', '130%');
  assert.equal((await comicView('A')).zoom, 50);
  await switchComic('B'); assert.equal((await comicView('B')).zoom, 130);
  await jump(4); await shown(4, [4]);
  await openSettings();
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByRole('button', {name: '放大', exact: true}).click();
  await closeSettings(); assert.equal((await comicView('B')).zoom, 140);
  await globalPreference('默认缩放', '70%'); await shown(4, [4]);
  assert.equal((await comicView('B')).zoom, 140);
  await page.getByRole('button', {name: '切下一章', exact: true}).click(); await shown(1, [1], 1, 1);
  assert.equal((await comicView('B')).zoom, 140);
  await switchComic('A'); assert.equal((await comicView('A')).zoom, 50);
  await switchComic('B'); assert.equal((await comicView('B')).zoom, 140);
  await page.reload(); await viewport().waitFor();
  await switchComic('B'); assert.equal((await comicView('B')).zoom, 140);
});

test('comic layouts inherit the real global preference until overridden and Default clears only the comic override', async () => {
  await reader({layoutSettings: true});
  await expectLayoutChoice('默认'); assert.equal((await comicView('A')).layout, undefined);
  await globalLayout('双页'); await expectLayout('double'); await shown(1, [1]);
  await expectLayoutChoice('默认'); assert.equal((await comicView('A')).layout, undefined);
  await layout('单页'); await expectLayout('single');
  assert.equal((await comicView('A')).layout, 'single'); assert.equal((await snapshot('global-reading-settings')).layout, 'double');
  await switchComic('B'); await expectLayout('double'); await expectLayoutChoice('默认');
  assert.equal((await comicView('B')).layout, undefined);
  await globalLayout('连续'); await expectLayout('continuous'); await expectLayoutChoice('默认');
  assert.equal((await comicView('B')).layout, undefined);
  await switchComic('A'); await expectLayout('single'); await expectLayoutChoice('单页');
  assert.equal((await snapshot('global-reading-settings')).layout, 'continuous');
  await layout('默认'); await expectLayout('continuous'); await expectLayoutChoice('默认');
  assert.equal((await comicView('A')).layout, undefined);
  assert.equal((await snapshot('global-reading-settings')).layout, 'continuous');
});

test('an explicit comic layout equal to the global default survives global changes, reopen, and refresh', async () => {
  await reader({layoutSettings: true}); await globalLayout('双页'); await expectLayout('double');
  await layout('双页'); await expectLayoutChoice('双页');
  assert.equal((await comicView('A')).layout, 'double');
  await globalLayout('连续'); await expectLayout('double'); await expectLayoutChoice('双页');
  assert.equal((await snapshot('global-reading-settings')).layout, 'continuous');
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
  await expectLayout('double'); await shown(1, [1]);
  await page.reload(); await expectLayout('double'); await shown(1, [1]);
  await page.keyboard.press('Escape'); await expectLayoutChoice('双页');
  assert.equal((await comicView('A')).layout, 'double');
  assert.equal((await snapshot('global-reading-settings')).layout, 'single', 'Fixture global state resets on reload, but the real comic storage still wins');
  await switchComic('B'); await expectLayout('single'); await expectLayoutChoice('默认');
});

test('global and comic layout changes preserve inherited direction without creating a comic direction override', async () => {
  await reader({layoutSettings: true});
  for (const [label, value] of [['从左向右', 'ltr'], ['从右向左 · 日漫习惯', 'rtl']]) {
    await globalDirection(label);
    for (const name of ['双页', '单页', '连续']) {
      await globalLayout(name);
      assert.equal((await snapshot('global-reading-settings')).direction, value, 'Global layout does not rewrite the selected direction');
      assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
      assert.equal((await comicView('A')).direction, undefined, 'Inherited direction is not pinned by saving a layout');
    }
    for (const name of ['双页', '单页', '双页', '默认']) {
      await layout(name);
      assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
      assert.equal((await comicView('A')).direction, undefined);
    }
    assert.equal((await comicView('A')).layout, undefined, 'Default clears only the layout override');
  }
});

for (const [label, value, inheritedLabel, inherited] of [
  ['从左向右', 'ltr', '从右向左 · 日漫习惯', 'rtl'],
  ['从右向左', 'rtl', '从左向右', 'ltr'],
]) test(`explicit ${value} survives repeated layout changes, reopening and chapters without changing global defaults or another comic`, async () => {
  await reader({layoutSettings: true, chapters: true}); await globalDirection(inheritedLabel); await direction(label);
  await jump(3); await shown(3, [3]);
  for (const [name, visible] of [['双页', [2, 3]], ['单页', [3]], ['双页', [2, 3]]]) {
    await layout(name); await shown(3, visible);
    assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
    assert.equal((await comicView('A')).direction, value);
  }
  await layout('默认'); await shown(3, [3]);
  assert.equal((await comicView('A')).layout, undefined);
  assert.equal((await comicView('A')).direction, value, 'Restoring default layout preserves the independent direction override');
  await layout('双页'); await shown(3, [2, 3]);
  assert.equal((await snapshot('global-reading-settings')).direction, inherited);
  assert.deepEqual([(await comicView('A')).layout, (await comicView('A')).direction], ['double', value]);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [2, 3]);
  assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
  await page.getByRole('button', {name: '切下一章', exact: true}).click(); await shown(1, [1], 1, 1);
  await expectLayout('double');
  assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
  assert.equal((await snapshot('global-reading-settings')).viewKey, 'isolated-layout-comic-A');
  assert.equal((await snapshot('global-reading-settings')).direction, inherited);
  await switchComic('B'); await expectLayout('single');
  assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), inherited);
  assert.equal((await comicView('B')).direction, undefined);
  await switchComic('A'); await expectLayout('double');
  assert.equal(await viewport().locator('.nc-page-stack').getAttribute('data-direction'), value);
});

test('page animation defaults to curl and persists per comic across reload, chapters and layout changes', async () => {
  await reader({layoutSettings: true, chapters: true}); await openSettings();
  const choices = () => settings().getByRole('group', {name: '翻页动画', exact: true});
  assert.deepEqual(await choices().getByRole('button').allTextContents(), ['仿真翻页', '左右滑动', '淡入淡出', '无动画']);
  assert.equal(await choices().getByRole('button', {name: '仿真翻页', exact: true}).getAttribute('aria-pressed'), 'true');
  assert.equal((await comicView('A')).animation, undefined, 'Existing records need no animation migration');
  for (const [value, label] of [['slide', '左右滑动'], ['none', '无动画'], ['fade', '淡入淡出']]) {
    await choices().getByRole('button', {name: label, exact: true}).click();
    assert.equal((await comicView('A')).animation, value);
  }
  await closeSettings(); await layout('连续'); await openSettings();
  assert.equal(await choices().count(), 0, 'Continuous reading has no unrelated page-turn control');
  await closeSettings(); await layout('双页'); await jump(3); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '切下一章', exact: true}).click(); await shown(1, [1], 1, 1);
  await openSettings(); assert.equal(await choices().getByRole('button', {name: '淡入淡出', exact: true}).getAttribute('aria-pressed'), 'true');
  await closeSettings(); await switchComic('B'); await openSettings();
  assert.equal(await choices().getByRole('button', {name: '仿真翻页', exact: true}).getAttribute('aria-pressed'), 'true');
  await closeSettings(); await switchComic('A');
  await page.reload(); await viewport().waitFor(); await openSettings();
  assert.equal(await choices().getByRole('button', {name: '淡入淡出', exact: true}).getAttribute('aria-pressed'), 'true');
});

test('the immersive preference survives reopening and comic changes without saving temporary toolbar visibility', async () => {
  await reader({layoutSettings: true}); await openSettings();
  const immersive = () => settings().getByRole('switch', {name: '沉浸阅读', exact: true});
  assert.equal(await immersive().getAttribute('aria-checked'), 'true');
  await immersive().click(); await closeSettings(); await jump(3); await shown(3, [3]);
  const pinned = async () => {
    assert.equal(await page.locator('.nc-reader').evaluate(element => element.classList.contains('is-immersive')), false);
    await page.waitForTimeout(1400);
    assert.equal(await page.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden')), false, 'Disabled immersive controls stay visible beyond the idle timeout');
  };
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [3]); await pinned();
  await switchComic('B'); await pinned();
  await switchComic('A'); await shown(3, [3]); await pinned();
  await openSettings(); assert.equal(await immersive().getAttribute('aria-checked'), 'false');
  await immersive().click(); await closeSettings();
  const box = await viewport().boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [3]);
  assert.equal(await page.locator('.nc-reader').evaluate(element => element.classList.contains('is-immersive')), true);
  assert.equal(await page.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden')), false, 'Each new reader starts with its tools visible, not the previous temporary hidden state');
  await openSettings(); assert.equal(await immersive().getAttribute('aria-checked'), 'true');
  assert.equal((await comicView('A')).readerImmersive, undefined, 'Immersive is a global preference, not a comic view override');
  // This fixture keeps global Settings in React state; real settings-store/App tests cover full page reloads.
});

async function readerLocale(locale, scale = 1) {
  const labels = await page.evaluate(async ({locale, scale}) => {
    await (await import('/src/i18n/load.ts')).setUiLanguage(locale);
    document.documentElement.style.setProperty('--text-scale', String(scale));
    const {msg} = await import('/src/i18n/runtime.ts');
    return ['阅读设置', '阅读布局', '默认', '连续', '单页', '双页', '打开来源', '翻页动画'].map(key => msg(key));
  }, {locale, scale});
  await settle();
  await page.evaluate(() => document.fonts.ready);
  await settle();
  return labels;
}

async function assertCardGrid(group, label, count = 4, columns = 2) {
  const bounds = await group.evaluate(element => {
    const box = element.getBoundingClientRect();
    return {width: innerWidth, left: box.left, right: box.right, client: element.clientWidth, scroll: element.scrollWidth,
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      buttons: [...element.querySelectorAll('button')].map(button => {
        const item = button.getBoundingClientRect(), textRects = [];
        const texts = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        while (texts.nextNode()) if (texts.currentNode.textContent.trim()) {
          const range = document.createRange(); range.selectNodeContents(texts.currentNode);
          for (const rect of range.getClientRects()) textRects.push({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom});
        }
        return {left: item.left, right: item.right, top: item.top, bottom: item.bottom,
          width: button.clientWidth, scroll: button.scrollWidth, textRects};
      })};
  });
  assert.equal(bounds.buttons.length, count, `${label}: all available choices are rendered`);
  assert.equal(bounds.columns, columns, `${label}: ${columns} equal-width columns`);
  assert(bounds.left >= 0 && bounds.right <= bounds.width + 1, `${label}: grid stays in the screen`);
  assert(bounds.scroll <= bounds.client + 1, `${label}: no horizontal grid overflow`);
  for (const button of bounds.buttons) {
    assert(button.left >= bounds.left - 1 && button.right <= bounds.right + 1, `${label}: card stays inside its grid`);
    assert(button.scroll <= button.width + 1, `${label}: label does not create horizontal overflow`);
    assert(button.bottom - button.top >= 44, `${label}: usable touch target`);
    assert(button.textRects.length > 0, `${label}: visible text is retained`);
    for (const text of button.textRects) {
      assert(text.left >= button.left - 1 && text.right <= button.right + 1 && text.top >= button.top - 1 && text.bottom <= button.bottom + 1,
        `${label}: every label line stays inside its card without clipping`);
    }
  }
  if (count === 4) {
    assert.equal(Math.round(bounds.buttons[0].top), Math.round(bounds.buttons[1].top), `${label}: first row`);
    assert.equal(Math.round(bounds.buttons[2].top), Math.round(bounds.buttons[3].top), `${label}: second row`);
    assert(bounds.buttons[2].top >= bounds.buttons[0].bottom, `${label}: rows do not overlap`);
  }
}

for (const width of [320, 390, 1280]) test(`layout and action cards fit all 16 locales in ${width}px reader settings`, async () => {
  await page.setViewportSize({width, height: 844}); await reader({layoutSettings: true}); await openSettings();
  const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'];
  for (const scale of [1, 1.25]) for (const locale of locales) {
    const [title, layoutLabel, defaultLabel, continuousLabel, singleLabel, doubleLabel, sourceLabel, animationLabel] = await readerLocale(locale, scale);
    const dialog = page.getByRole('dialog', {name: title, exact: true});
    const choices = dialog.getByRole('group', {name: layoutLabel, exact: true}), actions = dialog.locator('.nc-reader-more .nc-reader-actions');
    assert.deepEqual(await choices.getByRole('button').allTextContents(), [defaultLabel, continuousLabel, singleLabel, doubleLabel]);
    assert.equal(await choices.getByRole('button', {name: defaultLabel, exact: true}).getAttribute('aria-pressed'), 'true');
    await choices.scrollIntoViewIfNeeded();
    await settle();
    await assertCardGrid(choices, `${locale}/${scale} layouts`);
    if (width === 320 && ['zh-CN', 'de', 'fr'].includes(locale)) await page.screenshot({path: resolve(artifacts, `settings-layout-${locale}-${scale}.png`)});
    const animation = dialog.getByRole('group', {name: animationLabel, exact: true});
    await animation.scrollIntoViewIfNeeded(); await settle(); await assertCardGrid(animation, `${locale}/${scale} animation`);
    if (width === 320 && ['zh-CN', 'de', 'fr'].includes(locale)) await page.screenshot({path: resolve(artifacts, `settings-animation-${locale}-${scale}.png`)});
    await dialog.locator('.nc-reader-primary-actions').scrollIntoViewIfNeeded();
    await assertCardGrid(dialog.locator('.nc-reader-primary-actions'), `${locale}/${scale} fullscreen`, 1, 1);
    await openMore(dialog); await actions.scrollIntoViewIfNeeded();
    await settle();
    await assertCardGrid(actions, `${locale}/${scale} actions`, 3);
    assert.equal(await dialog.getByRole('link', {name: sourceLabel, exact: true}).count(), 0);
    assert(await dialog.locator('.nc-drawer-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${locale}/${scale}: entire settings panel has no horizontal overflow`);
    if (width === 320 && ['zh-CN', 'de', 'fr'].includes(locale)) {
      await dialog.locator('.nc-drawer-content').evaluate(element => {element.scrollTo({top: element.scrollHeight, behavior: 'instant'});});
      await settle();
      await page.screenshot({path: resolve(artifacts, `settings-actions-${locale}-${scale}.png`)});
    }
  }
  await readerLocale('zh-CN');
  const choices = settings().getByRole('group', {name: '阅读布局', exact: true});
  await choices.getByRole('button', {name: '双页', exact: true}).click(); await closeSettings(); await expectLayout('double');
});

test('reader action cards keep reload and find callbacks and the shortcut panel', async () => {
  await reader({layoutSettings: true}); await openSettings();
  assert.equal(await settings().locator('details.nc-reader-more').getAttribute('open'), null);
  assert.deepEqual(await settings().locator('.nc-reader-primary-actions button').allTextContents(), ['全屏阅读']);
  assert.equal(await settings().getByRole('button', {name: '重新载入', exact: true}).count(), 0, 'Secondary actions start outside the accessible control list');
  assert.equal(await settings().getByRole('switch', {name: '并排对照', exact: true}).count(), 0);
  await settings().locator('details.nc-reader-more > summary').focus();
  await page.keyboard.press('Enter');
  assert.notEqual(await settings().locator('details.nc-reader-more').getAttribute('open'), null, 'Native disclosure is keyboard operable');
  assert.deepEqual(await settings().locator('.nc-reader-more .nc-reader-actions button').allTextContents(), ['寻找其他语言', '重新载入', '键盘快捷键']);
  await settings().getByRole('button', {name: '重新载入', exact: true}).click();
  await page.getByText('已触发重新载入', {exact: true}).waitFor();
  await settings().getByRole('button', {name: '键盘快捷键', exact: true}).click();
  await page.getByRole('dialog', {name: '键盘快捷键', exact: true}).waitFor();
  await page.keyboard.press('Escape'); await openSettings(); await openMore();
  await settings().getByRole('button', {name: '寻找其他语言', exact: true}).click();
  await page.getByText('已触发寻找其他语言', {exact: true}).waitFor();
  assert.equal(await settings().count(), 0); await shown(1, [1]);
});

test('continuous width fit uses both viewport edges without an artificial surface gutter', async () => {
  await reader(); await layout('连续'); await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await closeSettings(); await jump(1);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({width, height: 844}); await settle();
    const sizes = await viewport().evaluate(element => {
      const outer = element.getBoundingClientRect(), image = element.querySelector('.nc-manga-page').getBoundingClientRect();
      const surface = getComputedStyle(element.querySelector('.nc-reading-surface'));
      return {width: element.clientWidth, scroll: element.scrollWidth, left: image.left - outer.left, right: image.right - outer.left,
        padding: [surface.paddingTop, surface.paddingRight, surface.paddingBottom, surface.paddingLeft].map(parseFloat)};
    });
    assert.deepEqual(sizes.padding, [0, 0, 0, 0]); assert(sizes.scroll <= sizes.width + 1);
    assert(Math.abs(sizes.left) <= 1 && Math.abs(sizes.right - sizes.width) <= 1, `${width}: continuous width fit reaches both sides`);
  }
  await page.screenshot({path: resolve(artifacts, 'continuous-edge-to-edge-320.png')});
});
