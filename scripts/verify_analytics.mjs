// Built MV3 extension, isolated profile, synthetic input and mocked HTTP(S).
// A caller may supply a workflow runner; normal runs need only Playwright.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

async function directPlan(page, _goal, steps) {
  for (const step of steps) {
    const locator = step.locator(page);
    if (step.action === 'fill') await locator.fill(step.value);
    else await locator.click();
    const deadline = Date.now() + 8000;
    while (!await step.verify()) {
      assert(Date.now() < deadline, step.subgoal + ': postcondition not reached');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export async function verifyAnalytics({runPlan = directPlan} = {}) {
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const {ZipWriter, Uint8ArrayWriter, Uint8ArrayReader} = createRequire(path.resolve('apps/extension/package.json'))('@zip.js/zip.js');
  const out = path.resolve('artifacts/analytics', randomUUID());
  await mkdir(out, {recursive: true});
  const extension = path.join(out, 'extension');
  await cp(path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
  const background = path.join(extension, 'background.js');
  await writeFile(background, `
globalThis.analyticsRequests = [];
globalThis.analyticsStatus = 204;
globalThis.analyticsAlarms = [];
const registerAlarm = chrome.alarms.onAlarm.addListener.bind(chrome.alarms.onAlarm);
chrome.alarms.onAlarm.addListener = listener => {analyticsAlarms.push(listener); registerAlarm(listener);};
const nativeFetch = fetch;
globalThis.fetch = async (input, options) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/v1/analytics/events')) {
    analyticsRequests.push({body: JSON.parse(options.body), credentials: options.credentials, headers: options.headers});
    return new Response(null, {status: analyticsStatus});
  }
  if (/^https?:/.test(url)) return Response.json({});
  return nativeFetch(input, options);
};
` + await readFile(background, 'utf8'));
  const executablePath = process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH;
  const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    headless: true, channel: 'chromium', ...(executablePath ? {executablePath} : {}),
    viewport: {width: 1280, height: 960},
    args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(15000);
  const errors = [], checks = [], screenshots = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:') {
      localStorage.setItem('nc-settings', JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings') || '{}'), uiLanguage: 'zh-CN'}));
    }
  });
  await context.route(/^https?:/, route => route.fulfill({json:
    route.request().url().includes('/capabilities') ? {
      modes: [{id: 'classic', enabled: true}, {id: 'redraw', enabled: true}],
      languages: [{id: 'zh-Hans', label: '简体中文'}],
      limits: {max_bytes: 10000000, max_pixels: 10000000}, entitlements: null,
    } : route.request().url().includes('/auth/config') ? {dev_auth: true} : {},
  }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  // Playwright can expose the worker before Chromium has installed its extension APIs.
  const deadline = Date.now() + 8000;
  while (!await worker.evaluate(() => !!globalThis.chrome?.alarms && !!globalThis.chrome?.runtime?.id && Array.isArray(globalThis.analyticsAlarms))) {
    if (Date.now() >= deadline) {
      await context.close();
      throw Error('Analytics background did not initialize');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const origin = 'chrome-extension://' + new URL(worker.url()).hostname;
  const state = () => worker.evaluate(async () => (await chrome.storage.local.get('nc-analytics-v1'))['nc-analytics-v1']);
  const handled = () => worker.evaluate(async () => (await chrome.storage.local.get('nc-analytics-prompt-v1'))['nc-analytics-prompt-v1']);
  const flush = () => worker.evaluate(() => analyticsAlarms.forEach(listener => listener({name: 'nc-analytics-flush'})));
  const sent = () => worker.evaluate(() => analyticsRequests);
  const card = page => page.locator('[data-analytics-prompt]');
  const toggle = page => page.getByRole('switch', {name: '帮助改进 NodeLane', exact: true});
  const snap = async (page, name) => {
    const target = path.join(out, name + '.png');
    await page.screenshot({path: target, fullPage: true});
    screenshots.push(target);
  };
  async function freshLibrary() {
    for (const page of context.pages()) await page.close();
    await worker.evaluate(async () => {
      await chrome.alarms.clear('nc-analytics-flush');
      await chrome.storage.local.remove(['nc-analytics-v1', 'nc-analytics-prompt-v1']);
      analyticsRequests = [];
      analyticsStatus = 204;
    });
    const page = await context.newPage();
    await page.goto(origin + '/reader.html#library');
    await card(page).waitFor();
    return page;
  }
  const noCard = page => card(page).count().then(count => count === 0);
  const choose = (page, name) => ({
    subgoal: name === '不发送并关闭提示' ? '关闭帮助改进卡片，保持不发送分析' : '在帮助改进卡片选择「' + name + '」',
    action: 'click', locator: p => p.getByRole('button', {name, exact: true}),
    verify: () => noCard(page),
  });
  try {
    let page = await freshLibrary();
    assert.equal(await state(), undefined);
    assert.equal((await sent()).length, 0);
    assert.equal(await card(page).evaluate(el => el.contains(document.activeElement)), false);
    assert.equal(await page.getByRole('dialog').count(), 0);
    checks.push('default_off_no_id_queue_request_or_focus_capture');

    const toolbar = page.locator('.nc-library-tools');
    const toolbarBefore = await toolbar.boundingBox();
    assert((await card(page).boundingBox()).y >= toolbarBefore.y + toolbarBefore.height);
    for (const appearance of ['light', 'dark']) {
      for (const accent of ['sky', 'rose', 'mint', 'iris', 'amber', 'slate']) {
        await page.evaluate(({appearance, accent}) => {
          const next = JSON.stringify({...JSON.parse(localStorage.getItem('nc-settings')), appearance, accentTheme: accent, textScale: 1.25});
          localStorage.setItem('nc-settings', next);
          window.dispatchEvent(new StorageEvent('storage', {key: 'nc-settings', newValue: next}));
        }, {appearance, accent});
        await page.waitForFunction(({appearance, accent}) => document.documentElement.dataset.appearance === appearance && document.documentElement.dataset.accent === accent, {appearance, accent});
        assert.equal(await card(page).evaluate(el => !['fixed', 'absolute'].includes(getComputedStyle(el).position) && el.scrollWidth <= el.clientWidth), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await snap(page, 'card-' + appearance);
    }
    await page.setViewportSize({width: 600, height: 900});
    assert.equal(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await snap(page, 'card-narrow-large-text');
    await page.setViewportSize({width: 1280, height: 960});
    checks.push('normal_flow_after_toolbar_12_themes_narrow_large_text');

    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 1200;
      const brush = canvas.getContext('2d');
      brush.fillStyle = '#ddeeff';
      brush.fillRect(0, 0, 800, 1200);
      brush.fillStyle = '#223344';
      brush.font = '48px sans-serif';
      brush.fillText('Synthetic analytics fixture', 50, 150);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const name of ['01.png', '02.png']) await writer.add(name, new Uint8ArrayReader(Buffer.from(png, 'base64')), {level: 0});
    const archive = Buffer.from(await writer.close());
    page.once('filechooser', chooser => chooser.setFiles({name: 'analytics-fixture.cbz', mimeType: 'application/zip', buffer: archive}));
    await runPlan(page, '保持分析关闭，验证卡片不影响书架搜索和导入，然后明确拒绝', [
      {subgoal: '在书架的搜索漫画输入框输入合成测试词 analytics-fixture', action: 'fill', value: 'analytics-fixture', locator: p => p.getByRole('searchbox', {name: '搜索漫画', exact: true}), verify: async () => await page.getByRole('searchbox', {name: '搜索漫画', exact: true}).inputValue() === 'analytics-fixture'},
      {subgoal: '清空书架的搜索漫画输入框', action: 'fill', value: '', locator: p => p.getByRole('searchbox', {name: '搜索漫画', exact: true}), verify: async () => await page.getByRole('searchbox', {name: '搜索漫画', exact: true}).inputValue() === ''},
      {subgoal: '点击书架工具栏的导入漫画，测试夹具会选择自制漫画，等待自动进入阅读器', action: 'click', locator: p => p.getByRole('button', {name: '导入漫画', exact: true}), verify: () => page.evaluate(() => {const image = document.querySelector('img.nc-page-image'); return !!image?.complete && image.naturalWidth > 0 && !document.querySelector('[data-analytics-prompt]');})},
      {subgoal: '从阅读器返回我的漫画书架', action: 'click', locator: p => p.getByRole('button', {name: '返回我的漫画', exact: true}), verify: () => card(page).isVisible()},
      choose(page, '不发送'),
    ]);
    assert.equal(await handled(), true);
    assert.deepEqual(await state(), {consent: false, queue: []});
    assert.equal((await sent()).length, 0);
    const rejectedToolbar = await toolbar.boundingBox();
    await page.reload();
    await page.getByRole('heading', {name: /我的漫画/}).waitFor();
    assert(await noCard(page));
    assert.equal((await toolbar.boundingBox()).y, rejectedToolbar.y);
    checks.push('ignore_search_import_no_collection_reject_persists_toolbar_stays');

    page = await freshLibrary();
    await runPlan(page, '关闭可选分析卡片，并保持分析关闭', [choose(page, '不发送并关闭提示')]);
    assert.equal(await handled(), true);
    assert.deepEqual(await state(), {consent: false, queue: []});
    await page.reload();
    await page.getByRole('heading', {name: /我的漫画/}).waitFor();
    assert(await noCard(page));
    assert.equal((await sent()).length, 0);
    checks.push('dismiss_is_off_and_persists');

    page = await freshLibrary();
    const second = await context.newPage();
    await second.goto(origin + '/reader.html#settings');
    await toggle(second).waitFor();
    assert.equal(await toggle(second).getAttribute('aria-checked'), 'false');
    await runPlan(page, '明确允许可选分析并核对其他标签页同步', [{
      ...choose(page, '允许使用分析'),
      verify: async () => await noCard(page) && await toggle(second).getAttribute('aria-checked') === 'true' && (await state())?.queue.some(event => event.name === 'page_view'),
    }]);
    const enabled = await state();
    assert(enabled.client_id);
    assert.equal(await handled(), true);
    assert(enabled.queue.every(event => !JSON.stringify(event).includes('chrome-extension://')));
    await snap(second, 'settings-enabled');
    await flush();
    await second.waitForFunction(async () => ((await chrome.storage.local.get('nc-analytics-v1'))['nc-analytics-v1']?.queue ?? []).length === 0);
    const requests = await sent();
    assert(requests.some(request => request.body.events.some(event => event.name === 'extension_first_use')));
    assert(requests.every(request => request.credentials === 'omit' && !JSON.stringify(request.headers).toLowerCase().includes('authorization')));
    assert(!JSON.stringify(requests).includes('analytics-fixture'));
    checks.push('allow_creates_id_sanitized_payload_no_credentials_cross_tab_sync');

    await worker.evaluate(() => {analyticsStatus = 503;});
    await page.goto(origin + '/reader.html#settings');
    await page.waitForFunction(async () => ((await chrome.storage.local.get('nc-analytics-v1'))['nc-analytics-v1']?.queue ?? []).some(event => event.params.screen === 'settings'));
    await flush();
    await page.waitForFunction(async () => ((await chrome.storage.local.get('nc-analytics-v1'))['nc-analytics-v1']?.queue ?? []).some(event => event.attempts === 1));
    await runPlan(second, '从设置中撤回使用分析并验证其他标签页同步关闭', [{
      subgoal: '关闭帮助改进 NodeLane 使用分析开关', action: 'click', locator: toggle,
      verify: async () => await toggle(second).getAttribute('aria-checked') === 'false' && await toggle(page).getAttribute('aria-checked') === 'false',
    }]);
    assert.deepEqual(await state(), {consent: false, queue: []});
    assert.equal(await handled(), true);
    const count = (await sent()).length;
    await flush();
    assert.equal((await sent()).length, count);
    await page.goto(origin + '/reader.html#library');
    await page.getByRole('heading', {name: /我的漫画/}).waitFor();
    assert(await noCard(page));
    await snap(second, 'settings-withdrawn');
    checks.push('failed_send_queued_withdraw_clears_id_queue_stops_send_no_reprompt');

    await worker.evaluate(() => {analyticsStatus = 204;});
    await runPlan(second, '撤回后可以在设置主动重新开启分析', [{
      subgoal: '开启帮助改进 NodeLane 使用分析开关', action: 'click', locator: toggle,
      verify: async () => await toggle(second).getAttribute('aria-checked') === 'true' && !!(await state())?.client_id,
    }]);
    assert.notEqual((await state()).client_id, enabled.client_id);
    checks.push('settings_reenable_uses_new_identity');
    assert.deepEqual(errors, []);
    const result = {result: 'passed', checks, screenshots, errors};
    await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    return {...result, out};
  } catch (error) {
    await writeFile(path.join(out, 'failure.json'), JSON.stringify({message: error.message, checks, errors}, null, 2));
    throw error;
  } finally {
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyAnalytics()));
}
