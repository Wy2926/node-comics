import assert from 'node:assert/strict';
import {before, after, beforeEach, afterEach, test} from 'node:test';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.SELECT_TEST_ORIGIN || 'http://127.0.0.1:5176';
let browser, page, errors;
before(async () => {browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});});
after(async () => {await browser?.close();});
beforeEach(async () => {
  page = await browser.newPage({viewport: {width: 1280, height: 900}});page.setDefaultTimeout(5000);errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/select-fixture.html`);await page.getByRole('combobox', {name: '作品', exact: true}).waitFor();
});
afterEach(async () => {await page.close();assert.deepEqual(errors, []);});
const rail = (id, axis = 'y') => page.locator(`.nc-scrollbar-${axis}[aria-controls="${id}"]`);
async function dragToEnd(locator, axis = 'y') {
  await locator.waitFor();const thumb = await locator.locator('.nc-scrollbar-thumb').boundingBox(), box = await locator.boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);await page.mouse.down();
  await page.mouse.move(axis === 'x' ? box.x + box.width + 60 : box.x - 50, axis === 'y' ? box.y + box.height + 60 : box.y - 50, {steps: 12});await page.mouse.up();
}
async function fillFixture(html) {
  await page.evaluate(html => {
    const area = document.createElement('section');area.id = 'scrollbar-fixture';
    area.style.cssText = 'position:fixed;left:70px;top:90px;width:600px;height:650px;z-index:10;background:var(--surface)';
    area.innerHTML = html;document.querySelector('.nc-app').append(area);
  }, html);
}
async function nativeGutter(id) {
  assert.deepEqual(await page.locator(`#${id}`).evaluate(element => {
    const style = getComputedStyle(element);
    return [element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      element.offsetHeight - element.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)];
  }), [0, 0]);
}

test('dragging and wheeling a popover list keeps the combobox focused and does not select or move the page', async () => {
  const control = page.getByRole('combobox', {name: '长列表', exact: true});await control.click();
  const id = await control.getAttribute('aria-controls'), before = await page.evaluate(() => scrollY);
  await rail(id).waitFor();await nativeGutter(id);
  await dragToEnd(rail(id));
  assert(await page.locator(`[id="${id}"]`).evaluate(element => element.scrollTop > 400));
  assert.equal(await control.getAttribute('aria-expanded'), 'true');assert.equal(await control.getAttribute('data-value'), '0');
  assert(await control.evaluate(element => element === document.activeElement));assert.equal(await page.evaluate(() => scrollY), before);
  const box = await rail(id).boundingBox();await page.mouse.move(box.x + 8, box.y + 30);await page.mouse.wheel(0, -300);
  await page.waitForFunction(id => {const list = document.getElementById(id);return list.scrollTop < list.scrollHeight - list.clientHeight - 100;}, id);
  await control.press('Escape');assert.equal(await rail(id).isVisible(), false);
  await control.click();await rail(id).waitFor();await control.press('End');await control.press('Enter');
  assert.equal(JSON.parse(await page.locator('#changes').innerText()).at(-1).target.value, '39');
});

test('dynamic nested two-axis containers retain dimensions and isolate drag, keyboard and clipping', async () => {
  await fillFixture('<div id="outer" style="width:500px;height:360px;overflow:auto"><div id="inner" style="width:390px;height:180px;overflow:auto;border:2px solid"><div style="width:1000px;height:900px">Nested content</div></div><div style="height:800px"></div></div>');
  await rail('inner').waitFor();await rail('inner','x').waitFor();await nativeGutter('inner');await nativeGutter('outer');
  await dragToEnd(rail('inner'));await dragToEnd(rail('inner','x'),'x');
  assert(await page.locator('#inner').evaluate(element => element.scrollTop > 600 && element.scrollLeft > 500));
  assert.equal(await page.locator('#outer').evaluate(element => element.scrollTop), 0);
  await rail('inner','x').focus();await page.keyboard.press('Home');assert.equal(await page.locator('#inner').evaluate(element => element.scrollLeft),0);
  await page.keyboard.press('End');assert(await page.locator('#inner').evaluate(element => element.scrollLeft > 500));
  await rail('outer').focus();await page.keyboard.press('End');
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="inner"]').checkVisibility());
  await page.locator('#inner').evaluate(element => element.remove());
  await page.waitForFunction(() => !document.querySelector('[aria-controls="inner"]'));
  await page.locator('#outer').evaluate(element => {element.replaceChildren(document.createTextNode('Short'));});
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="outer"]').checkVisibility());
});

test('a long context menu keeps focus and stays open while its scrollbar is dragged', async () => {
  await page.getByRole('button',{name:'Long menu',exact:true}).click();
  const menu = page.getByRole('menu',{name:'Long menu',exact:true});
  await page.waitForFunction(() => document.querySelector('[role=menu]').id);
  const id = await menu.getAttribute('id');await rail(id).waitFor();await nativeGutter(id);
  const focused = await page.evaluate(() => document.activeElement.textContent);
  await dragToEnd(rail(id));assert(await menu.isVisible());
  assert.equal(await page.evaluate(() => document.activeElement.textContent),focused);
  await page.getByRole('menuitem',{name:'Action 29',exact:true}).click();
  assert.equal(await page.locator('#menu-selection').innerText(),'29');assert.equal(await menu.count(),0);
});

test('textarea and modal scrollbars remain interactive in the top layer without moving the caret or outer scroll owner', async () => {
  await fillFixture('<dialog id="dialog" class="modal" aria-label="Scroll fixture"><textarea id="comment" style="width:360px;height:100px"></textarea><div style="height:900px">Long dialog</div></dialog>');
  await page.locator('#dialog').evaluate(element => element.showModal());
  const textarea = page.locator('#comment');await textarea.fill('A line of feedback.\n'.repeat(120));
  await textarea.press('Control+Home');await rail('comment').waitFor();await nativeGutter('comment');
  const before = await page.evaluate(() => ({page: scrollY, dialog: document.getElementById('dialog').scrollTop, caret: document.getElementById('comment').selectionStart}));
  await dragToEnd(rail('comment'));
  assert(await textarea.evaluate(element => element.scrollTop > 500));assert(await textarea.evaluate(element => element === document.activeElement));
  assert.deepEqual(await page.evaluate(() => ({page: scrollY, dialog: document.getElementById('dialog').scrollTop, caret: document.getElementById('comment').selectionStart})), before);
  await rail('dialog').waitFor();await nativeGutter('dialog');await rail('dialog').focus();await page.keyboard.press('End');
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="comment"]').checkVisibility());
  await page.locator('#dialog').evaluate(element => element.close());
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="dialog"]').checkVisibility());
});

test('horizontal RTL starts on the right and keyboard endpoints use physical track positions', async () => {
  await fillFixture('<div id="rtl" dir="rtl" style="width:440px;height:180px;overflow:auto"><div style="width:1200px;height:80px">RTL content</div></div>');
  const horizontal = rail('rtl','x');await horizontal.waitFor();await nativeGutter('rtl');
  assert.equal(await page.locator('#rtl').evaluate(element => element.scrollLeft),0);
  const track = await horizontal.boundingBox(), thumb = await horizontal.locator('.nc-scrollbar-thumb').boundingBox();
  assert(Math.abs(thumb.x + thumb.width - track.x - track.width) < 2);
  await horizontal.focus();await page.keyboard.press('Home');assert(await page.locator('#rtl').evaluate(element => element.scrollLeft < -700));
  await page.keyboard.press('End');assert.equal(await page.locator('#rtl').evaluate(element => element.scrollLeft),0);
});

test('content growth, removal and resize update the same scrollbar without introducing native gutters', async () => {
  await fillFixture('<div id="growing" style="width:360px;height:200px;overflow:auto"><div id="contents">Short</div></div>');
  await page.waitForFunction(() => document.getElementById('growing').classList.contains('nc-scrollbar-viewport'));
  assert.equal(await rail('growing').isVisible(),false);
  await page.locator('#contents').evaluate(element => {element.style.height = '1200px';});await rail('growing').waitFor();
  const first = await rail('growing').locator('.nc-scrollbar-thumb').boundingBox();
  await page.locator('#growing').evaluate(element => {element.style.height = '400px';});
  await page.waitForFunction(height => document.querySelector('.nc-scrollbar-y[aria-controls="growing"] .nc-scrollbar-thumb').getBoundingClientRect().height > height, first.height);
  await nativeGutter('growing');
  const missed = await page.locator('.nc-app').evaluate(scope => [...scope.querySelectorAll('*')].filter(element => {
    if (element.closest('.nc-scrollbar-layer')) return false;
    const style = getComputedStyle(element);
    return /^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY);
  }).filter(element => !element.classList.contains('nc-scrollbar-viewport')).map(element => element.outerHTML.slice(0,120)));
  assert.deepEqual(missed,[]);
});

test('content growth during a held drag keeps the thumb at the latest bottom and preserves idle offsets', async () => {
  await fillFixture('<div id="drag-growing" style="width:360px;height:200px;overflow:auto"><div id="drag-contents" style="height:2400px">Growing content</div></div>');
  const viewport = page.locator('#drag-growing'), vertical = rail('drag-growing');
  await vertical.waitFor();await nativeGutter('drag-growing');
  await viewport.evaluate(element => {element.scrollTop = (element.scrollHeight - element.clientHeight) * .45;});
  await page.waitForFunction(() => {
    const element = document.getElementById('drag-growing'), bar = document.querySelector('.nc-scrollbar-y[aria-controls="drag-growing"]');
    return Number(bar.getAttribute('aria-valuenow')) === Math.round(element.scrollTop);
  });
  const originalRail = await vertical.elementHandle(), box = await vertical.boundingBox(), thumb = await vertical.locator('.nc-scrollbar-thumb').boundingBox();
  const x = thumb.x + thumb.width / 2, bottom = box.y + box.height - thumb.height / 2;
  await page.mouse.move(x,thumb.y + thumb.height / 2);await page.mouse.down();
  try {
    await page.mouse.move(x,bottom,{steps:12});
    await page.waitForFunction(() => {
      const element = document.getElementById('drag-growing');
      return element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
    });
    await page.locator('#drag-contents').evaluate(element => {element.style.height = '4800px';});
    // Keep the pointer still: the scrollbar must follow growth without another pointermove.
    await page.waitForFunction(() => {
      const element = document.getElementById('drag-growing'), bar = document.querySelector('.nc-scrollbar-y[aria-controls="drag-growing"]');
      const max = element.scrollHeight - element.clientHeight;
      return Number(bar.getAttribute('aria-valuemax')) === Math.round(max) && max - element.scrollTop <= 1;
    });
    assert(await vertical.evaluate((element,previous) => element === previous,originalRail));
    const grownBox = await vertical.boundingBox(), grownThumb = await vertical.locator('.nc-scrollbar-thumb').boundingBox(), max = Number(await vertical.getAttribute('aria-valuemax'));
    const upward = bottom - 50, expected = (upward - grownBox.y - grownThumb.height / 2) / (grownBox.height - grownThumb.height) * max;
    await page.mouse.move(x,upward);
    await page.waitForFunction(expected => Math.abs(document.getElementById('drag-growing').scrollTop - expected) <= 2,expected);
    assert(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop > 100));
  } finally {
    await page.mouse.up();
  }
  const offset = await viewport.evaluate(element => element.scrollTop);
  await page.locator('#drag-contents').evaluate(element => {element.style.height = '7200px';});
  await page.waitForFunction(() => {
    const element = document.getElementById('drag-growing'), bar = document.querySelector('.nc-scrollbar-y[aria-controls="drag-growing"]');
    return Number(bar.getAttribute('aria-valuemax')) === Math.round(element.scrollHeight - element.clientHeight);
  });
  assert(Math.abs(await viewport.evaluate(element => element.scrollTop) - offset) <= 1);
});

test('reserved mode allocates a stable gutter, while overlay mode retains the full content width', async () => {
  await fillFixture('<div id="reserved" style="width:260px;height:180px;overflow:auto"><div style="height:650px">Reserved content</div></div><div id="overlay" data-scrollbar-mode="overlay" style="width:260px;height:180px;overflow:auto"><div style="height:650px">Overlay content</div></div>');
  await rail('reserved').waitFor();await rail('overlay').waitFor();
  const geometry = id => page.locator(`#${id}`).evaluate(element => ({width: element.clientWidth, content: element.firstElementChild.getBoundingClientRect().width, padding: getComputedStyle(element).paddingRight}));
  assert.deepEqual(await geometry('reserved'),{width:260,content:240,padding:'20px'});
  assert.deepEqual(await geometry('overlay'),{width:260,content:260,padding:'0px'});
  const contents = await page.locator('#reserved>div').boundingBox(), bar = await rail('reserved').boundingBox();
  assert(contents.x+contents.width <= bar.x+2);
  await page.locator('#reserved>div').evaluate(element => {element.style.height='30px';});
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="reserved"]').checkVisibility());
  assert.deepEqual(await geometry('reserved'),{width:260,content:240,padding:'20px'});
});

test('hidden mode removes rails and gutters while preserving scrolling and the saved offset', async () => {
  await fillFixture('<div id="hidden-scroll" data-scrollbar-mode="hidden" style="width:260px;height:180px;overflow:auto"><div style="height:650px">Hidden rails</div></div>');
  await page.waitForFunction(() => document.getElementById('hidden-scroll').dataset.ncScrollbarMode === 'hidden');
  await nativeGutter('hidden-scroll');assert.equal(await rail('hidden-scroll').isVisible(),false);
  assert.equal(await page.locator('#hidden-scroll').evaluate(element=>getComputedStyle(element).paddingRight),'0px');
  const box=await page.locator('#hidden-scroll').boundingBox();await page.mouse.move(box.x+50,box.y+50);await page.mouse.wheel(0,200);
  await page.waitForFunction(() => document.getElementById('hidden-scroll').scrollTop > 0);
  const offset=await page.locator('#hidden-scroll').evaluate(element=>element.scrollTop);
  await page.locator('#hidden-scroll').evaluate(element=>element.dataset.scrollbarMode='reserved');await rail('hidden-scroll').waitFor();
  assert.equal(await page.locator('#hidden-scroll').evaluate(element=>element.scrollTop),offset);
  await page.locator('#hidden-scroll').evaluate(element=>element.dataset.scrollbarMode='hidden');
  await page.waitForFunction(() => !document.querySelector('.nc-scrollbar-y[aria-controls="hidden-scroll"]').checkVisibility());
  assert.equal(await page.locator('#hidden-scroll').evaluate(element=>element.scrollTop),offset);
});

test('page scrollbar modes keep the masthead full width and reserve space only in the workspace', async () => {
  await page.goto(origin);await page.locator('input[type=file]').waitFor({state:'attached'});
  const header = page.locator('.nc-app-header'), actions = page.locator('.nc-header-actions');
  const initialHeader = await header.boundingBox(), initialActions = await actions.boundingBox();
  for (const label of ['我的漫画','发现','搜索漫画','漫画网站']) {
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:label,exact:true}).click();
    await page.waitForFunction(() => document.documentElement.dataset.ncScrollbarMode==='overlay' && getComputedStyle(document.documentElement).paddingRight==='0px');
  }
  for (const label of ['外观与设置','我的账户']) {
    await page.getByRole('button',{name:label,exact:true}).click();
    await page.waitForFunction(() => document.documentElement.dataset.ncScrollbarMode==='reserved' && getComputedStyle(document.querySelector('.nc-workspace')).paddingRight==='20px');
    assert.deepEqual(await header.boundingBox(), initialHeader);
    assert.deepEqual(await actions.boundingBox(), initialActions);
    assert.equal(await page.evaluate(() => document.querySelector('.nc-app-header').getBoundingClientRect().right),1280);
    await nativeGutter('nc-workspace');
  }
});
