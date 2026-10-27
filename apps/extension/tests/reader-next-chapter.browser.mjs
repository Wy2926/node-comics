import {setReaderProgress} from './reader-progress-driver.mjs';
// Run with the isolated Vite fixture on 127.0.0.1:5181:
// node --test tests/reader-next-chapter.browser.mjs
// Synthetic descriptors/PNG bytes, isolated Chromium profile, no source or cloud API.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5181';
const artifacts = resolve(process.env.READER_NEXT_CHAPTER_ARTIFACTS || 'artifacts/reader-next-chapter');
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
    window.__chapterUrls = {active: new Set(), created: 0};
    URL.createObjectURL = blob => {const url = create(blob); window.__chapterUrls.active.add(url); window.__chapterUrls.created++; return url;};
    URL.revokeObjectURL = url => {window.__chapterUrls.active.delete(url); revoke(url);};
  });
});
afterEach(async () => {await page?.close(); assert.deepEqual(errors, []);});

const viewport = () => page.locator('.nc-reading-viewport');
const cells = () => viewport().locator('.nc-manga-page');
const pageNumber = () => page.getByRole('slider', {name: '阅读进度', exact: true});
const pageId = (number, chapter = 0) => `window-page-${chapter}-${number - 1}`;
const snapshot = name => page.locator(`[data-testid="${name}"]`).textContent().then(JSON.parse);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const manifestEvents = () => page.evaluate(() => window.__readerFixtureManifests.events);
const readEvents = () => page.evaluate(() => window.__readerFixtureReads.events);
const chapterReads = async chapter => [...new Set((await readEvents()).filter(event => event.phase === 'start' && event.key.startsWith(`inline-original:pagination-fixture-${chapter}-`)).map(event => event.key))];
const releaseManifest = chapter => page.evaluate(chapter => window.__readerFixtureManifests.release(chapter), chapter);

async function reader({layout = 'single', pages = 16, incomplete = false, hold = [], fail = []} = {}) {
  const query = new URLSearchParams({pagination: '1', chapters: '3', pages: String(pages), controlledReads: '1', lazyChapters: '1', initialLayout: layout});
  if (incomplete) query.set('incompleteCurrent', '1');
  if (hold.length) query.set('holdManifests', hold.join(','));
  if (fail.length) query.set('failManifests', fail.join(','));
  await page.goto(`${origin}/tests/reader-window-fixture.html?${query}`);
  await viewport().waitFor();
  await page.waitForFunction(async () => (await import('/src/shortcuts/store.ts')).getShortcutSnapshot().ready);
  if (layout !== 'continuous') await shown(1, [1]);
  // Startup may outlast immersive chrome's idle timer. Reveal through the real shortcut.
  await page.keyboard.press('Escape');
  await pageNumber().waitFor();
}
async function shown(number, visible, chapter = 0) {
  await page.waitForFunction(({number, visible}) => {
    const viewport = document.querySelector('.nc-reading-viewport');
    const pages = [...(viewport?.querySelectorAll('.nc-manga-page') || [])];
    const images = [...(viewport?.querySelectorAll('img.nc-page-image') || [])];
    return document.querySelector('[aria-label="阅读进度"]')?.value === String(number)
      && JSON.stringify(pages.map(element => element.dataset.pageId)) === JSON.stringify(visible)
      && images.length === visible.length && images.every(image => image.complete && image.naturalWidth > 0)
      && !viewport.querySelector('.nc-page-image-pending') && (viewport.dataset.swipePhase || 'idle') === 'idle';
  }, {number, visible: visible.map(number => pageId(number, chapter))});
  await settle();
}
async function jump(number) {await setReaderProgress(pageNumber(), String(number));  await settle();}
async function manifest(chapter, phase) {
  await page.waitForFunction(({chapter, phase}) => window.__readerFixtureManifests.events.some(event => event.id === `window-fixture-${chapter - 1}` && event.phase === phase), {chapter, phase});
}
async function read(chapter, number, phase = 'ready') {
  await page.waitForFunction(({chapter, number, phase}) => window.__readerFixtureReads.events.some(event => event.key === window.__readerFixtureReads.keyFor(number, false, chapter) && event.phase === phase), {chapter, number, phase});
}
async function assertNoThirdChapter() {
  assert(!(await manifestEvents()).some(event => event.id === 'window-fixture-2'), 'Prefetching the direct successor must not recursively discover the third chapter');
  assert.deepEqual(await chapterReads(2), [], 'The third chapter has no speculative byte reads');
}
async function assertCurrentOnly(number, visible) {
  await shown(number, visible);
  const state = await snapshot('chapter-state'), window = await snapshot('reading-window');
  assert.equal(state.active, 'window-fixture-0');
  assert.deepEqual(window.visible, visible.map(number => pageId(number)));
  assert(window.targets.every(id => id.startsWith('window-page-0-')), 'Next-chapter metadata never expands the current translation window');
  assert.deepEqual(await snapshot('marked-read'), [], 'Speculative work is not read evidence');
  assert.equal(await cells().count(), visible.length);
  assert.equal(Number(await viewport().getAttribute('data-decoded-pages')), visible.length);
  assert.equal(await page.evaluate(() => window.__chapterUrls.active.size), visible.length);
  assert.equal(await viewport().locator('.nc-stream-chapter').count(), 1);
  assert.equal(await viewport().locator('.nc-stream-chapter').getAttribute('data-copy-id'), 'window-fixture-0');
}

for (const layout of ['single', 'double']) {
  const group = number => layout === 'single' ? [number] : number === 14 ? [13, 14] : [15, 16];
  test(`${layout}: near-end metadata and last-group next-cover bytes are prepared without navigating or expanding image/translation windows`, async () => {
    await reader({layout, hold: [2]});
    await page.waitForTimeout(250);
    assert.deepEqual(await manifestEvents(), [], 'The opening pages do not discover next-chapter metadata');
    await jump(10); await shown(10, layout === 'single' ? [10] : [9, 10]);
    await page.waitForTimeout(250);
    assert.deepEqual(await manifestEvents(), [], 'Five following pages still fit in this chapter');
    await jump(14); await shown(14, group(14)); await manifest(2, 'start');
    const request = (await manifestEvents()).find(event => event.phase === 'start');
    assert.equal(request.speculative, true); assert.equal(request.hasSignal, true);
    assert.equal((await snapshot('chapter-state')).chapters[1].pages, 0);
    assert.deepEqual(await chapterReads(1), [], 'Bytes cannot be requested before a descriptor exists');
    await releaseManifest(2); await manifest(2, 'ready'); await read(1, 3); await page.waitForTimeout(250);
    assert.equal((await snapshot('chapter-state')).chapters[1].pages, 16);
    assert.deepEqual(await chapterReads(1), Array.from({length:3},(_,n)=>`inline-original:pagination-fixture-1-${n}`), 'Two current-chapter successors and three next-chapter pages fill the five extra slots');
    await assertCurrentOnly(14, group(14)); await assertNoThirdChapter();

    await jump(16); await shown(16, group(16)); await read(1, 5); await page.waitForTimeout(250);
    await assertCurrentOnly(16, group(16));
    assert.deepEqual(await chapterReads(1), Array.from({length:5},(_,n)=>`inline-original:pagination-fixture-1-${n}`), 'Five next-chapter originals are prefetched without extra display pages');
    await assertNoThirdChapter();
    await page.getByRole('button', {name: '完成模拟翻译', exact: true}).click();
    await page.getByRole('button', {name: '翻译', exact: true}).click(); await shown(16, group(16));
    await assertCurrentOnly(16, group(16));
    const translatedWindow = await snapshot('reading-window');
    assert(translatedWindow.targets.length > 0 && translatedWindow.targets.every(id => id.startsWith('window-page-0-')));
    assert(!(await readEvents()).some(event => event.key.startsWith('inline-original:pagination-fixture-result-window-page-1-')), 'Next-chapter byte preparation does not download or compose translated results');
    await page.getByRole('button', {name: '原图', exact: true}).click(); await shown(16, group(16));
    await page.screenshot({path: resolve(artifacts, `${layout}-last-page-next-cover-prefetched.png`)});

    await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(1, [1], 1);
    assert.equal((await snapshot('chapter-state')).active, 'window-fixture-1');
    assert.equal(await viewport().locator('.nc-stream-chapter').count(), 1);
    assert.equal(await viewport().locator('.nc-stream-chapter').getAttribute('data-copy-id'), 'window-fixture-1');
    await page.screenshot({path: resolve(artifacts, `${layout}-next-chapter-cover.png`)});
    await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(2, layout === 'single' ? [2] : [2, 3], 1);
    await assertNoThirdChapter();
    // inline-original fixture keys read IndexedDB directly. This is not evidence
    // of source-network deduplication; acquirePage lease sharing has unit coverage.
  });

  test(`${layout}: an incomplete current manifest never speculates across an unconfirmed chapter boundary`, async () => {
    await reader({layout, incomplete: true}); await jump(16); await shown(16, group(16)); await page.waitForTimeout(500);
    assert.deepEqual(await manifestEvents(), []); assert.deepEqual(await chapterReads(1), []);
    assert(await page.getByRole('button', {name: '下一页', exact: true}).isDisabled());
    await assertCurrentOnly(16, group(16)); await assertNoThirdChapter();
  });

  test(`${layout}: failed speculative discovery is quiet and formal chapter entry retries successfully`, async () => {
    await reader({layout, fail: [2]}); await jump(16); await shown(16, group(16)); await manifest(2, 'error');
    await page.waitForTimeout(350); await assertCurrentOnly(16, group(16));
    assert.equal((await manifestEvents()).filter(event => event.phase === 'start').length, 1, 'A failed lookahead does not spin in a retry loop');
    assert.equal((await snapshot('chapter-state')).chapters[1].pages, 0);
    assert.deepEqual(await chapterReads(1), []); assert.equal(await page.locator('span[role="status"]:not([class]):not([aria-live])').textContent(), '');
    await page.getByRole('button', {name: '下一页', exact: true}).click(); await shown(1, [1], 1); await manifest(2, 'ready');
    const attempts = (await manifestEvents()).filter(event => event.id === 'window-fixture-1' && event.phase === 'start');
    assert.deepEqual(attempts.map(event => event.speculative), [true, false], 'Foreground entry independently retries the failed speculative work');
    assert.deepEqual(await snapshot('marked-read'), []); await assertNoThirdChapter();
  });
}

for (const action of ['close', 'retreat']) test(`${action}: obsolete held discovery is aborted and its late completion cannot publish descriptors or read images`, async () => {
  const layout = action === 'close' ? 'single' : 'double';
  await reader({layout, hold: [2]}); await jump(16); await shown(16, layout === 'single' ? [16] : [15, 16]); await manifest(2, 'start');
  if (action === 'close') await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  else {await jump(1); await shown(1, [1]);}
  await manifest(2, 'abort'); await releaseManifest(2); await manifest(2, 'discarded'); await page.waitForTimeout(300);
  assert.equal((await snapshot('chapter-state')).chapters[1].pages, 0);
  assert.equal((await snapshot('chapter-state')).active, 'window-fixture-0');
  assert.deepEqual(await chapterReads(1), []); await assertNoThirdChapter();
  if (action === 'close') {assert.equal(await viewport().count(), 0); assert.equal(await page.evaluate(() => window.__chapterUrls.active.size), 0);}
  else await assertCurrentOnly(1, [1]);
});

test('closing while next-cover bytes are delayed releases all image URLs and late bytes stay detached', async () => {
  await reader();
  await page.evaluate(() => window.__readerFixtureReads.hold(1, false, 1));
  await jump(16); await shown(16, [16]); await read(1, 1, 'start');
  const created = await page.evaluate(() => window.__chapterUrls.created);
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__chapterUrls.active.size === 0);
  await page.evaluate(() => window.__readerFixtureReads.release(1, false, 1)); await read(1, 1); await page.waitForTimeout(300);
  assert.equal(await viewport().count(), 0); assert.equal(await page.evaluate(() => window.__chapterUrls.active.size), 0);
  assert.equal(await page.evaluate(() => window.__chapterUrls.created), created, 'Late speculative bytes must not create image URLs');
  assert.deepEqual(await snapshot('marked-read'), []); await assertNoThirdChapter();
});

test('entering the next chapter while its manifest is still loading promotes the same request instead of canceling or restarting it', async () => {
  await reader({hold: [2]}); await jump(16); await shown(16, [16]); await manifest(2, 'start');
  await page.getByRole('button', {name: '下一页', exact: true}).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="chapter-state"]').textContent).active === 'window-fixture-1');
  await page.waitForTimeout(200);
  let events = (await manifestEvents()).filter(event => event.id === 'window-fixture-1');
  assert.equal(events.filter(event => event.phase === 'start').length, 1);
  assert(!events.some(event => event.phase === 'abort'), 'The new foreground chapter still owns the pending request');
  await releaseManifest(2); await shown(1, [1], 1);
  events = (await manifestEvents()).filter(event => event.id === 'window-fixture-1');
  assert.equal(events.filter(event => event.phase === 'start').length, 1);
  assert.equal(events.find(event => event.phase === 'ready').speculative, false, 'Foreground promotion is visible through the shared load options');
  assert.deepEqual(await snapshot('marked-read'), []); await assertNoThirdChapter();
});

test('continuous reading prepares the next chapter before reaching it while decoded DOM stays within four forward pages', async () => {
  await reader({layout: 'continuous', pages: 8}); await manifest(2, 'ready'); await jump(6); await read(1, 1);
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.nc-reading-viewport'), images = [...viewport.querySelectorAll('img.nc-page-image')];
    return viewport.querySelectorAll('.nc-manga-page').length === 4 && images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  await read(1, 6); await page.waitForTimeout(250);
  const state = await snapshot('chapter-state');
  assert.equal(state.active, 'window-fixture-0'); assert.equal(await pageNumber().inputValue(), '6');
  assert.equal(state.chapters[1].pages, 8); assert.equal(state.chapters[2].pages, 0);
  assert.equal(await cells().count(), 4); assert.equal(Number(await viewport().getAttribute('data-decoded-pages')), 4);
  assert.equal(await page.evaluate(() => window.__chapterUrls.active.size), 4);
  assert.deepEqual(await chapterReads(1), Array.from({length: 6}, (_, index) => `inline-original:pagination-fixture-1-${index}`), 'One next-chapter decoded page plus five byte-only successors share the bounded window');
  assert.deepEqual(await snapshot('marked-read'), []); await assertNoThirdChapter();
  await page.screenshot({path: resolve(artifacts, 'continuous-cross-chapter-bounded-window.png')});
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.waitForFunction(() => window.__chapterUrls.active.size === 0);
});
