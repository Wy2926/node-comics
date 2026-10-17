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
const pageNumber = () => page.getByRole('spinbutton', {name: '跳转页码', exact: true});
const settings = () => page.getByRole('dialog', {name: '阅读设置', exact: true});
const pageId = (number, chapter = 0) => `window-page-${chapter}-${number - 1}`;
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const snapshot = name => page.locator(`[data-testid="${name}"]`).textContent().then(JSON.parse);

async function reader({failure = false, long = false, chapters = false} = {}) {
  await page.goto(`${origin}/tests/reader-window-fixture.html?pagination=1${failure ? '&failure=1' : ''}${long ? '&long=1' : ''}${chapters ? '&chapters=2' : ''}`);
  await pageNumber().waitFor();
  await page.waitForFunction(async () => (await import('/src/shortcuts/store.ts')).getShortcutSnapshot().ready);
  await shown(1, [1]);
}

async function shown(number, visible, imageCount = visible.length, chapter = 0) {
  await page.waitForFunction(({number, visible, imageCount}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const pages = [...(viewport?.querySelectorAll('.nc-manga-page') || [])];
    const ids = pages.map(element => element.getAttribute('data-page-id'));
    const images = [...(viewport?.querySelectorAll('img.nc-page-image') || [])];
    return document.querySelector('[aria-label="跳转页码"]')?.value === String(number)
      && JSON.stringify(ids) === JSON.stringify(visible)
      && images.length === imageCount && images.every(image => image.complete && image.naturalWidth > 0)
      && !viewport?.querySelector('.nc-page-image-pending');
  }, {number, visible: visible.map(number => pageId(number, chapter)), imageCount});
  await settle();
}

async function openSettings() {
  await page.getByRole('button', {name: '阅读设置', exact: true}).click();
  await settings().waitFor();
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
async function jump(number) {
  await pageNumber().fill(String(number));
  await pageNumber().press('Enter');
  await settle();
}
async function assertFits(label) {
  const metrics = await viewport().evaluate(element => {
    const outer = element.getBoundingClientRect();
    return {width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
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
  for (const box of metrics.pages) {
    assert(box.left >= -1 && box.right <= metrics.width + 1, `${label}: full page width stays in the viewport`);
    assert(box.top >= -1 && box.bottom <= metrics.height + 1, `${label}: full page height stays in the viewport`);
  }
  for (const end of metrics.ends) {
    assert.equal(end.height, 0, `${label}: end sentinel cannot reserve footer space`);
    assert.equal(end.text, '', `${label}: pagination has no in-flow page-number/footer copy`);
  }
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

test('double pages default to manga RTL, separate the cover and landscape, and navigate by a whole spread', async () => {
  await reader(); await layout('双页阅读'); await shown(1, [1]);
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
  await reader(); await layout('双页阅读'); await jump(3); await shown(3, [2, 3]);
  await openSettings();
  await settings().getByRole('group', {name: '阅读方向', exact: true}).getByRole('button', {name: '从左向右', exact: true}).click();
  await closeSettings(); await shown(3, [2, 3]);
  const pair = await cells().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  assert(pair[0] < pair[1], 'Earlier page appears on the left in LTR');
  await page.keyboard.press('ArrowRight'); await shown(4, [4]);
  await page.keyboard.press('ArrowLeft'); await shown(2, [2, 3]);
});

test('a complete double spread fits desktop, narrow and short viewports without scrolling', async () => {
  await reader(); await layout('双页阅读'); await jump(2); await shown(2, [2, 3]);
  for (const size of [{width: 1280, height: 900}, {width: 360, height: 740}, {width: 1280, height: 360}]) {
    await page.setViewportSize(size); await settle(); await shown(2, [2, 3]);
    await assertFits(`${size.width}x${size.height}`);
    await page.screenshot({path: resolve(artifacts, `double-${size.width}x${size.height}.png`)});
  }
});

test('direct jumps, layout changes and reopen preserve the selected page identity inside a spread', async () => {
  await reader(); await layout('双页阅读'); await jump(3); await shown(3, [2, 3]);
  await layout('单页阅读'); await shown(3, [3]);
  await layout('双页阅读'); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), /^window-page-0-2 · 0\.000$/);
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(3, [2, 3]);
  await page.getByRole('button', {name: /^更新模拟翻译状态/}).click(); await shown(3, [2, 3]);
  await assertFits('reopened third-page selection');
});

test('double mode leaves saved single-page fit and zoom intact and hides irrelevant sizing controls', async () => {
  await reader(); await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await settings().getByRole('button', {name: '放大', exact: true}).click();
  await closeSettings(); await layout('双页阅读'); await shown(1, [1]);
  await openSettings();
  assert.equal(await settings().getByRole('group', {name: '图片适应方式', exact: true}).count(), 0);
  assert.equal(await settings().getByRole('button', {name: '放大', exact: true}).count(), 0);
  await closeSettings();
  await page.keyboard.press('='); await page.keyboard.press('w');
  await assertFits('double ignores single-page sizing shortcuts');
  await layout('单页阅读'); await openSettings();
  assert.equal(await settings().getByRole('group', {name: '图片适应方式', exact: true}).locator('[aria-pressed="true"]').textContent(), '铺满宽度');
  await settings().locator('.nc-reader-option').filter({hasText: '缩放'}).getByText('110%', {exact: true}).waitFor();
});

test('both spread pages are translation targets and four comparison images still fit the window', async () => {
  await reader(); await layout('双页阅读'); await jump(3); await shown(3, [2, 3]);
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.getByRole('button', {name: '翻译', exact: true}).click(); await shown(3, [2, 3]);
  await page.waitForFunction(() => {
    const value = JSON.parse(document.querySelector('[data-testid="reading-window"]').textContent);
    return value.targets?.[0] === 'window-page-0-1' && value.targets?.[1] === 'window-page-0-2';
  });
  const window = await snapshot('reading-window');
  assert.deepEqual(window.visible, [pageId(2), pageId(3)]);
  assert.equal(window.immediate, true);
  assert.equal(await viewport().locator('img.nc-page-image:not([data-result-job="original"])').count(), 2);
  await openSettings(); await settings().getByRole('switch', {name: '并排对照', exact: true}).click(); await closeSettings();
  await shown(3, [2, 3], 4); await assertFits('double comparison desktop');
  await page.setViewportSize({width: 360, height: 740}); await shown(3, [2, 3], 4); await assertFits('double comparison narrow');
  await page.screenshot({path: resolve(artifacts, 'double-comparison-narrow.png')});
});

test('one failed page does not block its partner or navigation and never marks the chapter read', async () => {
  await reader({failure: true}); await layout('双页阅读');
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
  await reader(); await layout('双页阅读'); await jump(7); await shown(7, [7, 8]);
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
  await reader(); await layout('双页阅读'); await jump(2); await shown(2, [2, 3]);
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
  await reader({long: true}); await layout('连续阅读'); await jump(9);
  await layout('单页阅读'); await shown(9, [9]);
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
  await layout('双页阅读'); await shown(9, [9]); await assertFits('long final page fitted into spread');
  assert.equal(await cells().count(), 1, 'No partner can mount and trigger another pageShown callback for this regression');
  assert.equal(await finalImage.getAttribute('src'), source, 'Changing geometry reuses the displayed image and does not fabricate a new load event');
  await page.waitForFunction(() => document.querySelector('[data-testid="marked-read"]').textContent === '["window-fixture-0"]');
});

test('one forward action from the final spread opens the next chapter cover without pairing across chapters', async () => {
  await reader({chapters: true}); await layout('双页阅读'); await jump(8); await shown(8, [7, 8]);
  assert(await page.getByRole('button', {name: '下一页', exact: true}).isEnabled());
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(1, [1], 1, 1);
  assert.equal(await viewport().locator('.nc-stream-chapter').count(), 1);
  assert.equal(await viewport().locator('.nc-stream-chapter').getAttribute('data-copy-id'), 'window-fixture-1');
  await assertFits('next chapter cover');
  await page.keyboard.press('PageDown'); await shown(2, [2, 3], 2, 1);
  assert.deepEqual(await snapshot('marked-read'), [], 'Skipping a chapter cannot mark it read while crossing the boundary');
});
