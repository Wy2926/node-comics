// Run with Vite serving the extension, then: node --test tests/select.keyboard.mjs
// SELECT_TEST_ORIGIN defaults to http://127.0.0.1:5176. Reuse an installed Playwright
// through PLAYWRIGHT_MODULE; CHROMIUM_PATH may select an existing desktop browser.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.SELECT_TEST_ORIGIN || 'http://127.0.0.1:5176';
let browser, page, errors;
before(async () => {
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {channel: 'chromium'})});
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'});
  page.setDefaultTimeout(5000);
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/select-fixture.html`);
  await page.getByRole('combobox', {name: '作品', exact: true}).waitFor();
});
afterEach(async () => { await page.close(); assert.deepEqual(errors, []); });
const work = () => page.getByRole('combobox', {name: '作品', exact: true});
async function listFor(control) { return page.locator(`[id="${await control.getAttribute('aria-controls')}"]`); }
async function active(control) { return page.locator(`[id="${await control.getAttribute('aria-activedescendant')}"]`).getAttribute('data-value'); }
async function choose(control, value) {
  await control.click();
  await (await listFor(control)).locator(`[role=option][data-value="${value}"]`).click();
}
async function focused(control) { assert(await control.evaluate(element => element === document.activeElement)); }
async function changes() { return JSON.parse(await page.locator('#changes').textContent()); }

test('native label names stay exact before, during and after selection, including external labels and localization', async () => {
  assert.equal(await page.getByLabel('作品', {exact: true}).count(), 1);
  assert.equal(await page.getByRole('combobox', {name: '外部标签', exact: true}).count(), 1);
  assert.equal(await work().getAttribute('title'), 'Choose a work');
  assert.equal(await work().getAttribute('aria-describedby'), 'work-help');
  await work().click();
  assert.equal(await page.getByRole('combobox', {name: '作品', exact: true}).count(), 1);
  await (await listFor(work())).locator('[data-value=banana]').click();
  assert.equal(await page.getByLabel('作品', {exact: true}).getAttribute('data-value'), 'banana');
  await focused(work());
  await page.getByRole('button', {name: 'Translate label'}).click();
  assert.equal(await page.getByLabel('Work', {exact: true}).getAttribute('data-value'), 'banana');
  const ids = await page.getByRole('combobox').evaluateAll(elements => elements.map(element => element.getAttribute('aria-controls')));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(await page.locator('select').count(), 0);
});

test('arrows skip disabled options, Home/End navigate, Enter commits once and Escape cancels without losing focus', async () => {
  await work().focus();
  await work().press('ArrowDown'); assert.equal(await active(work()), 'apple');
  await work().press('ArrowDown'); assert.equal(await active(work()), 'banana');
  await work().press('ArrowUp'); assert.equal(await active(work()), 'apple');
  await work().press('End'); assert.equal(await active(work()), 'cherry');
  await work().press('Home'); assert.equal(await active(work()), 'apple');
  await work().press('ArrowDown'); await work().press('Enter');
  assert.equal(await work().getAttribute('data-value'), 'banana');
  assert.equal(await work().getAttribute('value'), 'banana');
  assert.equal(await work().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await changes(), [{target: {value: 'banana', name: 'work', id: 'work'}, currentTarget: {value: 'banana', name: 'work', id: 'work'}}]);
  await work().press('Space'); await work().press('End'); await work().press('Escape');
  assert.equal(await work().getAttribute('data-value'), 'banana');
  assert.equal((await changes()).length, 1);
  await focused(work());
  await work().press('Enter'); await work().press('Enter');
  assert.equal((await changes()).length, 1);
  assert.equal(await page.locator('body').getAttribute('data-unhandled-keys'), null);
});

test('type-ahead handles prefixes, repeated letters and its timeout while skipping disabled options', async () => {
  await work().focus();
  await work().press('b'); assert.equal(await active(work()), 'banana');
  await work().press('b'); assert.equal(await active(work()), 'blueberry');
  await work().press('Enter');
  await work().press('b'); await work().press('l'); assert.equal(await active(work()), 'blueberry');
  await page.waitForTimeout(750);
  await work().press('a'); assert.equal(await active(work()), 'apple');
  await work().press('a'); assert.equal(await active(work()), 'apple');
  await work().press('Escape');
  assert.equal(await work().getAttribute('data-value'), 'blueberry');
});

test('Tab and Shift+Tab commit with natural focus traversal, while outside click cancels', async () => {
  await work().focus(); await work().press('End'); await work().press('Tab');
  assert.equal(await work().getAttribute('data-value'), 'cherry'); await focused(page.locator('#after'));
  await work().focus(); await work().press('Home'); await work().press('Shift+Tab');
  assert.equal(await work().getAttribute('data-value'), 'apple'); await focused(page.locator('#before'));
  await work().click(); await work().press('End'); await page.locator('#before').click();
  assert.equal(await work().getAttribute('data-value'), 'apple');
  assert.equal(await work().getAttribute('aria-expanded'), 'false');
});

test('disabled controls/options, empty lists, controlled values and form values behave consistently', async () => {
  assert(await page.getByRole('combobox', {name: '禁用选择'}).isDisabled());
  assert(await page.getByRole('combobox', {name: '空选项'}).isDisabled());
  await work().click();
  const list = await listFor(work());
  assert.equal(await list.locator('[data-value=apricot]').getAttribute('aria-disabled'), 'true');
  assert.equal(await list.locator('[data-value=date]').getAttribute('aria-disabled'), 'true');
  assert.equal(await list.locator('[data-value=hidden]').count(), 0);
  // Programmatic event also must not select a disabled item.
  await list.locator('[data-value=apricot]').dispatchEvent('click');
  assert.equal((await changes()).length, 0);
  await work().press('Escape');
  await page.getByRole('button', {name: 'External value'}).click();
  assert.equal(await work().getAttribute('data-value'), 'cherry');
  assert.equal(await page.locator('#select-form').evaluate(form => new FormData(form).get('work')), 'cherry');
  await work().click();
  await page.getByRole('button', {name: 'Toggle disabled'}).dispatchEvent('click');
  assert(await work().isDisabled()); assert(!(await list.isVisible()));
  assert.equal(await page.locator('#select-form').evaluate(form => new FormData(form).get('work')), null);
  await page.getByRole('button', {name: 'Toggle disabled'}).click();
  await page.getByRole('button', {name: 'Toggle options'}).click(); assert(await work().isDisabled());
  await choose(page.getByRole('combobox', {name: '显式标签'}), 'Two');
  assert.equal(await work().getAttribute('data-value'), 'Two');
});

test('popover escapes clipped modal containers, keeps focus and consumes Escape before the dialog', async () => {
  await page.getByRole('button', {name: 'Open dialog'}).click();
  const control = page.getByRole('combobox', {name: '弹窗作品', exact: true});
  await control.click();
  const list = await listFor(control);
  assert(await list.evaluate(element => element.matches(':popover-open')));
  const box = await list.boundingBox(), dialog = await page.getByRole('dialog').boundingBox();
  assert(box.y + box.height > dialog.y + dialog.height);
  await list.locator('[data-value=cherry]').click();
  assert.equal(await control.getAttribute('data-value'), 'cherry'); await focused(control);
  await control.click(); await control.press('Home'); await control.press('Escape');
  assert(await page.getByRole('dialog').isVisible()); assert(!(await list.isVisible()));
  assert.equal(await control.getAttribute('data-value'), 'cherry'); await focused(control);
});

test('long lists flip above viewport edge and scroll only options; light/dark focus has a single border', async () => {
  const control = page.getByRole('combobox', {name: '长列表'});
  await control.click(); const list = await listFor(control);
  const box = await list.boundingBox(), trigger = await control.boundingBox();
  assert(box.y + box.height <= trigger.y); assert(box.x + box.width <= 1280);
  const before = await page.evaluate(() => window.scrollY);
  await control.press('End'); assert.equal(await active(control), '39');
  assert(await list.evaluate(element => element.scrollTop > 0));
  assert.equal(await page.evaluate(() => window.scrollY), before);
  await control.press('Escape');
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => { document.documentElement.dataset.appearance = mode; }, mode);
    await work().click();
    const style = await work().evaluate(element => {
      const css = getComputedStyle(element);
      return {outline: css.outlineStyle, border: css.borderWidth, radius: css.borderRadius, shadow: css.boxShadow, color: css.borderColor, accent: css.getPropertyValue('--accent').trim()};
    });
    assert.equal(style.outline, 'none'); assert.equal(style.shadow, 'none'); assert.equal(style.border, '2px'); assert.equal(style.radius, '5px');
    const rgb = style.accent.slice(1).match(/../g).map(value => parseInt(value, 16));
    assert.equal(style.color, `rgb(${rgb.join(', ')})`);
    assert.equal(await (await listFor(work())).locator('[aria-selected=true] .nc-select-check').evaluate(element => getComputedStyle(element).visibility), 'visible');
    if (process.env.SELECT_SCREENSHOT_DIR) {
      await mkdir(process.env.SELECT_SCREENSHOT_DIR, {recursive: true});
      await page.screenshot({path: `${process.env.SELECT_SCREENSHOT_DIR}/select-${mode}.png`});
    }
    await work().press('Escape');
  }
});

test('shared language controls work with popup sizing and the same option helper', async () => {
  const target = page.getByRole('combobox', {name: '默认目标语言', exact: true});
  assert.equal(Math.round((await target.boundingBox()).width), 148);
  await choose(target, 'en'); assert.equal(await target.getAttribute('data-value'), 'en'); await focused(target);
  assert.equal(await target.getAttribute('aria-describedby'), 'work-help');
  const language = page.getByRole('combobox', {name: '界面语言', exact: true});
  await choose(language, 'zh-CN');
  await page.waitForFunction(() => document.querySelector('[aria-label="界面语言"]').dataset.value === 'zh-CN');
  assert(!(await language.isDisabled()));
});
