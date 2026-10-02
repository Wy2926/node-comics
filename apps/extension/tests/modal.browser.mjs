// Vite must run at 127.0.0.1:5181. Only this synthetic origin is permitted.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5181';
let browser, page, errors;
before(async () => {browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});});
after(async () => {await browser?.close();});
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce', serviceWorkers: 'block'});
  page.setDefaultTimeout(7000);errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/modal-fixture.html`);
  await page.locator('#open-long').waitFor();
});
afterEach(async () => {await page.close();assert.deepEqual(errors, []);});

const dialog = () => page.locator('dialog.nc-generic-modal');
const body = () => dialog().locator('.nc-modal-body');
const close = () => dialog().locator('.modal-close');
const rail = id => page.locator(`.nc-scrollbar-y[aria-controls="${id}"]`);
async function settle() {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
async function open(id = 'open-long') {
  await page.locator(`#${id}`).click();await dialog().waitFor();await settle();
}
async function moveRailToEnd(target) {
  const id = await target.getAttribute('id');await rail(id).waitFor();
  await rail(id).focus();await page.keyboard.press('End');await settle();
}

test('scrolling long content leaves close fixed, keeps the page still and restores the opener', async () => {
  await page.locator('#open-long').scrollIntoViewIfNeeded();await settle();
  const before = await page.evaluate(() => scrollY);
  await open();
  const initialClose = await close().boundingBox(), initialBody = await body().boundingBox();
  assert(initialClose.y + initialClose.height <= initialBody.y + 1);
  assert(await close().evaluate(element => element === document.activeElement));
  // Aim at the title, not the independently scrollable textarea in the body.
  await page.mouse.move(initialBody.x + 20, initialBody.y + 30);await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('.nc-modal-body').scrollTop > 100);
  await moveRailToEnd(body());
  assert(await page.locator('#modal-end').isVisible());
  assert.deepEqual(await close().boundingBox(), initialClose);
  assert.equal(await dialog().evaluate(element => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), before);
  const bodyId = await body().getAttribute('id'), bodyRail = await rail(bodyId).boundingBox();
  assert(bodyRail.y >= initialBody.y - 1);
  await close().click();
  assert.equal(await dialog().count(), 0);
  assert(await page.locator('#open-long').evaluate(element => element === document.activeElement));
  assert.equal(await page.evaluate(() => scrollY), before);
});

test('nested Select consumes Escape first, and native cancel respects the consumer close guard', async () => {
  await open('open-guarded');
  const select = page.getByRole('combobox', {name: '夹具选项'});await select.click();
  assert.equal(await select.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await select.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#close-attempts').textContent(), '0');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#close-attempts').textContent(), '1');assert(await dialog().isVisible());
  await close().click();assert.equal(await page.locator('#close-attempts').textContent(), '2');assert(await dialog().isVisible());
  await page.getByRole('button', {name: '允许关闭', exact: true}).click();await page.keyboard.press('Escape');
  assert.equal(await dialog().count(), 0);
  assert(await page.locator('#open-guarded').evaluate(element => element === document.activeElement));
});

test('local import retains its bounded list, correct decoration and reachable footer', async () => {
  await open('open-import');
  const initialClose = await close().boundingBox(), list = page.getByRole('list', {name: '导入文件清单'});
  assert.equal(await dialog().locator('.modal-spark').isVisible(), false);
  assert(await list.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 100));
  await moveRailToEnd(list);
  assert(await list.evaluate(element => element.scrollTop > 100));
  await body().evaluate(element => {element.scrollTop = element.scrollHeight;});await settle();
  assert.deepEqual(await close().boundingBox(), initialClose);
  const footer = await dialog().locator('.nc-import-footer').boundingBox(), viewport = await body().boundingBox();
  assert(footer.y + footer.height <= viewport.y + viewport.height + 1);
  await close().click();assert.equal(await dialog().count(), 0);
  assert(await page.locator('#open-import').evaluate(element => element === document.activeElement));
});

test('short dark large-font windows keep close visible while titles and form content scroll', async () => {
  await page.setViewportSize({width: 520, height: 320});
  await page.evaluate(() => {document.documentElement.dataset.appearance = 'dark';document.documentElement.dataset.accent = 'iris';document.documentElement.style.setProperty('--text-scale', '1.5');});
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/);
  await open();
  const button = await close().boundingBox(), viewport = await body().boundingBox();
  assert(button.y >= 0 && button.y + button.height < 320 && button.x + button.width < 520);
  assert(viewport.height > 70);
  assert(await body().evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await body().focus();await page.keyboard.press('Control+End');await settle();
  await moveRailToEnd(body());
  assert.deepEqual(await close().boundingBox(), button);
  const end = await page.locator('#modal-end').boundingBox();
  assert(end.y >= viewport.y && end.y + end.height <= viewport.y + viewport.height + 1);
  await close().click();assert.equal(await dialog().count(), 0);
});

test('shared shell CSS preserves closed-dialog hiding and independent Login layout', async () => {
  await open();
  await dialog().evaluate(element => element.close());await settle();
  assert.equal(await dialog().isVisible(), false);
  await page.reload();await page.setViewportSize({width: 1280, height: 360});
  await page.locator('#open-login').click();
  const login = page.locator('dialog.nc-login');await login.waitFor();
  assert.equal(await login.locator('.nc-modal-body,.nc-modal-controls').count(), 0);
  assert.deepEqual(await login.evaluate(element => ({display: getComputedStyle(element).display, overflow: getComputedStyle(element).overflowY, padding: getComputedStyle(element).paddingTop})), {display: 'block', overflow: 'auto', padding: '0px'});
  assert(await login.evaluate(element => element.scrollHeight > element.clientHeight));
  await page.keyboard.press('Escape');assert.equal(await login.count(), 0);
});
