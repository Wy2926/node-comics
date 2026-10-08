// Start the isolated Vite fixture on 127.0.0.1:5181, then run:
// node --test tests/shortcuts.browser.mjs
// Reuse an installed Playwright via PLAYWRIGHT_MODULE and an installed browser
// via CHROMIUM_PATH. This suite never opens extension pages or a user profile.
import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5181';
let browser, page, errors;
before(async () => {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
});
after(async () => {await browser?.close();});
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce', serviceWorkers: 'block'});
  page.setDefaultTimeout(7000);
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Synthetic, local application testing only. Never permit cloud/API traffic.
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});
afterEach(async () => {await page.close(); assert.deepEqual(errors, []);});

const panel = () => page.getByRole('dialog', {name: '键盘快捷键', exact: true});
const scrollport = () => panel().locator('.nc-shortcut-scroll');
const scopeLabels = {global: '通用操作', app: '首页与标签页', reader: '阅读器', web: '网页内翻译'};
const group = scope => panel().locator(`.nc-shortcut-group[data-shortcut-scope="${scope}"]`);
const anchor = scope => panel().getByRole('navigation', {name: '快捷键范围', exact: true}).getByRole('button', {name: scopeLabels[scope], exact: true});
const pageNumber = () => page.getByRole('spinbutton', {name: '跳转页码', exact: true});
const viewport = () => page.locator('.nc-reading-viewport');
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function stablePanelLayout() {
  await page.waitForFunction(() => {
    const element = document.querySelector('.nc-shortcut-scroll');
    return element && parseFloat(getComputedStyle(element).getPropertyValue('--nc-scrollbar-reserve-y')) > 0;
  });
  await scrollport().evaluate(async element => {
    await document.fonts.ready;
    let previous = '', stableFrames = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const header = element.querySelector('[data-shortcut-scope="reader"] .nc-shortcut-group-heading');
      const sample = JSON.stringify([element.scrollTop, element.scrollHeight, element.clientWidth, element.clientHeight,
        header.getBoundingClientRect().top - element.getBoundingClientRect().top]);
      stableFrames = sample === previous ? stableFrames + 1 : 0;
      if (stableFrames >= 5) return;
      previous = sample;
    }
    throw new Error('Shortcut panel geometry did not settle after scrollbar reservation');
  });
}
async function waitPage(value) {
  await page.waitForFunction(value => document.querySelector('[aria-label="跳转页码"]')?.value === String(value), value);
  await settle();
}
async function reader() {
  await page.goto(`${origin}/tests/reader-window-fixture.html`);
  await pageNumber().waitFor();
  await page.waitForFunction(async () => (await import('/src/shortcuts/store.ts')).getShortcutSnapshot().ready);
  await waitPage(1);
}
async function readingPosition() {
  return {page: Number(await pageNumber().inputValue()), top: await viewport().evaluate(element => element.scrollTop)};
}
async function samePosition(expected) {
  await settle();
  const actual = await readingPosition();
  assert.equal(actual.page, expected.page);
  assert(Math.abs(actual.top - expected.top) <= 2, `Reader moved from ${expected.top} to ${actual.top}`);
}
async function activeScope(scope) {
  await page.waitForFunction(scope => {
    const section = document.querySelector(`.nc-shortcut-group[data-shortcut-scope="${scope}"]`);
    return !!section && document.querySelector('.nc-shortcut-anchor[aria-current="location"]')?.getAttribute('aria-controls') === section.id;
  }, scope);
  await settle();
}
async function openPanel() {await page.keyboard.press('Shift+/'); await panel().waitFor(); await activeScope('reader');}
async function closePanel() {await panel().locator('.nc-shortcut-close').click(); await panel().waitFor({state: 'hidden'});}
async function saved() {await panel().getByText('快捷键已保存', {exact: true}).waitFor();}
async function binding(button) {return button.getAttribute('aria-description');}
async function chromeBounds() {
  const boxes = {};
  for (const name of ['header', 'close', 'footer']) {
    boxes[name] = await panel().locator(`.nc-shortcut-${name}`).boundingBox();
    assert(boxes[name], `${name} must stay visible`);
  }
  return boxes;
}
async function sameChrome(expected) {
  const actual = await chromeBounds();
  for (const name of Object.keys(expected)) for (const coordinate of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(actual[name][coordinate] - expected[name][coordinate]) <= 2, `${name}.${coordinate} moved from ${expected[name][coordinate]} to ${actual[name][coordinate]}`);
  }
}

test('all groups remain rendered while sidebar anchors and scrollspy move only the content viewport', async () => {
  await reader();
  await page.keyboard.press('PageDown'); await waitPage(2);
  const reading = await readingPosition(), url = page.url();
  await openPanel();
  assert.equal(await panel().locator('.nc-shortcut-group').count(), 4);
  assert.equal(await panel().locator('.nc-shortcut-anchor').count(), 4);
  assert.equal(await panel().getByRole('button', {name: '全部', exact: true}).count(), 0);
  for (const scope of Object.keys(scopeLabels)) {
    assert.equal(await group(scope).count(), 1);
    assert.equal(await anchor(scope).getAttribute('aria-controls'), await group(scope).getAttribute('id'));
  }
  const initialTop = await scrollport().evaluate(element => element.scrollTop);
  assert(initialTop > 100, 'initialScope=reader must locate the reader group, not filter away earlier groups');
  const fixed = await chromeBounds(), documentTop = await page.evaluate(() => window.scrollY);
  assert.equal(await panel().evaluate(element => element.scrollTop), 0);

  await anchor('global').click(); await activeScope('global');
  const firstTop = await scrollport().evaluate(element => element.scrollTop);
  assert(firstTop < initialTop, 'Clicking a sidebar anchor scrolls back to the earlier group');
  await anchor('web').click(); await activeScope('web');
  assert(await scrollport().evaluate(element => element.scrollTop) > initialTop);
  assert.equal(await panel().locator('.nc-shortcut-group').count(), 4, 'Anchors must not filter out groups');
  assert.equal(page.url(), url, 'Panel navigation must not change app navigation or the reader');

  // A direct scrollbar/wheel-equivalent scroll must update the sidebar without a button click.
  await scrollport().evaluate(element => {
    const section = element.querySelector('[data-shortcut-scope="app"]');
    element.scrollTop += section.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
  });
  await activeScope('app');
  await scrollport().evaluate(element => {element.scrollTop = element.scrollHeight;});
  await activeScope('web');
  await sameChrome(fixed);
  assert.equal(await panel().evaluate(element => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => window.scrollY), documentTop);
  await samePosition(reading);

  const scrollId = await scrollport().getAttribute('id');
  assert(scrollId, 'The content viewport needs a stable id for its scrollbar');
  const rail = panel().locator(`.nc-scrollbar-layer:popover-open .nc-scrollbar-y[aria-controls="${scrollId}"]`);
  await rail.waitFor({state: 'visible'});
  const railBox = await rail.boundingBox(), contentBox = await scrollport().boundingBox();
  assert(railBox.y >= contentBox.y - 1, 'Content scrollbar must start below the fixed header');
  assert(railBox.y + railBox.height <= contentBox.y + contentBox.height + 1, 'Content scrollbar must end above the fixed footer');
  assert(railBox.y >= fixed.header.y + fixed.header.height - 1);
  assert(railBox.y + railBox.height <= fixed.footer.y + 1);
  await closePanel(); await samePosition(reading);
});

test('real reader shortcuts remain active with a scrollbar popover and pause only for the shortcut dialog', async () => {
  await reader();
  await page.keyboard.press('s');
  await page.locator('.nc-reader-drawer').waitFor();
  await page.locator('.nc-scrollbar-layer:popover-open').first().waitFor({state: 'attached'});
  // Regression: the settings drawer opens a passive manual-popover scrollbar.
  // It must not disable all shortcuts merely by occupying the browser top layer.
  await page.keyboard.press('PageDown'); await waitPage(2);
  await page.keyboard.press('j'); await waitPage(3);
  await page.keyboard.press('=');
  await page.locator('.nc-reader-option').filter({hasText: '缩放'}).getByText('110%', {exact: true}).waitFor();
  await waitPage(3);
  const before = await readingPosition();
  await page.getByRole('button', {name: '键盘快捷键', exact: true}).click();
  await panel().waitFor(); await activeScope('reader');
  assert.equal(await page.locator('.nc-reader-drawer').count(), 0, 'The existing reader shortcut entry closes its drawer before opening the panel');
  await page.keyboard.press('j');
  await page.keyboard.press('PageDown');
  await samePosition(before);
  await closePanel();
  await samePosition(before);
  assert(await page.locator('[data-reader-settings-trigger]').evaluate(element => element === document.activeElement), 'Closing returns keyboard focus to the surviving reader settings trigger');
  await page.keyboard.press('j'); await waitPage(4);
});

test('recording can be cancelled, custom chords save and execute, and restoring a command preserves reader position', async () => {
  await reader();
  await page.keyboard.press('PageDown'); await waitPage(2);
  const before = await readingPosition();
  await openPanel();
  const nextBinding = () => panel().getByRole('button', {name: '修改“下一页”的快捷键', exact: true}).nth(1);
  await nextBinding().click();
  const recordedTop = await scrollport().evaluate(element => element.scrollTop);
  await page.keyboard.press('Escape');
  assert(await panel().isVisible(), 'Escape cancels recording before closing the dialog');
  assert.equal(await panel().locator('.is-recording').count(), 0);
  assert.equal(await binding(nextBinding()), 'J');
  assert(Math.abs(await scrollport().evaluate(element => element.scrollTop) - recordedTop) <= 2, 'Cancelling a recording must not reset the group position');
  await samePosition(before);
  await nextBinding().click();
  await page.keyboard.press('o');
  await panel().getByText('快捷键与“查看原图”冲突，请先修改该操作。', {exact: true}).waitFor();
  assert(Math.abs(await scrollport().evaluate(element => element.scrollTop) - recordedTop) <= 2, 'A validation error must not reset the group position');
  await page.keyboard.press('Escape');
  assert(await panel().isVisible());
  await nextBinding().click();
  await page.keyboard.press('Control+Alt+n');
  await saved();
  assert.equal(await binding(nextBinding()), 'Ctrl + Alt + N');
  assert(Math.abs(await scrollport().evaluate(element => element.scrollTop) - recordedTop) <= 2, 'Saving must not reapply initialScope scrolling');
  await closePanel();
  await samePosition(before);
  await page.keyboard.press('j'); await samePosition(before);
  await page.keyboard.press('Control+Alt+n'); await waitPage(3);
  const customized = await readingPosition();
  await openPanel();
  await panel().getByRole('button', {name: '下一页 · 恢复默认', exact: true}).click();
  await saved();
  assert.equal(await binding(nextBinding()), 'J');
  await closePanel();
  await samePosition(customized);
  await page.keyboard.press('Control+Alt+n'); await samePosition(customized);
  await page.keyboard.press('j'); await waitPage(4);
  const restored = await readingPosition();
  await page.getByRole('button', {name: '关闭并保存位置', exact: true}).click();
  await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
  await waitPage(4);
  await samePosition(restored);
});

test('all-reset requires confirmation and leaves Escape and Tab usable while recording', async () => {
  await reader();
  await openPanel();
  const original = () => panel().getByRole('button', {name: '修改“查看原图”的快捷键', exact: true});
  await original().click();
  await page.keyboard.press('Tab');
  assert.equal(await panel().locator('.is-recording').count(), 0);
  assert(await panel().isVisible());
  await original().click();
  await page.keyboard.press('Control+Alt+u'); await saved();
  assert.equal(await binding(original()), 'Ctrl + Alt + U');
  await panel().getByRole('button', {name: '恢复全部默认', exact: true}).click();
  await panel().getByText('所有快捷键将恢复默认设置，是否继续？', {exact: true}).waitFor();
  await page.keyboard.press('Escape');
  assert(await panel().isVisible(), 'Escape cancels reset confirmation before closing the panel');
  assert.equal(await panel().getByText('所有快捷键将恢复默认设置，是否继续？', {exact: true}).count(), 0);
  assert.equal(await binding(original()), 'Ctrl + Alt + U');
  await panel().getByRole('button', {name: '恢复全部默认', exact: true}).click();
  await panel().getByRole('button', {name: '恢复全部默认', exact: true}).click();
  await saved();
  assert.equal(await binding(original()), 'O');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('nc-shortcuts')).overrides), {});
  await page.keyboard.press('Escape'); await panel().waitFor({state: 'hidden'}); await waitPage(1);
});

test('sidebar selection and assigned binding frames use the existing comic tokens across all twelve themes', async () => {
  await reader(); await openPanel();
  const backgrounds = new Set();
  for (const appearance of ['light', 'dark']) for (const accent of ['sky', 'rose', 'mint', 'iris', 'amber', 'slate']) {
    await page.evaluate(({appearance, accent}) => {
      document.documentElement.dataset.appearance = appearance;
      document.documentElement.dataset.accent = accent;
    }, {appearance, accent});
    await settle();
    const visual = await panel().evaluate(element => {
      const snapshot = node => {
        const style = getComputedStyle(node);
        return {border: [style.borderTop, style.borderRight, style.borderBottom, style.borderLeft], radius: style.borderRadius,
          shadow: style.boxShadow, background: style.backgroundColor, color: style.color};
      };
      // Resolve the real shared tokens through CSS rather than duplicating their
      // colors in this regression or accepting a hardcoded "comic-like" palette.
      const probe = document.createElement('div');
      probe.style.cssText = 'display:none;border:var(--comic-border);border-radius:var(--comic-control-radius);box-shadow:var(--comic-shadow-small);background:var(--accent-soft);color:var(--ink)';
      element.append(probe);
      const selectedExpected = snapshot(probe);
      probe.style.background = 'var(--surface)';
      const bindingExpected = snapshot(probe);
      probe.remove();
      const assigned = element.querySelector('[role="group"][aria-label="查看原图"] .nc-shortcut-binding:not(.is-empty)');
      const key = getComputedStyle(assigned.querySelector('kbd'));
      return {selectedExpected, bindingExpected, selected: snapshot(element.querySelector('.nc-shortcut-anchor[aria-current="location"]')),
        assigned: snapshot(assigned), keyBorder: key.borderWidth, keyShadow: key.boxShadow, keyBackground: key.backgroundColor};
    });
    const theme = `${appearance}/${accent}`;
    assert(visual.selected.border.every(border => border.startsWith('2px solid ')), `${theme}: selected sidebar uses a two-pixel comic outline`);
    assert.deepEqual(visual.selected, visual.selectedExpected, `${theme}: selected sidebar must inherit the shared comic and accent tokens`);
    assert.deepEqual(visual.assigned, visual.bindingExpected, `${theme}: the assigned combination must have one shared comic frame and hard shadow`);
    assert.equal(visual.keyBorder, '0px', `${theme}: individual key labels must not introduce nested keycap frames`);
    assert.equal(visual.keyShadow, 'none', `${theme}: the hard shadow belongs to the entire binding, not individual labels`);
    assert.equal(visual.keyBackground, 'rgba(0, 0, 0, 0)', `${theme}: key labels inherit the binding surface`);
    backgrounds.add(visual.selected.background);
  }
  assert.equal(backgrounds.size, 12, 'Each light/dark accent selection must resolve to its own existing accent surface');
});

test('record, clear and icon-only alternative controls remain named and operable from the keyboard', async () => {
  await reader(); await openPanel();
  const row = panel().getByRole('group', {name: '查看原图', exact: true});
  const original = () => row.getByRole('button', {name: '修改“查看原图”的快捷键', exact: true}).first();
  const alternative = () => row.getByRole('button', {name: '添加“查看原图”的快捷键', exact: true});
  assert.equal((await alternative().innerText()).trim(), '', 'The alternative control is icon-only');
  assert.equal(await alternative().getAttribute('title'), '添加“查看原图”的快捷键');
  assert.equal(await row.locator('.nc-shortcut-binding.is-empty.is-compact').count(), 1);

  await original().focus(); await page.keyboard.press('Enter');
  assert.equal(await row.locator('.nc-shortcut-binding.is-recording').count(), 1, 'Enter starts the focused recorder');
  await page.keyboard.press('Tab');
  assert.equal(await row.locator('.nc-shortcut-binding.is-recording').count(), 0);
  const removeOriginal = row.getByRole('button', {name: '移除“查看原图 · O”的快捷键', exact: true});
  assert(await removeOriginal.evaluate(element => element === document.activeElement), 'Tab exits recording and reaches its separate clear control');
  await page.keyboard.press('Tab');
  assert(await alternative().evaluate(element => element === document.activeElement), 'The icon-only alternative stays in the native tab order');
  await page.keyboard.press('Enter');
  assert.equal(await row.locator('.nc-shortcut-binding.is-recording').count(), 1);
  await page.keyboard.press('Control+Alt+u'); await saved();
  assert.deepEqual(await row.locator('.nc-shortcut-key[aria-description]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-description'))), ['O', 'Ctrl + Alt + U']);
  const focusAfterRecord = await row.evaluate(element => ({withinRow: element.contains(document.activeElement), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label')}));
  assert(focusAfterRecord.withinRow, `Saving a recorded binding must retain editing focus in its row, got ${JSON.stringify(focusAfterRecord)}`);

  const removeAlternative = row.getByRole('button', {name: '移除“查看原图 · Ctrl + Alt + U”的快捷键', exact: true});
  await removeAlternative.focus(); await page.keyboard.press('Enter'); await saved();
  assert.equal(await alternative().count(), 1);
  assert.equal(await removeAlternative.count(), 0);
  const focusAfterClear = await row.evaluate(element => ({withinRow: element.contains(document.activeElement), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label')}));
  assert(focusAfterClear.withinRow, `Clearing a focused binding must retain editing focus in its row, got ${JSON.stringify(focusAfterClear)}`);
  await page.keyboard.press('Tab');
  assert(await panel().evaluate(element => element.contains(document.activeElement)), 'Tab remains usable after clearing a binding');
  await alternative().focus(); await page.keyboard.press('Enter');
  assert.equal(await row.locator('.nc-shortcut-binding.is-recording').count(), 1, 'The cleared alternative can immediately be recorded again');
  await page.keyboard.press('Escape');
  assert.equal(await row.locator('.nc-shortcut-binding.is-recording').count(), 0);
  assert(await panel().isVisible());
});

for (const [width, textScale] of [[560, 1], [560, 1.25], [390, 1.25]]) test(`a ${width}px dark panel at ${textScale} text scale keeps its initial anchor stable and respects subsequent browsing`, async () => {
  await page.setViewportSize({width, height: 780});
  await reader();
  await page.evaluate(scale => {
    document.documentElement.dataset.appearance = 'dark';
    document.documentElement.style.setProperty('--text-scale', String(scale));
  }, textScale);
  await settle();
  const reading = await readingPosition();
  await openPanel();
  // The reserved scrollbar changes wrapping after showModal; the initial anchor
  // must still point at the reader section after that second layout has settled.
  await stablePanelLayout();
  assert.equal(await anchor('reader').getAttribute('aria-current'), 'location');
  const readerOffset = await scrollport().evaluate(element => element.querySelector('[data-shortcut-scope="reader"] .nc-shortcut-group-heading').getBoundingClientRect().top - element.getBoundingClientRect().top);
  assert(Math.abs(readerOffset - 20) <= 3, `Initial reader heading drifted to ${readerOffset}px from its 20px inset`);
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/);
  assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), 16 * textScale);
  const bounds = await panel().boundingBox(), size = page.viewportSize();
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= size.height + 1, 'Dialog must fit inside the narrow viewport');
  assert(await panel().evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'The panel shell must not overflow horizontally');
  assert(await scrollport().evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Shortcut rows must wrap inside their own viewport');

  // A real user wheel must end initial positioning. Later reflow must preserve
  // the user's chosen group rather than applying initialScope=reader again.
  await scrollport().hover(); await page.mouse.wheel(0, -10000);
  await activeScope('global'); await stablePanelLayout();
  assert.equal(await scrollport().evaluate(element => element.scrollTop), 0);
  await page.setViewportSize({width: width + 40, height: 760});
  await stablePanelLayout();
  assert.equal(await anchor('global').getAttribute('aria-current'), 'location', 'Resizing after manual scrolling must not restore the initial reader anchor');
  assert.equal(await scrollport().evaluate(element => element.scrollTop), 0, 'The user-selected top position must survive resize');
  await page.setViewportSize({width, height: 780});
  await stablePanelLayout();
  assert.equal(await anchor('global').getAttribute('aria-current'), 'location');

  const fixed = await chromeBounds();
  await anchor('web').click(); await activeScope('web');
  await scrollport().evaluate(element => {element.scrollTop = element.scrollHeight;}); await settle();
  await sameChrome(fixed);
  const close = await panel().locator('.nc-shortcut-close').boundingBox();
  assert(close.x >= bounds.x && close.y >= bounds.y && close.x + close.width <= bounds.x + bounds.width + 1);
  await samePosition(reading);
  await closePanel(); await samePosition(reading);
});

test('native starts display actual assignments, refresh on focus and reject conflicting page bindings', async () => {
  await page.addInitScript(() => {
    window.fixtureBrowserCommands = [{name: 'nc-translate-tab', shortcut: 'Alt+Shift+Z'}, {name: 'nc-translate-region', shortcut: 'Alt+Shift+R'}];
    window.fixtureShortcutSettings = [];
    // A normal HTTP page need not expose chrome; install the complete native fixture.
    Object.assign(window.chrome ??= {}, {
      commands: {getAll: async () => window.fixtureBrowserCommands},
      tabs: {create: async options => {window.fixtureShortcutSettings.push(options.url);}},
      runtime: {getURL: path => 'chrome-extension://fixture' + path},
    });
  });
  await reader();
  await openPanel(); await anchor('web').click(); await activeScope('web');
  const tabStart = group('web').getByRole('group', {name: '翻译当前标签页', exact: true});
  const regionStart = group('web').getByRole('group', {name: '划图翻译', exact: true});
  assert.equal(await tabStart.locator('kbd').innerText(), 'Alt+Shift+Z');
  assert.equal(await regionStart.locator('kbd').innerText(), 'Alt+Shift+R');
  assert.equal(await tabStart.locator('.nc-shortcut-binding').count(), 0, 'Native starts must not keep a second in-page binding');
  await tabStart.getByRole('button', {name: '在浏览器中修改', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => window.fixtureShortcutSettings), ['chrome://extensions/shortcuts']);
  await group('web').getByRole('button', {name: '修改“暂停或继续网页翻译”的快捷键', exact: true}).click();
  await page.keyboard.press('Alt+Shift+z');
  await panel().getByText('快捷键与“翻译当前标签页”冲突，请先修改该操作。', {exact: true}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.fixtureBrowserCommands = [{name: 'nc-translate-tab', shortcut: ''}, {name: 'nc-translate-region', shortcut: 'Alt+Shift+R'}];
    window.dispatchEvent(new Event('focus'));
  });
  await tabStart.getByText('尚未设置', {exact: true}).waitFor();
  assert.equal(await tabStart.locator('kbd').count(), 0, 'An unassigned command must not show its suggested key');
  await closePanel();
});

test('native shortcut lookup errors recover without changing saved reader shortcuts or position', async () => {
  await page.addInitScript(() => {
    window.fixtureBrowserCommandsFail = true;
    Object.assign(window.chrome ??= {}, {
      commands: {getAll: async () => {
        if (window.fixtureBrowserCommandsFail) throw Error('fixture lookup failure');
        return [{name: 'nc-translate-tab', shortcut: 'Alt+Shift+T'}];
      }},
      tabs: {create: async () => {throw Error('fixture settings failure');}},
      runtime: {getURL: path => 'chrome-extension://fixture' + path},
    });
  });
  await reader(); await page.keyboard.press('PageDown'); await waitPage(2);
  const reading = await readingPosition();
  await openPanel(); await anchor('web').click(); await activeScope('web');
  const tabStart = group('web').getByRole('group', {name: '翻译当前标签页', exact: true});
  await tabStart.getByText('无法读取浏览器快捷键。', {exact: true}).waitFor();
  await tabStart.getByRole('button', {name: '在浏览器中修改', exact: true}).click();
  await panel().getByText('无法打开浏览器快捷键设置，请在扩展管理页修改。', {exact: true}).waitFor();
  await page.evaluate(() => {window.fixtureBrowserCommandsFail = false; window.dispatchEvent(new Event('focus'));});
  await tabStart.getByText('Alt+Shift+T', {exact: true}).waitFor();
  await samePosition(reading); await closePanel(); await samePosition(reading);
});

test('real DOM gating ignores passive scrollbar popovers but protects open menus, listboxes and dialogs', async () => {
  await page.goto(`${origin}/tests/select-fixture.html`);
  await page.getByRole('combobox', {name: '作品', exact: true}).waitFor();
  await page.evaluate(async () => {
    const {bindShortcuts} = await import('/src/shortcuts/runtime.ts');
    const output = document.createElement('output'); output.id = 'shortcut-calls'; output.textContent = '0';
    const scroller = document.createElement('div'); scroller.id = 'shortcut-scroll-fixture';
    scroller.style.cssText = 'width:240px;height:100px;overflow:auto';
    const content = document.createElement('div'); content.style.height = '800px'; content.textContent = 'Synthetic scrolling content';
    scroller.append(content); document.querySelector('.nc-app').append(output, scroller);
    const overrides = {};
    bindShortcuts(window, {'reader.next': () => {output.textContent = String(Number(output.textContent) + 1);}}, {getOverrides: () => overrides});
  });
  await page.locator('#shortcut-scroll-fixture').scrollIntoViewIfNeeded();
  await page.locator('.nc-scrollbar-layer:popover-open').first().waitFor({state: 'attached'});
  const calls = async () => Number(await page.locator('#shortcut-calls').innerText());
  await page.locator('#before').focus();
  await page.keyboard.press('PageDown');
  assert.equal(await calls(), 1, 'A closed native dialog and an open scrollbar are not modal blockers');
  for (const role of ['menu', 'listbox', 'dialog']) {
    await page.evaluate(role => {
      const overlay = document.createElement('div'); overlay.id = 'shortcut-overlay'; overlay.popover = 'manual'; overlay.setAttribute('role', role);
      overlay.textContent = `Synthetic ${role}`; document.querySelector('.nc-app').append(overlay); overlay.showPopover();
    }, role);
    await page.locator('#before').focus();
    const before = await calls();
    await page.keyboard.press('PageDown');
    assert.equal(await calls(), before, `An open ${role} popover must block background commands`);
    await page.locator('#shortcut-overlay').evaluate(element => {element.hidePopover(); element.remove();});
    await page.keyboard.press('PageDown');
    assert.equal(await calls(), before + 1, `Closing ${role} must re-enable commands`);
  }
  await page.getByRole('button', {name: 'Open dialog', exact: true}).click();
  await page.getByRole('button', {name: 'Close dialog', exact: true}).focus();
  const before = await calls();
  await page.keyboard.press('PageDown'); assert.equal(await calls(), before);
  await page.getByRole('button', {name: 'Close dialog', exact: true}).click();
  await page.locator('#before').focus();
  await page.keyboard.press('PageDown'); assert.equal(await calls(), before + 1);
});
