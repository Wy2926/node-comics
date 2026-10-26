// Run against extension Vite (:5181). Isolated browser, synthetic model catalog;
// no account, external HTTP, translation, or production settings are used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {selectOption} from './select_helpers.mjs';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = process.env.TEST_READER_URL || 'http://127.0.0.1:5181';
const origin = new URL(web).origin;
assert(['localhost', '127.0.0.1'].includes(new URL(web).hostname), 'Use a local preview');
const out = path.resolve('artifacts/settings-validation');
await mkdir(out, {recursive: true});
const {version} = JSON.parse(await readFile('apps/extension/package.json', 'utf8'));
const dictionaries = 'apps/extension/src/i18n/dictionaries';
const browser = await chromium.launch({headless: true, executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH});
const checks = [], errors = [], measurements = [];
const check = message => { checks.push(message); console.log('PASS ' + message); };
const modelName = 'Fixture model with a deliberately long translated display name';
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
const mock = route => {
  const url = new URL(route.request().url());
  if (url.origin === origin) return route.continue();
  if (url.pathname === '/v1/capabilities') return route.fulfill({json: {
    result_protocol: 'overlay-v1',
    modes: [{id: 'classic', label: 'Classic', enabled: true}],
    languages: [{id: 'zh-Hans', label: '简体中文'}, {id: 'ja', label: '日本語'}, {id: 'en', label: 'English'}],
    limits: {max_bytes: 10000000, max_pixels: 100000000, max_dimension: 20000, max_translation_ids: 32},
    entitlements: null,
    translation_models: [
      {id: 'fixture-model', name: modelName, available: true, requires_paid: false},
      {id: 'locked-model', name: 'Locked fixture model', available: false, requires_paid: true, unavailable_reason: 'not_allowed'},
    ],
  }});
  return route.fulfill({status: 503, contentType: 'application/json', body: '{}'});
};
await context.route(/^https?:/, mock);
await context.addInitScript(version => {
  if (!localStorage.getItem('nc-settings')) localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'ja', appearance: 'light'}));
  localStorage.setItem('nc-release-notes-version', version);
}, version);
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => errors.push(error.message));
const shot = name => page.screenshot({path: path.join(out, name + '.png')});
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const combo = label => page.getByRole('combobox', {name: label, exact: true});
const trigger = page.locator('.nc-model-trigger');

async function geometry(locale, width, scale) {
  await page.setViewportSize({width, height: 1000});
  await settle();
  const value = await page.locator('.nc-preferences').evaluate(root => {
    const rect = element => { const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom}; };
    const theme = root.querySelector('.nc-theme-row'), description = theme.firstElementChild;
    const model = root.querySelector('.nc-model-trigger');
    const target = root.querySelector('.nc-channel-settings .setting-row .nc-select');
    const zoom = root.querySelector('.nc-scale-control');
    return {page: rect(root), contentWidth: root.scrollWidth, row: rect(theme), description: rect(description), colors: rect(root.querySelector('.nc-theme-options')),
      zoom: rect(zoom), zoomParts: [...zoom.children].map(rect),
      model: rect(model), target: rect(target), font: parseFloat(getComputedStyle(document.documentElement).fontSize)};
  });
  assert(value.page.x >= -1 && value.page.right <= width + 1, `${locale}: settings outside viewport`);
  assert(value.contentWidth <= value.page.width + 1, `${locale}: settings content overflows`);
  assert(value.zoom.x >= value.page.x && value.zoom.right <= value.page.right + 1, `${locale}: zoom control overflows`);
  const [minus, percentage, plus] = value.zoomParts;
  assert(minus.right <= percentage.x && percentage.right <= plus.x, `${locale}: zoom buttons must flank the percentage`);
  assert([minus, plus].every(button => button.width >= 44 && button.height >= 44), `${locale}: zoom buttons need a touch target`);
  assert(value.description.width >= value.row.width * .9, `${locale}: theme description is squeezed`);
  assert(value.colors.y >= value.description.bottom, `${locale}: theme choices squeeze the description`);
  assert(Math.abs(value.model.width - value.target.width) < 1, `${locale}: model and target controls differ in width`);
  assert(Math.abs(value.model.right - value.target.right) < 1, `${locale}: model and target controls are not aligned`);
  if (width > 700) assert(value.model.width <= 20 * value.font + 1, `${locale}: model exceeds the desktop control width`);
  measurements.push({locale, width, scale, themeHeight: value.row.height, descriptionWidth: value.description.width, modelWidth: value.model.width});
}

try {
  await page.goto(web + '/#settings');
  await trigger.waitFor();
  assert.equal(await page.locator('.nc-preferences .page-title').count(), 0);
  const ja = JSON.parse(await readFile(path.join(dictionaries, 'ja.json'), 'utf8'));
  const sectionKeys = ['外观与主题', '阅读偏好', '翻译渠道', '增强渠道', '键盘快捷键', '图片与隐私', '本机资料与独立缓存', '来源连接'];
  assert.deepEqual(await page.locator('.nc-preferences > .settings-card h3').allTextContents(), sectionKeys.map(key => ja[key]));
  assert.equal(await page.locator('.nc-channel-settings .nc-model-picker').count(), 1);
  assert.equal(await page.locator('.nc-channel-settings').getByRole('switch', {name: ja['翻译书名与简介']}).count(), 1);
  check('no title banner; appearance, reading, translation, enhancement, shortcuts, privacy and storage order');

  const zoomControl = page.getByRole('group', {name: ja['默认缩放'], exact: true});
  assert.equal(await zoomControl.locator(':scope > span').textContent(), '50%');
  for (const zoom of [40, 200, 130]) {
    let current = Number.parseInt(await zoomControl.locator(':scope > span').textContent());
    while (current !== zoom) {
      await zoomControl.getByRole('button', {name: ja[current < zoom ? '放大' : '缩小'], exact: true}).click();
      const next = Number.parseInt(await zoomControl.locator(':scope > span').textContent());
      assert.equal(next, current + (current < zoom ? 10 : -10)); current = next;
    }
    assert.equal(await zoomControl.getByRole('button', {name: ja['缩小'], exact: true}).isDisabled(), zoom === 40);
    assert.equal(await zoomControl.getByRole('button', {name: ja['放大'], exact: true}).isDisabled(), zoom === 200);
    await page.waitForFunction(zoom => JSON.parse(localStorage.getItem('nc-settings')).readerZoom === zoom, zoom);
  }
  await page.reload(); await trigger.waitFor();
  assert.equal(await zoomControl.locator(':scope > span').textContent(), '130%');
  check('global zoom minus/plus controls step by 10%, stop at 40–200%, and persist across reloads');

  await geometry('ja', 1440, 1);
  await shot('ja-desktop');
  await trigger.click();
  const menu = page.getByRole('dialog', {name: ja['翻译模型'], exact: true});
  const box = await trigger.boundingBox(), menuBox = await menu.boundingBox();
  assert(Math.abs(box.width - menuBox.width) < 1, 'Model menu must match the trigger width');
  assert.equal(await menu.getByRole('link').count(), 1, 'Unavailable models remain upgrade links');
  await shot('ja-model-menu');
  await menu.getByRole('button', {name: new RegExp(modelName)}).click();
  await page.waitForFunction(name => document.querySelector('.nc-model-trigger strong')?.textContent === name, modelName);
  await page.reload();
  await page.waitForFunction(name => document.querySelector('.nc-model-trigger strong')?.textContent === name, modelName);
  check('long model choice saves across refresh; unavailable model remains a link');

  await trigger.scrollIntoViewIfNeeded();
  await settle();
  const scrollBefore = await page.evaluate(() => scrollY);
  await trigger.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  assert(await trigger.evaluate(element => element === document.activeElement));
  assert.equal(await page.evaluate(() => scrollY), scrollBefore);
  check('model keyboard navigation and Escape restore focus without moving the page');

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreSettingsWrite = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'nc-translation-channels') throw Error('Fixture settings write failed');
      return original.call(this, key, value);
    };
  });
  await trigger.click();
  await menu.getByRole('button').first().click();
  await menu.getByRole('alert').waitFor();
  assert.equal(await trigger.locator('strong').textContent(), modelName);
  await page.evaluate(() => window.restoreSettingsWrite());
  await menu.getByRole('button').first().click();
  await menu.waitFor({state: 'hidden'});
  check('failed model preference write retains selection; retry closes normally');

  await page.getByRole('switch', {name: ja['标签页自动翻译'], exact: true}).click();
  await page.locator('.nc-auto-tabs-error').waitFor();
  assert.equal(await page.getByRole('switch', {name: ja['标签页自动翻译'], exact: true}).getAttribute('aria-checked'), 'false');
  check('browser-preview permission failure stays inline and does not enable auto-translation');

  let dictionary = ja;
  for (const file of (await readdir(dictionaries)).filter(file => file.endsWith('.json'))) {
    const locale = file.slice(0, -5), next = JSON.parse(await readFile(path.join(dictionaries, file), 'utf8'));
    await selectOption(combo(dictionary['界面语言']), locale);
    dictionary = next;
    await page.getByRole('region', {name: dictionary['外观与偏好'], exact: true}).waitFor();
    assert.equal(await page.getByRole('group', {name: dictionary['默认缩放'], exact: true}).locator(':scope > span').textContent(), '130%');
    for (const scale of [1, 1.25]) {
      await selectOption(combo(dictionary['界面文字大小']), String(scale));
      for (const width of [1024, 700, 390]) await geometry(locale, width, scale);
    }
  }
  check('16 locales at desktop, narrow desktop and 390px; standard and 125% text');

  await selectOption(combo(dictionary['界面语言']), 'ja');
  await selectOption(combo(ja['亮暗外观']), 'dark');
  for (const width of [320, 701, 1280]) await geometry('ja-dark', width, 1.25);
  await page.evaluate(() => scrollTo(0, 0));
  await shot('ja-dark-large');
  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => scrollTo(0, 0));
  await shot('ja-narrow-large');
  await page.getByRole('button', {name: ja['樱花粉'], exact: true}).click();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'rose' && document.documentElement.dataset.appearance === 'dark');
  assert.equal(await combo(ja['界面文字大小']).getAttribute('data-value'), '1.25');
  check('Japanese dark, 320/701/1280px boundaries, and appearance persistence');

  // Phone uses its existing compact row override, not the narrow desktop layout.
  const phoneContext = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, storageState: await context.storageState()});
  await phoneContext.route(/^https?:/, mock);
  const phone = await phoneContext.newPage();
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(web + '/#settings');
  await phone.locator('.nc-model-trigger').waitFor();
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await phone.setViewportSize({width, height});
    const dimensions = await phone.locator('.nc-preferences').evaluate(root => ({
      width: root.clientWidth, scrollWidth: root.scrollWidth,
      model: root.querySelector('.nc-model-trigger').getBoundingClientRect().width,
      target: root.querySelector('.nc-channel-settings .setting-row .nc-select').getBoundingClientRect().width,
      themeColumns: getComputedStyle(root.querySelector('.nc-theme-options')).gridTemplateColumns.split(' ').length,
    }));
    assert(dimensions.scrollWidth <= dimensions.width + 1, 'Phone settings overflow');
    assert.equal(dimensions.themeColumns, 3, 'Phone keeps three theme columns');
    assert(Math.abs(dimensions.model - dimensions.target) < 1, 'Phone model matches the target control');
    await phone.locator('.nc-model-trigger').tap();
    const phoneMenu = phone.locator('.nc-model-menu'), bounds = await phoneMenu.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= height, 'Phone model menu outside viewport');
    await phoneMenu.getByRole('button').first().tap();
    await phoneMenu.waitFor({state: 'hidden'});
  }
  await phone.setViewportSize({width: 390, height: 844});
  await phone.evaluate(() => scrollTo(0, 0));
  await phone.screenshot({path: path.join(out, 'ja-phone-large.png')});
  await phoneContext.close();
  check('phone 320/390px and landscape keep compact aligned controls and tappable model menu');
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({checks, errors, measurements}, null, 2));
  await browser.close();
}
