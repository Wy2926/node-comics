import {setReaderProgress} from './reader-progress-driver.mjs';
// Start the isolated Vite fixture on 127.0.0.1:5181, then run from apps/extension:
// node --test tests/reader-swipe.browser.mjs
// Uses PLAYWRIGHT_MODULE / CHROMIUM_PATH, synthetic images and real CDP touch input.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5181';
const artifacts = resolve(process.env.READER_SWIPE_ARTIFACTS || 'artifacts/reader-swipe');
let browser, page, errors, touch;
const observations = [];
before(async () => {
  await mkdir(artifacts, {recursive: true});
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
});
after(async () => {
  await browser?.close();
  if (observations.length) console.log('Measured local animation/resource observations:', JSON.stringify({
    samples: observations.length,
    enteringToIdleMs: {min: Math.min(...observations.map(item => item.durationMs)), max: Math.max(...observations.map(item => item.durationMs))},
    peakPageDOM: Math.max(...observations.map(item => item.pages)),
    peakDisplayedImages: Math.max(...observations.map(item => item.images)),
    peakActiveBlobURLs: Math.max(...observations.map(item => item.urls)),
    note: 'Synthetic local PNGs; measures transition frames and retained resources, not source-network or image-loading acceleration.'
  }));
});
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block'});
  page.setDefaultTimeout(7000);
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  touch = await page.context().newCDPSession(page);
  await page.addInitScript(() => {
    localStorage.setItem('isolated-pagination-fixture', JSON.stringify({mode: 'classic', preference: 'original', fit: 'window', zoom: 100}));
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.__swipeUrls = {active: new Set(), revoked: new Set(), created: 0};
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.__swipeUrls.active.add(url);
      window.__swipeUrls.created++;
      return url;
    };
    URL.revokeObjectURL = url => {
      window.__swipeUrls.active.delete(url);
      window.__swipeUrls.revoked.add(url);
      revoke(url);
    };
    window.__swipeTrace = [];
    window.__swipeEvents = [];
    window.__swipePointer = null;
    document.addEventListener('pointerdown', event => {window.__swipePointer = {id: event.pointerId, type: event.pointerType};}, true);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) document.addEventListener(type, event => {
      window.__swipeEvents.push({type, pointer: event.pointerType, primary: event.isPrimary, button: event.button,
        x: event.clientX, y: event.clientY, target: event.target.className});
      if (window.__swipeEvents.length > 30) window.__swipeEvents.shift();
    }, true);
    // Sample library leaf geometry each animation frame; this is not a physical paint trace.
    const sample = () => {
      const viewport = document.querySelector('.nc-reading-viewport');
      const surface = viewport?.querySelector('.nc-reading-surface');
      if (surface) {
        const snapshot = viewport.querySelector('[data-swipe-snapshot]');
        const offset = element => {
          const value = element && getComputedStyle(element).transform;
          return !value || value === 'none' ? 0 : new DOMMatrixReadOnly(value).m41;
        };
        const bounds = viewport.getBoundingClientRect();
        const visible = root => {
          if (!root || getComputedStyle(root).visibility === 'hidden' || getComputedStyle(root).opacity === '0') return false;
          return [...root.querySelectorAll('img.nc-page-image, .nc-image-placeholder, .nc-image-failure')].some(element => {
            if (element instanceof HTMLImageElement && (!element.complete || !element.naturalWidth)) return false;
            const box = element.getBoundingClientRect();
            return Math.min(bounds.right, box.right) - Math.max(bounds.left, box.left) > 1
              && Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top) > 1;
          });
        };
        const x = offset(surface), oldX = snapshot ? offset(snapshot) : null;
        const ready = [...surface.querySelectorAll('.nc-comparison-pane')].every(pane =>
          !!pane.querySelector('.nc-image-failure') || [...pane.querySelectorAll('img.nc-page-image')].some(image => image.complete && image.naturalWidth > 0));
        const frame = {time: performance.now(), phase: viewport.dataset.swipePhase || 'idle', x,
          pages: [...surface.querySelectorAll('.nc-manga-page')].map(element => element.dataset.pageId),
          oldX, oldImages: snapshot?.querySelectorAll('[data-flip-face=outgoing] img.nc-page-image').length || 0,
          oldVisible: visible(snapshot), currentVisible: visible(surface), ready,
          fold: [...snapshot?.querySelectorAll('.stf__item') || []].map(leaf => `${getComputedStyle(leaf).transform}:${getComputedStyle(leaf).clipPath}`).join('|'),
          turnStatus: viewport.querySelectorAll('.nc-page-turn-status').length,
          pageDOM: surface.querySelectorAll('[data-page-id]').length, width: viewport.clientWidth,
          images: viewport.querySelectorAll('img.nc-page-image').length, urls: window.__swipeUrls.active.size,
          read: document.querySelector('[data-testid="marked-read"]')?.textContent || '[]'};
        const previous = window.__swipeTrace.at(-1);
        if (frame.phase !== 'idle' || !previous || previous.phase !== frame.phase || Math.abs(previous.x - x) > .5 || previous.pages.join() !== frame.pages.join() || previous.read !== frame.read) {
          window.__swipeTrace.push(frame);
          if (window.__swipeTrace.length > 1000) window.__swipeTrace.shift();
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
});
afterEach(async () => {await page?.close(); assert.deepEqual(errors, []);});

const viewport = () => page.locator('.nc-reading-viewport');
const surface = () => viewport().locator('.nc-reading-surface');
const oldLayer = () => viewport().locator('[data-swipe-snapshot]');
const cells = () => surface().locator('.nc-manga-page');
const pageNumber = () => page.getByRole('slider', {name: '阅读进度', exact: true});
const settings = () => page.getByRole('dialog', {name: '阅读设置', exact: true});
const pageId = (number, chapter = 0) => `window-page-${chapter}-${number - 1}`;
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const resetTrace = () => page.evaluate(() => {window.__swipeTrace = [];});
const trace = () => page.evaluate(() => window.__swipeTrace);
const idle = () => page.waitForFunction(() => !document.querySelector('.nc-reading-viewport')?.hasAttribute('data-swipe-phase'));

async function reader({failure = false, long = false, chapters = false, controlled = false, pages, holdPages = [], holdResults = [], failResults = []} = {}) {
  await page.goto(`${origin}/tests/reader-window-fixture.html?pagination=1${failure ? '&failure=1' : ''}${long ? '&long=1' : ''}${chapters ? '&chapters=2' : ''}${pages === 16 ? '&pages=16' : ''}${controlled ? `&controlledReads=1&holdPages=${holdPages.join(',')}&holdResults=${holdResults.join(',')}&failResults=${failResults.join(',')}` : ''}`);
  await viewport().waitFor();
  await page.waitForFunction(async () => (await import('/src/shortcuts/store.ts')).getShortcutSnapshot().ready);
  await shown(1, [1]);
  // Startup may outlast immersive chrome's idle timer. Reveal through the real shortcut.
  await page.keyboard.press('Escape');
  await pageNumber().waitFor();
  assert.equal(await page.locator('.nc-page-turn-status').count(), 0, 'No blocking page-preparation notice is mounted');
}
async function selected(number, visible, chapter = 0) {
  await page.waitForFunction(({number, visible}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const surface = viewport?.querySelector('.nc-reading-surface');
    return document.querySelector('[aria-label="阅读进度"]')?.value === String(number)
      && JSON.stringify([...(surface?.querySelectorAll('.nc-manga-page') || [])].map(element => element.dataset.pageId)) === JSON.stringify(visible)
      && !viewport?.hasAttribute('data-swipe-phase') && !viewport?.querySelector('[data-swipe-snapshot]')
      && getComputedStyle(surface).visibility !== 'hidden';
  }, {number, visible: visible.map(number => pageId(number, chapter))}, {timeout: 1500});
  await settle();
  assert.equal(await page.locator('.nc-page-turn-status').count(), 0);
}
async function shown(number, visible, imageCount = visible.length, chapter = 0) {
  try {await page.waitForFunction(({number, visible, imageCount}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const surface = viewport?.querySelector('.nc-reading-surface');
    const ids = [...(surface?.querySelectorAll('.nc-manga-page') || [])].map(element => element.dataset.pageId);
    const images = [...(surface?.querySelectorAll('img.nc-page-image') || [])];
    return document.querySelector('[aria-label="阅读进度"]')?.value === String(number)
      && JSON.stringify(ids) === JSON.stringify(visible)
      && images.length === imageCount && images.every(image => image.complete && image.naturalWidth > 0)
      && !surface?.querySelector('.nc-page-image-pending') && !viewport?.hasAttribute('data-swipe-phase')
      && !viewport?.querySelector('[data-swipe-snapshot]');
  }, {number, visible: visible.map(number => pageId(number, chapter)), imageCount});}
  catch (error) {
    console.log('Swipe fixture diagnostic:', await page.evaluate(() => {
      const element = document.querySelector('.nc-reading-viewport');
      return {number: document.querySelector('[aria-label="阅读进度"]')?.value, phase: element?.dataset.swipePhase,
        width: element?.clientWidth, scrollWidth: element?.scrollWidth, touchAction: element && getComputedStyle(element).touchAction,
        scale: window.visualViewport?.scale, events: window.__swipeEvents, trace: window.__swipeTrace.slice(-12)};
    }));
    throw error;
  }
  await settle();
}
async function openSettings() {
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: '阅读设置', exact: true}).click();
  await settings().waitFor();
}
async function openMore() {
  const more = settings().locator('details.nc-reader-more');
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
async function jump(number) {
  await page.keyboard.press('Escape');
  await setReaderProgress(pageNumber(), String(number));

  await settle();
}
async function point(x = .5, y = .5) {
  const box = await viewport().boundingBox();
  assert(box, 'Reading viewport is visible');
  return {x: box.x + box.width * x, y: box.y + box.height * y, width: box.width, height: box.height};
}
async function mouseDrag(distance, {release = true, start = distance>0?.15:.85, vertical = 0} = {}) {
  if(Math.abs(distance)>=200){
    const span=await cells().evaluateAll(elements=>{const boxes=elements.map(element=>element.getBoundingClientRect());return Math.max(...boxes.map(box=>box.right))-Math.min(...boxes.map(box=>box.left));});
    distance=Math.sign(distance)*Math.max(Math.abs(distance),span*.65);
  }
  const from = await point(start);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + distance, from.y + vertical, {steps: 8});
  await settle();
  if (release) await page.mouse.up();
  return from;
}
async function touchMove(points, type = 'touchMove') {
  await touch.send('Input.dispatchTouchEvent', {type, touchPoints: points.map(({x, y, id = 1}) => ({x, y, id, radiusX: 2, radiusY: 2, force: 1}))});
}
async function touchDrag(dx, dy = 0, {release = true, start = .5, y = .5} = {}) {
  const from = await point(start, y);
  await touchMove([from], 'touchStart');
  for (let step = 1; step <= 8; step++) {
    await touchMove([{x: from.x + dx * step / 8, y: from.y + dy * step / 8}]);
    await page.waitForTimeout(16);
  }
  await settle();
  if (release) await touchMove([], 'touchEnd');
  return from;
}
async function assertAnimation(sign, {dragged = false} = {}) {
  const frames = await trace(), phases = new Set(frames.map(frame => frame.phase));
  if (dragged) assert(phases.has('dragging'), 'The reader recognizes horizontal swipe intent');
  assert(phases.has('entering'), `Library curl missing: ${[...phases]}`);
  assert(!phases.has('preparing'), 'Image loading must not create a navigation-wait phase');
  assert(frames.every(frame => frame.turnStatus === 0), 'No blocking preparation notice');
  const motion = frames.filter(frame => frame.phase === 'entering');
  assert(new Set(motion.map(frame => frame.fold)).size >= 3, 'The library changes real paper transforms and clipping across frames');
  assert(motion.every(frame => frame.oldVisible || frame.currentVisible), 'Pixels or page-local loading/error states remain visible');
  assert(motion.every(frame => frame.oldX !== null), 'The bounded visual layer remains until completion');
  assert(frames.every(frame => Math.abs(frame.x) < .1), 'The live reading surface is never translated by a competing animation');
  const start = motion[0], end = frames.find(frame => frame.time > start.time && frame.phase === 'idle');
  assert(end, 'A completed curl has an observed idle frame');
  assert(end.time-start.time < 800, 'A healthy engine completes before the safety cleanup deadline');
  observations.push({sign,durationMs: Number((end.time-start.time).toFixed(1)),
    pages: Math.max(...frames.map(frame=>frame.pageDOM)),images: Math.max(...frames.map(frame=>frame.images)),urls: Math.max(...frames.map(frame=>frame.urls))});
}
async function assertNoLateNavigation(number, visible, imageCount = visible.length) {
  await page.waitForTimeout(400);
  await shown(number, visible, imageCount);
}
async function releaseRead(number, result = false) {
  await page.evaluate(({number, result}) => window.__readerFixtureReads.release(number, result), {number, result});
}
async function entering(number) {
  await page.waitForFunction(number => {
    const viewport = document.querySelector('.nc-reading-viewport');
    return viewport?.dataset.swipePhase === 'entering' && document.querySelector('[aria-label="阅读进度"]')?.value === String(number)
      && !!viewport.querySelector('[data-swipe-snapshot] .stf__item');
  }, number);
}
async function assertSnapshot({imageCount, urls} = {}) {
  const value = await oldLayer().evaluate(element => {
    const matrix = getComputedStyle(element).transform;
    return {hidden: element.getAttribute('aria-hidden'), inert: element.inert, visible: getComputedStyle(element).visibility !== 'hidden',
      identities: element.querySelectorAll('[data-page-id],[data-page-index],[id]').length,
      x: matrix === 'none' ? 0 : new DOMMatrixReadOnly(matrix).m41,
      images: [...element.querySelectorAll('[data-flip-face=outgoing] img.nc-page-image')].map(image => ({url: image.src, ready: image.complete && image.naturalWidth > 0})),
      urlsActive: [...window.__swipeUrls.active]};
  });
  assert.equal(value.hidden, 'true'); assert.equal(value.inert, true);
  assert.equal(value.visible, true); assert.equal(value.identities, 0, 'Snapshot cannot masquerade as reader identity/evidence');
  if (imageCount !== undefined) assert.equal(value.images.length, imageCount);
  assert(value.images.every(image => image.ready), 'The outgoing image remains usable during the bounded animation');
  if (urls) for (const url of urls) assert(value.urlsActive.includes(url), 'Snapshot explicitly retains the old image URL until cleanup');
}

test('mouse single-page LTR and RTL swipes animate in reading order and preserve one-page resource bounds', async () => {
  await reader();
  await resetTrace(); await mouseDrag(-230); await shown(2, [2]); await assertAnimation(-1, {dragged: true});
  assert((await trace()).every(frame => frame.pageDOM <= 2 && frame.urls <= 2), 'Single-page animation retains only the old snapshot plus the new page');
  assert.equal(await oldLayer().count(), 0, 'No speculative neighbor DOM remains while idle');
  await direction('从右向左');
  await resetTrace(); await mouseDrag(230); await shown(3, [3]); await assertAnimation(1, {dragged: true});
  await resetTrace(); await mouseDrag(-230); await shown(2, [2]); await assertAnimation(-1, {dragged: true});
});

test('mouse double-page gestures move the entire RTL spread, respect landscape pages, and support LTR', async () => {
  await reader(); await direction('从右向左'); await layout('双页'); await jump(2); await shown(2, [2, 3]);
  const positions = await cells().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  await resetTrace(); await mouseDrag(230, {release: false});
  assert.equal(await viewport().getAttribute('data-swipe-phase'), 'dragging');
  const dragged = await cells().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  assert(dragged.every((x,index)=>Math.abs(x-positions[index])<1), 'The live surface keeps its layout while library paper faces follow the pointer');
  assert(new Set((await trace()).filter(frame=>frame.phase==='dragging').map(frame=>frame.fold)).size>=3, 'Held pointer movement visibly updates the curl before navigation');
  assert.equal(await pageNumber().inputValue(),'2','Holding the fold does not commit navigation');
  await page.screenshot({path: resolve(artifacts, 'double-mouse-drag.png')});
  await page.mouse.up(); await shown(4, [4]); await assertAnimation(1, {dragged: true});
  assert((await trace()).every(frame => frame.pageDOM <= 4 && frame.urls <= 4), 'Spread animation retains at most old and new groups');
  assert.equal(await oldLayer().count(), 0);
  await direction('从左向右');
  await resetTrace(); await mouseDrag(-230); await shown(5, [5, 6]); await assertAnimation(-1, {dragged: true});
  await resetTrace(); await mouseDrag(230); await shown(4, [4]); await assertAnimation(1, {dragged: true});
});

test('navigation buttons and keyboard use the same outgoing/incoming animation as gestures', async () => {
  await reader();
  await resetTrace(); await page.getByRole('button', {name: '下一页', exact: true}).click();
  await shown(2, [2]); await assertAnimation(-1);
  await resetTrace(); await page.keyboard.press('PageDown'); await shown(3, [3]); await assertAnimation(-1);
  await direction('从右向左'); await layout('双页'); await shown(3, [2, 3]);
  await resetTrace(); await page.keyboard.press('ArrowLeft'); await shown(4, [4]); await assertAnimation(1);
  await resetTrace(); await page.getByRole('button', {name: '上一页', exact: true}).click();
  await shown(2, [2, 3]); await assertAnimation(-1);
});

test('short and boundary swipes leave the page in place without toggling reader chrome', async () => {
  await reader(); await page.keyboard.press('Escape');
  await resetTrace(); await mouseDrag(-14, {release: false});
  await page.waitForTimeout(120); await page.mouse.up(); await shown(1, [1]);
  assert(!(await trace()).some(frame => frame.phase === 'exiting'), 'Short non-flick drags do not navigate');
  assert.equal(await page.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden')), false, 'Drag-generated click does not hide controls');
  await resetTrace(); await mouseDrag(150, {release: false});
  const offset = await viewport().locator('.nc-reading-surface').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);
  assert.equal(offset, 0, 'An unavailable boundary leaves the page in place');
  await page.mouse.up(); await shown(1, [1]);
  assert(!(await trace()).some(frame => frame.phase === 'exiting'), 'First page cannot navigate backwards');
  await jump(8); await shown(8, [8]);
  await resetTrace(); await mouseDrag(-180); await shown(8, [8]);
  assert(!(await trace()).some(frame => frame.phase === 'exiting'), 'Last page cannot navigate forwards');
});

test('a plain mouse click still hides and reveals immersive controls after a completed drag', async () => {
  await reader(); await mouseDrag(-230); await shown(2, [2]);
  await page.keyboard.press('Escape');
  const center = await point();
  await page.mouse.click(center.x, center.y);
  await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
  await page.mouse.click(center.x, center.y);
  await page.waitForFunction(() => !document.querySelector('.nc-reader').classList.contains('controls-hidden'));
  await shown(2, [2]);
});

test('mobile CDP touch swipes animate single pages and RTL double spreads without synthetic pointer input', async () => {
  await page.setViewportSize({width: 390, height: 844}); await reader();
  await resetTrace(); await touchDrag(-140); await shown(2, [2]); await assertAnimation(-1, {dragged: true});
  assert.equal(await page.evaluate(() => window.__swipePointer.type), 'touch');
  await direction('从右向左'); await layout('双页'); await shown(2, [2, 3]);
  await resetTrace(); await touchDrag(140); await shown(4, [4]); await assertAnimation(1, {dragged: true});
  await resetTrace(); await touchDrag(-140); await shown(2, [2, 3]); await assertAnimation(-1, {dragged: true});
  await page.screenshot({path: resolve(artifacts, 'mobile-double-settled.png')});
});

test('vertical touch pans a long single page natively without turning pages or shifting it horizontally', async () => {
  await page.setViewportSize({width: 390, height: 844}); await reader({long: true}); await jump(9); await shown(9, [9]);
  await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  await closeSettings(); await shown(9, [9]);
  assert(await viewport().evaluate(element => element.scrollHeight > element.clientHeight + 500));
  await resetTrace(); await touchDrag(15, -230, {y: .7});
  await page.waitForFunction(() => document.querySelector('.nc-reading-viewport').scrollTop > 50);
  await shown(9, [9]);
  assert((await trace()).every(frame => frame.phase === 'idle'), 'A vertical gesture never starts the page turn');
  try {await page.waitForFunction(() => Number(document.querySelector('[aria-label="保存位置"]').textContent.split(' · ')[1]) > 0);}
  catch (error) {
    console.log('Long-page pan diagnostic:', await page.evaluate(() => {
      const viewport = document.querySelector('.nc-reading-viewport'), cell = viewport.querySelector('.nc-manga-page');
      return {saved: document.querySelector('[aria-label="保存位置"]').textContent, top: viewport.scrollTop,
        height: viewport.clientHeight, scrollHeight: viewport.scrollHeight,
        cellTop: cell.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        cellHeight: cell.getBoundingClientRect().height, events: window.__swipeEvents, trace: window.__swipeTrace.slice(-12)};
    }));
    throw error;
  }
  // Wait for native momentum to finish before comparing the saved/reopened position.
  await page.waitForTimeout(500);
  const metrics = await viewport().evaluate(element => ({top: element.scrollTop, left: element.scrollLeft}));
  assert.equal(metrics.left, 0); assert(metrics.top > 50);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  const saved = await page.locator('[aria-label="保存位置"]').textContent();
  assert.match(saved, /^window-page-0-8 · 0\./);
  assert(Number(saved.split(' · ')[1]) > 0, 'A native pan saves the true long-page offset');
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(9, [9]);
  assert(Math.abs((await viewport().evaluate(element => element.scrollTop)) - metrics.top) < 2, 'Reopening restores the pan position, not an animation transform');
});

test('a second real touch cancels the page turn and leaves multi-touch to the browser', async () => {
  await page.setViewportSize({width: 390, height: 844}); await reader();
  await resetTrace(); const from = await touchDrag(-100, 0, {release: false});
  assert.equal(await viewport().getAttribute('data-swipe-phase'), 'dragging', JSON.stringify(await page.evaluate(() => ({events: window.__swipeEvents, trace: window.__swipeTrace}))));
  await touchMove([{x: from.x - 100, y: from.y, id: 1}, {x: from.x + 40, y: from.y + 40, id: 2}], 'touchStart');
  await touchMove([{x: from.x - 120, y: from.y, id: 1}, {x: from.x + 60, y: from.y + 40, id: 2}]);
  await touchMove([], 'touchEnd'); await assertNoLateNavigation(1, [1]);
  assert(!(await trace()).some(frame => frame.phase === 'exiting'), 'Pinch cancellation cannot accidentally commit a swipe');
  // The browser may actually zoom after taking over the two-finger gesture; a zoomed
  // visual viewport intentionally disables swipes. Reset zoom before testing recovery.
  await touch.send('Emulation.setPageScaleFactor', {pageScaleFactor: 1});
  await page.waitForFunction(() => window.visualViewport.scale === 1);
  await resetTrace(); await touchDrag(-140); await shown(2, [2]); await assertAnimation(-1, {dragged: true});
});

test('touchCancel and window blur cancel pending drags with no delayed navigation', async () => {
  await page.setViewportSize({width: 390, height: 844}); await reader();
  await touchDrag(-120, 0, {release: false});
  await touchMove([], 'touchCancel'); await assertNoLateNavigation(1, [1]);
  await mouseDrag(-140, {release: false});
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up(); await assertNoLateNavigation(1, [1]);
  await mouseDrag(-140); await shown(2, [2]);
});

test('horizontal overflow keeps native touch panning instead of stealing it for page navigation', async () => {
  await page.setViewportSize({width: 390, height: 844}); await reader();
  await openSettings();
  await settings().getByRole('group', {name: '图片适应方式', exact: true}).getByRole('button', {name: '铺满宽度', exact: true}).click();
  for (let step = 0; step < 10; step++) await settings().getByRole('button', {name: '放大', exact: true}).click();
  await closeSettings(); await shown(1, [1]);
  const before = await viewport().evaluate(element => ({left: element.scrollLeft, max: element.scrollWidth - element.clientWidth}));
  assert(before.max > 100, 'Fixture genuinely overflows horizontally');
  const distance = before.left < before.max / 2 ? -140 : 140;
  await resetTrace(); await touchDrag(distance); await assertNoLateNavigation(1, [1]);
  const after = await viewport().evaluate(element => element.scrollLeft);
  assert(Math.abs(after - before.left) > 30, `Native horizontal pan should move: ${before.left} -> ${after}`);
  assert((await trace()).every(frame => frame.phase === 'idle'), 'Overflow pan never enters the page turn');
});

test('direct page selection cancels an entrance without allowing late image bytes to overwrite the selection', async () => {
  await reader({controlled: true, holdPages: [2]}); await resetTrace();
  await page.getByRole('button', {name: '下一页', exact: true}).click();
  await entering(2);
  await setReaderProgress(pageNumber(), '5');
  await releaseRead(2);
  await assertNoLateNavigation(5, [5]);
  await mouseDrag(-230); await shown(6, [6]);
});

test('opening settings, changing layout and closing the reader cancel unfinished gestures', async () => {
  await reader(); await mouseDrag(-230, {release: false});
  await page.keyboard.press('s');
  await page.mouse.up();
  await settings().waitFor();
  await settings().getByRole('group', {name: '阅读布局', exact: true}).getByRole('button', {name: '双页', exact: true}).click();
  await closeSettings(); await assertNoLateNavigation(1, [1]);
  await mouseDrag(-230, {release: false});
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).evaluate(element => element.click());
  await page.mouse.up(); await page.waitForTimeout(400);
  assert.equal(await viewport().count(), 0);
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), /^window-page-0-0 · 0\.000$/);
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(1, [1]);
});

test('visibility loss removes an animation snapshot without undoing an already selected loading page', async () => {
  await reader({controlled: true, holdPages: [2]});
  await page.getByRole('button', {name: '下一页', exact: true}).click();
  await entering(2);
  // Exercise the lifecycle signal deterministically; touch tests above use native CDP input.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await oldLayer().count(), 0);
  await releaseRead(2); await assertNoLateNavigation(2, [2]);
  await page.evaluate(() => {delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));});
  await mouseDrag(-230); await shown(3, [3]);
});

test('reduced motion selects a permanently loading page immediately and permits another turn without animation', async () => {
  await page.emulateMedia({reducedMotion: 'reduce'}); await reader({controlled: true, holdPages: [2]}); await resetTrace();
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await selected(2, [2]);
  assert.equal(await surface().locator('img.nc-page-image').count(), 0);
  assert.equal(await oldLayer().count(), 0);
  assert((await trace()).every(frame => frame.phase === 'idle'), 'Reduced motion never waits for images or runs a curl');
  await resetTrace(); await mouseDrag(-230); await shown(3, [3]);
  assert(!(await trace()).some(frame => frame.phase === 'entering'), 'Reduced motion commits the gesture without a transition');
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(2) && event.phase === 'ready')), false, 'The unavailable page was skipped without releasing its byte gate');
});

test('a failed half-spread can still be swiped away and repeated navigation releases old image URLs', async () => {
  await reader({failure: true}); await direction('从右向左'); await layout('双页'); await jump(5); await shown(5, [5, 6], 1);
  await viewport().getByText('图片暂不可用', {exact: true}).waitFor();
  const old = await viewport().locator('img.nc-page-image').evaluateAll(images => images.map(image => image.src));
  await resetTrace(); await mouseDrag(230); await shown(7, [7, 8]); await assertAnimation(1, {dragged: true});
  await page.waitForFunction(urls => urls.every(url => window.__swipeUrls.revoked.has(url)), old);
  for (let iteration = 0; iteration < 4; iteration++) {
    await mouseDrag(-230); await shown(5, [5, 6], 1);
    await mouseDrag(230); await shown(7, [7, 8]);
    assert.equal(await cells().count(), 2);
    await page.waitForFunction(() => window.__swipeUrls.active.size <= 2);
  }
  assert.deepEqual(await page.locator('[data-testid="marked-read"]').textContent().then(JSON.parse), [], 'Loading or swiping cannot fabricate chapter-read evidence');
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
  await idle();
});

test('dragging an interactive error action does not steal its gesture or turn the page', async () => {
  await reader({failure: true}); await jump(6); await shown(6, [6], 0);
  const action = viewport().getByRole('button', {name: '重新导入', exact: true});
  const box = await action.boundingBox(); assert(box);
  await resetTrace(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 180, box.y + box.height / 2, {steps: 8});
  await page.mouse.up(); await assertNoLateNavigation(6, [6], 0);
  assert((await trace()).every(frame => frame.phase === 'idle'), 'A control-origin gesture never starts the page turn');
  await action.click();
  await page.getByRole('status').filter({hasText: '本地样本导入入口'}).waitFor();
});

test('the final page cannot mark the chapter read until the incoming animation has settled', async () => {
  await reader();
  for (const number of [2, 3, 4, 5, 6, 7]) {await jump(number); await shown(number, [number]);}
  assert.deepEqual(await page.locator('[data-testid="marked-read"]').textContent().then(JSON.parse), []);
  await resetTrace(); await page.getByRole('button', {name: '下一页', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.nc-reading-viewport').dataset.swipePhase === 'entering');
  assert.deepEqual(await page.locator('[data-testid="marked-read"]').textContent().then(JSON.parse), [], 'An entering last page is not yet shown evidence');
  await shown(8, [8]);
  await page.waitForFunction(() => document.querySelector('[data-testid="marked-read"]').textContent === '["window-fixture-0"]');
  const frames = await trace();
  assert(frames.some(frame => frame.phase === 'entering' && frame.pages.includes(pageId(8))), 'The final page was observed during its real entrance');
  assert(frames.filter(frame => frame.phase === 'entering').every(frame => frame.read === '[]'), 'No intermediate entrance frame falsely records completion');
});

test('repeated navigation shortcuts during an animation are consumed without native scrolling or queued turns', async () => {
  await reader();
  const handled = await page.evaluate(() => {
    const press = (code, repeat = false) => {
      const event = new KeyboardEvent('keydown', {key: code, code, repeat, bubbles: true, cancelable: true});
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return [press('PageDown'), press('PageDown', true), press('ArrowRight', true), press('PageUp', true)];
  });
  assert.deepEqual(handled, [true, true, true, true], 'Every matching key is consumed while a turn is in flight');
  await shown(2, [2]);
  await assertNoLateNavigation(2, [2]);
});

for (const cancel of ['Escape', 'Home']) test(`canceling a loaded final-page entrance with ${cancel} reconciles only the remaining visible page`, async () => {
  await reader();
  for (const number of [2, 3, 4, 5, 6, 7]) {await jump(number); await shown(number, [number]);}
  await page.getByRole('button', {name: '下一页', exact: true}).click();
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.nc-reading-viewport');
    if (viewport?.dataset.swipePhase !== 'entering' || document.querySelector('[aria-label="阅读进度"]').value !== '8') return false;
    return true;
  });
  await page.waitForFunction(() => document.querySelector('[data-page-index="7"] img.nc-page-image')?.naturalWidth > 0);
  assert.equal(await page.locator('[data-testid="marked-read"]').textContent(), '[]');
  await page.keyboard.press(cancel);
  await shown(cancel === 'Home' ? 1 : 8, [cancel === 'Home' ? 1 : 8]);
  assert.equal(await page.locator('[data-testid="marked-read"]').textContent(), cancel === 'Home' ? '[]' : '["window-fixture-0"]');
});

test('a permanently loading original finishes its curl and can be skipped without a preparation overlay', async () => {
  await reader({controlled: true, holdPages: [2]});
  const oldUrls = await surface().locator('img.nc-page-image').evaluateAll(images => images.map(image => image.src));
  await resetTrace(); await page.getByRole('button', {name: '下一页', exact: true}).click(); await selected(2, [2]);
  assert.equal(await surface().locator('img.nc-page-image').count(), 0);
  assert.equal(await surface().locator('.nc-image-placeholder').count(), 1, 'Only the selected page reports its local image load');
  await assertAnimation(-1);
  assert((await trace()).some(frame => frame.phase === 'entering' && !frame.ready), 'The curl genuinely runs while the original is unavailable');
  await page.waitForFunction(urls => urls.every(url => window.__swipeUrls.revoked.has(url)), oldUrls);
  assert.equal(await oldLayer().count(), 0);
  await page.screenshot({path: resolve(artifacts, 'pending-original-navigation-unblocked.png')});
  await page.keyboard.press('PageDown'); await shown(3, [3]);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(2) && event.phase === 'ready')), false, 'The source read remains pending even after successful onward navigation');
  assert.equal(await page.locator('[data-testid="marked-read"]').textContent(), '[]', 'A skipped loading page supplies no reading evidence');
});

test('a released swipe curls the old page even when the incoming image never loads', async () => {
  await reader({controlled: true, holdPages: [2]}); await resetTrace();
  await mouseDrag(-230, {release: false});
  await page.mouse.up(); await entering(2); await assertSnapshot({imageCount:1});
  await selected(2,[2]); await assertAnimation(-1,{dragged:true});
  await mouseDrag(-230); await shown(3,[3]);
});

test('a permanently loading translation does not hold a single-page turn or block the next turn', async () => {
  await reader({controlled: true, holdResults: [2]});
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.keyboard.press('t'); await shown(1, [1]);
  await page.waitForFunction(() => document.querySelector('.nc-reading-surface img.nc-page-image')?.dataset.resultJob === 'result-window-page-0-0');
  await resetTrace(); await page.keyboard.press('PageDown'); await shown(2, [2]);
  assert.equal(await surface().locator('img.nc-page-image').getAttribute('data-result-job'), 'original', 'A fresh page displays its original while the translated bytes remain pending');
  await assertAnimation(-1);
  await page.screenshot({path: resolve(artifacts, 'pending-translation-navigation-unblocked.png')});
  await page.keyboard.press('PageDown'); await shown(3, [3]);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(2, true) && event.phase === 'ready')), false, 'The translated-image gate was never released to unblock navigation');
  assert.equal(await page.locator('[data-testid="marked-read"]').textContent(), '[]');
});

test('double-page comparison shows independent original fallbacks while a source and translated result remain pending', async () => {
  await reader({controlled: true, holdPages: [7], holdResults: [8]});
  await direction('从右向左'); await layout('双页'); await jump(5); await shown(5, [5, 6]);
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await openSettings(); await openMore(); await settings().getByRole('switch', {name: '并排对照', exact: true}).click(); await closeSettings();
  await shown(5, [5, 6], 4);
  const oldUrls = await surface().locator('img.nc-page-image').evaluateAll(images => images.map(image => image.src));
  await resetTrace(); await page.keyboard.press('PageDown'); await selected(7, [7, 8]);
  await page.waitForFunction(() => document.querySelectorAll('.nc-reading-surface img.nc-page-image').length === 3);
  assert.equal(await surface().locator('.nc-image-placeholder').count(), 1, 'Only the unavailable original pane needs a placeholder; the delayed translated pane displays its available original');
  assert.deepEqual(await surface().locator('[data-page-id="window-page-0-7"] img.nc-page-image').evaluateAll(images => images.map(image => image.dataset.resultJob)), ['original', 'original']);
  await assertAnimation(1);
  const frames = await trace();
  assert(frames.every(frame => frame.pageDOM <= 4 && frame.images <= 8 && frame.urls <= 8), 'Only old/new comparison groups can overlap');
  assert(frames.some(frame => frame.phase === 'entering' && frame.oldImages === 4 && !frame.ready), 'All old comparison pixels move while incoming panes are still loading');
  await page.waitForFunction(urls => urls.every(url => window.__swipeUrls.revoked.has(url)), oldUrls);
  await page.screenshot({path: resolve(artifacts, 'pending-double-comparison-navigation-unblocked.png')});
  await page.keyboard.press('PageUp'); await shown(5, [5, 6], 4);
  assert.equal(await page.evaluate(() => [[7, false], [8, true]].some(([number, result]) => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(number, result) && event.phase === 'ready'))), false, 'Neither pending pane had to finish before turning back');
  await page.waitForFunction(() => window.__swipeUrls.active.size === 4);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});

test('closing during a held read disposes the snapshot and late bytes cannot recreate the reader or its URLs', async () => {
  await reader({controlled: true, holdPages: [2]});
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await entering(2);
  await assertSnapshot({imageCount: 1});
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  assert.equal(await viewport().count(), 0);
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
  await releaseRead(2); await page.waitForTimeout(400);
  assert.equal(await viewport().count(), 0);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 0, 'Canceled background completion must not create an orphan URL');
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await shown(2, [2]);
});

test('single-page lookahead reads only next-page bytes without extra idle image DOM or URLs', async () => {
  await reader({controlled: true});
  await page.waitForFunction(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(2) && event.phase === 'ready'));
  await page.waitForTimeout(150);
  await shown(1, [1]);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 1);
  assert.equal(await oldLayer().count(), 0);
  assert.deepEqual(await page.locator('[data-testid="reading-window"]').textContent().then(JSON.parse), {targets: [], visible: [pageId(1)], immediate: true});
  const reads = await page.evaluate(() => window.__readerFixtureReads.events.filter(event => event.phase === 'start').map(event => event.key));
  assert.deepEqual([...new Set(reads)].sort(), ['inline-original:pagination-fixture-0-0', 'inline-original:pagination-fixture-0-1']);
  await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(2, [2]);
  // Fixture inline keys do not use the production acquirePage lease-sharing path:
  // a foreground IndexedDB get is allowed here and is not a duplicate source-network request.
  await jump(8); await shown(8, [8]); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(9))), false, 'The final page has no speculative successor');
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  const count = await page.evaluate(() => window.__readerFixtureReads.events.filter(event => event.phase === 'start').length);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.filter(event => event.phase === 'start').length), count, 'Closing prevents further speculative reads');
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 0);
});

test('double-page byte lookahead stays within the next spread and creates no speculative image URLs', async () => {
  await reader({controlled: true}); await direction('从右向左'); await layout('双页'); await jump(5); await shown(5, [5, 6]);
  await page.waitForFunction(() => [7, 8].every(number => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(number) && event.phase === 'ready')));
  await page.waitForTimeout(150); await shown(5, [5, 6]);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 2);
  assert.equal(await oldLayer().count(), 0);
  assert.deepEqual((await page.locator('[data-testid="reading-window"]').textContent().then(JSON.parse)).visible, [pageId(5), pageId(6)]);
  await resetTrace(); await page.keyboard.press('PageDown'); await shown(7, [7, 8]); await assertAnimation(1);
  assert((await trace()).every(frame => frame.urls <= 4), 'Old/new spread overlap has a four-URL ceiling');
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(9))), false, 'A final spread does not invent another prefetch target');
});

test('continuous layout uses the same bounded byte lookahead after its eleven decoded pages', async () => {
  await reader({controlled: true, pages: 16}); await layout('连续');
  await shown(1, Array.from({length: 11}, (_, index) => index + 1));
  await page.waitForFunction(() => [12, 13].every(number => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(number) && event.phase === 'ready')));
  await page.waitForTimeout(200);
  const readKeys = await page.evaluate(() => [...new Set(window.__readerFixtureReads.events.filter(event => event.phase === 'start').map(event => event.key))].sort());
  assert.deepEqual(readKeys, Array.from({length: 13}, (_, index) => `inline-original:pagination-fixture-0-${index}`).sort(), 'Only the eleven rendered pages and two immediate byte successors may be read');
  assert.equal(await cells().count(), 11);
  assert.equal(Number(await viewport().getAttribute('data-decoded-pages')), 11);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 11);
  assert.equal(await oldLayer().count(), 0);
  await layout('单页'); await shown(1, [1]);
  await page.waitForFunction(() => window.__swipeUrls.active.size === 1);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});

const originalFirstLayouts = [
  {name: 'single', label: '单页', number: 2, visible: [2], next: [3]},
  {name: 'double', label: '双页', number: 5, visible: [5, 6], next: [7, 8]},
  {name: 'continuous', label: '连续', number: 1, visible: Array.from({length: 11}, (_, index) => index + 1), next: [12, 13]}
];
const primaryImage = number => surface().locator(`[data-page-id="${pageId(number)}"] .nc-comparison-pane:last-child img.nc-page-image`);
async function pixels(number, result = false) {
  await page.waitForFunction(({id, job}) => {
    const image = document.querySelector(`.nc-reading-surface [data-page-id="${id}"] .nc-comparison-pane:last-child img.nc-page-image`);
    return image?.dataset.resultJob === job && image.complete && image.naturalWidth > 0;
  }, {id: pageId(number), job: result ? `result-${pageId(number)}` : 'original'});
}
async function enterTranslatedLayout(config) {
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.keyboard.press('t');
  if (config.name !== 'single') await layout(config.label);
  if (config.number !== 1) await jump(config.number);
  await shown(config.number, config.visible);
}
async function readyOriginals(numbers) {
  await page.waitForFunction(numbers => numbers.every(number => window.__readerFixtureReads.events.some(event =>
    event.key === window.__readerFixtureReads.keyFor(number) && event.phase === 'ready')), numbers);
}

for (const config of originalFirstLayouts) test(`${config.name}: originals are visible and byte lookahead continues while translated results remain unavailable`, async () => {
  await reader({controlled: true, pages: 16, holdResults: config.visible});
  await enterTranslatedLayout(config);
  for (const number of config.visible) await pixels(number);
  const originalUrls = await surface().locator('img.nc-page-image').evaluateAll(images => images.map(image => image.src));
  const before = await page.locator('[data-testid="reading-window"]').textContent();
  await readyOriginals(config.next);
  assert.equal(await page.locator('[data-testid="reading-window"]').textContent(), before, 'Byte prefetch cannot enlarge the automatic-translation or decoded window');
  assert.equal(await cells().count(), config.visible.length);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), config.visible.length, 'Speculative original bytes create neither image elements nor decoded blob URLs');
  assert.equal(await page.evaluate(numbers => numbers.some(number => window.__readerFixtureReads.events.some(event =>
    event.key === window.__readerFixtureReads.keyFor(number, true) && event.phase === 'ready')), config.visible), false);
  assert.equal(await surface().locator('.nc-image-placeholder').count(), 0, 'Available originals do not become loading placeholders merely because a translation is pending');
  await page.screenshot({path: resolve(artifacts, `original-first-${config.name}-pending-translation.png`)});
  const box = await primaryImage(config.number).boundingBox();
  const scroll = await viewport().evaluate(element => ({top: element.scrollTop, left: element.scrollLeft}));
  await releaseRead(config.number, true); await pixels(config.number, true); await settle();
  const after = await primaryImage(config.number).boundingBox();
  assert(Math.abs(after.x - box.x) < 1 && Math.abs(after.y - box.y) < 1 && Math.abs(after.width - box.width) < 1 && Math.abs(after.height - box.height) < 1, 'The ready result replaces pixels in the same page geometry');
  assert.deepEqual(await viewport().evaluate(element => ({top: element.scrollTop, left: element.scrollLeft})), scroll, 'The replacement does not change the reading position');
  assert.equal(await pageNumber().inputValue(), String(config.number));
  assert.equal(await page.locator('[data-testid="marked-read"]').textContent(), '[]');
  await page.waitForFunction(url => window.__swipeUrls.revoked.has(url), originalUrls[0]);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
  for (const number of config.visible) await releaseRead(number, true);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__swipeUrls.active.size), 0, 'Late translated bytes cannot recreate URLs after the reader closes');
});

for (const config of originalFirstLayouts) test(`${config.name}: failed translated reads retain originals and manual image retry replaces only the matching page`, async () => {
  await reader({controlled: true, pages: 16, failResults: Array.from({length: 16}, (_, index) => index + 1)});
  await enterTranslatedLayout(config);
  for (const number of config.visible) await pixels(number);
  const cell = surface().locator(`[data-page-id="${pageId(config.number)}"]`);
  await cell.locator('.nc-image-failure').waitFor();
  const originalUrl = await primaryImage(config.number).getAttribute('src');
  const before = await primaryImage(config.number).boundingBox();
  await readyOriginals(config.next);
  await cell.locator('.nc-image-failure').getByRole('button', {name: '重试', exact: true}).click();
  await pixels(config.number, true); await settle();
  assert.equal(await cell.locator('.nc-image-failure').count(), 0);
  const after = await primaryImage(config.number).boundingBox();
  assert(Math.abs(after.y - before.y) < 1 && Math.abs(after.height - before.height) < 1, 'Retry does not jump or resize the current page');
  for (const number of config.visible.filter(number => number !== config.number)) await pixels(number);
  const events = await page.evaluate(number => window.__readerFixtureReads.events.filter(event =>
    event.key === window.__readerFixtureReads.keyFor(number, true)).map(event => event.phase), config.number);
  assert.deepEqual(events, ['start', 'error', 'start', 'ready'], 'Retry reuses the same result identity without a second translation job');
  assert.equal(await pageNumber().inputValue(), String(config.number));
  await page.waitForFunction(url => window.__swipeUrls.revoked.has(url), originalUrl);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});

test('same-page translation progress and failure never remove existing original pixels; a ready result replaces in place', async () => {
  await reader({controlled: true, holdResults: [1]});
  const originalUrl = await primaryImage(1).getAttribute('src');
  await page.keyboard.press('t');
  for (let revision = 0; revision < 4; revision++) {
    await page.getByRole('button', {name: `更新模拟翻译状态 ${revision}`, exact: true}).click();
    await pixels(1);
    assert.equal(await primaryImage(1).getAttribute('src'), originalUrl, 'Status-only updates do not reread or replace the displayed original');
  }
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await pixels(1); await readyOriginals([2]);
  assert.equal(await primaryImage(1).getAttribute('src'), originalUrl, 'Publishing a remote result reference does not clear available pixels');
  const before = await primaryImage(1).boundingBox();
  await releaseRead(1, true); await pixels(1, true); await settle();
  assert.deepEqual(await primaryImage(1).boundingBox(), before);
  assert.equal(await pageNumber().inputValue(), '1');
  const reads = await page.evaluate(() => window.__readerFixtureReads.events.filter(event => event.key === window.__readerFixtureReads.keyFor(1) && event.phase === 'start').length);
  assert.equal(reads, 1, 'The displayed original lease is reused across status and target updates');
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});

test('a translation arriving before its original is displayed immediately and never regresses when late original bytes finish', async () => {
  await reader({controlled: true, holdPages: [2], holdResults: [2]});
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.keyboard.press('t'); await pixels(1, true);
  await page.keyboard.press('PageDown'); await selected(2, [2]);
  assert.equal(await primaryImage(2).count(), 0, 'Both image sources are deliberately unavailable');
  await releaseRead(2, true); await pixels(2, true); await shown(2, [2]);
  const translatedUrl = await primaryImage(2).getAttribute('src');
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event =>
    event.key === window.__readerFixtureReads.keyFor(2) && event.phase === 'ready')), false);
  await releaseRead(2); await readyOriginals([2]); await page.waitForTimeout(100);
  assert.equal(await primaryImage(2).getAttribute('src'), translatedUrl);
  await pixels(2, true);
  await page.screenshot({path: resolve(artifacts, 'translated-first-late-original-no-regression.png')});
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
  await pixels(2, true); await shown(2, [2]);
  assert.match(await page.locator('[aria-label="保存位置"]').textContent(), /^window-page-0-1 · 0\.000$/);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});

test('a fast translated-read failure does not promote speculative work ahead of its still-loading original', async () => {
  await reader({controlled: true, holdPages: [2], failResults: [2]});
  await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
  await page.keyboard.press('t'); await pixels(1, true);
  await page.keyboard.press('PageDown'); await selected(2, [2]);
  await page.waitForFunction(() => window.__readerFixtureReads.events.some(event =>
    event.key === window.__readerFixtureReads.keyFor(2, true) && event.phase === 'error'));
  await page.waitForTimeout(250);
  assert.equal(await primaryImage(2).count(), 0);
  assert.equal(await page.evaluate(() => window.__readerFixtureReads.events.some(event =>
    event.key === window.__readerFixtureReads.keyFor(3) && event.phase === 'start')), false, 'A failed translated candidate is not proof that the original read handed off');
  await releaseRead(2); await pixels(2); await readyOriginals([3]);
  assert.equal(await pageNumber().inputValue(), '2');
  await surface().locator('.nc-image-failure').getByRole('button', {name: '重试', exact: true}).click();
  await pixels(2, true);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__swipeUrls.active.size === 0);
});
