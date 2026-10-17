// Start tests/opds-epub-ui.config.ts on its isolated 127.0.0.1:5198 origin first.
// Reuse installed browsers via PLAYWRIGHT_MODULE; EPUB_ENGINES optionally selects engines.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const playwright = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:5198';
const output = path.resolve('artifacts/epub-mobile-reader');
await mkdir(output, {recursive: true});

async function ready(page) {
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.nc-epub-viewport');
    return viewport?.getAttribute('aria-busy') === 'false' &&
      [...viewport.querySelectorAll('iframe')].some(frame => frame.contentDocument?.body?.textContent.includes('Lazy EPUB reading')) &&
      !!document.querySelector('output[aria-label="保存位置"]')?.textContent;
  }, undefined, {timeout: 60_000});
}

async function location(page) {
  return page.locator('output[aria-label="保存位置"]').evaluate(element => JSON.parse(element.textContent));
}

async function renderedAnchor(page, previous) {
  return page.evaluate(previous => {
    const stage = document.querySelector('.nc-epub-stage').getBoundingClientRect();
    for (const frame of document.querySelectorAll('.nc-epub-viewport iframe')) {
      const heading = frame.contentDocument?.querySelector('h1')?.textContent;
      if (!heading || previous && previous.heading !== heading) continue;
      const paragraphs = [...frame.contentDocument.querySelectorAll('p')];
      const index = previous?.index ?? paragraphs.findIndex(element => {
        const box = element.getBoundingClientRect(), frameTop = frame.getBoundingClientRect().top;
        return frameTop + box.bottom > stage.top && frameTop + box.top < stage.bottom;
      });
      const paragraph = paragraphs[index];
      if (paragraph) return {heading, index, top: frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - stage.top,
        lineHeight: parseFloat(frame.contentWindow.getComputedStyle(paragraph).lineHeight)};
    }
  }, previous);
}

async function visibleContent(page) {
  // A viewport CSS resize alone can still leave the previous narrow iframe visible.
  await page.waitForFunction(() => {
    const stage = document.querySelector('.nc-epub-stage');
    if (!stage) return false;
    const area = stage.getBoundingClientRect();
    for (const frame of stage.querySelectorAll('iframe')) {
      const box = frame.getBoundingClientRect();
      if (Math.abs(box.width - area.width) > 1 || getComputedStyle(frame).visibility !== 'visible') continue;
      for (const element of frame.contentDocument?.querySelectorAll('h1,p,img,figcaption') ?? []) {
        const content = element.getBoundingClientRect();
        const left = Math.max(area.left, box.left + content.left), right = Math.min(area.right, box.left + content.right);
        const top = Math.max(area.top, box.top + content.top), bottom = Math.min(area.bottom, box.top + content.bottom);
        if (right > left && bottom > top && document.elementFromPoint((left + right) / 2, (top + bottom) / 2) === frame) return true;
      }
    }
    return false;
  }, undefined, {timeout: 30_000});
}

async function reachable(page, name) {
  const button = page.getByRole('button', {name, exact: true}), box = await button.boundingBox(), viewport = page.viewportSize();
  assert(box && box.width >= 43 && box.height >= 43, `${name}: touch target`);
  assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: inside viewport`);
  return button;
}

async function showTools(page) {
  if (await page.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden'))) {
    await page.keyboard.press('Escape');
  }
}

async function mobileGeometry(page) {
  await visibleContent(page);
  await showTools(page);
  const geometry = await page.evaluate(() => {
    const box = selector => {const value = document.querySelector(selector).getBoundingClientRect(); return {top: value.top, bottom: value.bottom};};
    return {top: box('.nc-reader-rail.left'), bottom: box('.nc-reader-rail.right'), canvas: box('.nc-epub-stage'), overflow: document.documentElement.scrollWidth > innerWidth + 1};
  });
  assert.equal(geometry.overflow, false);
  assert(geometry.canvas.top === 0 && geometry.canvas.bottom === page.viewportSize().height, 'Immersive tools must overlay a full-height EPUB canvas');
  for (const name of ['关闭阅读器', '打开目录', '阅读设置']) await reachable(page, name);
  await (await reachable(page, '打开目录')).click();
  await (await reachable(page, '关闭面板')).click();
}

for (const engine of (process.env.EPUB_ENGINES || 'chromium,firefox,webkit').split(',')) {
  for (const scenario of ['navigation-and-reopen', 'close-while-loading', 'single-image-failure', 'original-enhancement-failure', 'prefetched-enhancement-failure']) {
    test(`${engine}: mobile EPUB ${scenario}`, {timeout: 180_000}, async t => {
      const browser = await playwright[engine].launch({headless: true,
        ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
      const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true,
        ...(engine === 'firefox' ? {} : {isMobile: true}), locale: 'zh-CN', reducedMotion: 'reduce'});
      const errors = [], external = [];
      await context.route(/^https?:\/\//, route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(new URL(route.request().url()).origin);
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', error => errors.push(error.stack || error.message));
      try {
        await page.goto(origin + '/tests/epub-reader-fixture.html' + (scenario === 'single-image-failure' ? '?failure' : ''));
        // Fixture diagnostics are not reader chrome and otherwise cover the bottom tools.
        await page.addStyleTag({content: '.nc-app > details {display:none !important}'});
        await ready(page);
        await showTools(page);
        if (scenario === 'navigation-and-reopen') {
          await t.test('default immersive toolbar toggles from iframe taps without resizing or moving the text', async () => {
            assert(await page.locator('.nc-reader').evaluate(element => element.classList.contains('is-immersive')));
            await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
            const canvas = page.locator('.nc-epub-stage'), before = await canvas.boundingBox(), anchorBefore = await location(page);
            await page.touchscreen.tap(195, 422);
            await page.waitForFunction(() => !document.querySelector('.nc-reader').classList.contains('controls-hidden'));
            assert.deepEqual(await canvas.boundingBox(), before, 'EPUB content tap must not resize the canvas');
            await page.touchscreen.tap(195, 422);
            await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
            assert.equal((await location(page)).cfi, anchorBefore.cfi, 'EPUB toolbar toggling must keep the reading anchor');
            await page.screenshot({path: path.join(output, `${engine}-immersive-hidden.png`)});
          });
          await mobileGeometry(page);
          await page.screenshot({path: path.join(output, `${engine}-portrait.png`)});
          for (const [title, href] of [['Chapter Two', 'two.xhtml'], ['Chapter One', 'one.xhtml']]) {
            await page.getByRole('button', {name: '打开目录', exact: true}).click();
            await page.getByRole('button', {name: title, exact: true}).click();
            await page.locator('.nc-reader-drawer').waitFor({state: 'detached'});
            await page.waitForFunction(href => JSON.parse(document.querySelector('output[aria-label="保存位置"]').textContent).href.endsWith(href), href);
          }
          const initial = await location(page);
          await page.getByRole('button', {name: '下一页', exact: true}).click();
          await page.waitForFunction(cfi => JSON.parse(document.querySelector('output[aria-label="保存位置"]').textContent).cfi !== cfi, initial.cfi);
          const anchor = await renderedAnchor(page);
          await page.screenshot({path: path.join(output, `${engine}-before-close.png`)});
          await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
          const saved = await location(page);
          await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
          await ready(page);
          const restored = await location(page);
          // EPUB.js may report the next wrapped character after aligning a CFI to a line.
          assert.equal(restored.href, saved.href);
          assert.equal(restored.cfi.split(':')[0], saved.cfi.split(':')[0], 'Reopening must restore the same CFI text node');
          assert(Math.abs(restored.progression - saved.progression) < .002, 'Reopening must preserve the local reading anchor');
          const reopened = await renderedAnchor(page, anchor);
          await t.test('reopening preserves the rendered text within one pixel', () => {
            assert(anchor && reopened && Math.abs(reopened.top - anchor.top) <= 1,
              `Reopening must keep the intra-node offset: ${JSON.stringify({anchor, reopened})}`);
            t.diagnostic(`Reopen drift: ${reopened.top - anchor.top}px`);
          });
          await page.screenshot({path: path.join(output, `${engine}-reopened.png`)});
          await t.test('small scrolls within the same CFI survive repeated reopening', async () => {
            const before = await location(page);
            await page.locator('.nc-epub-viewport .epub-container').evaluate(element => {element.scrollTop += 8;});
            await page.waitForFunction(progression => JSON.parse(document.querySelector('output[aria-label="保存位置"]').textContent).progression !== progression, before.progression);
            const scrolled = await location(page), text = await renderedAnchor(page, anchor);
            assert.equal(scrolled.cfi, before.cfi, 'This regression must scroll inside the same CFI');
            assert(Math.abs(text.top - reopened.top + 8) <= 1);
            for (let pass = 0; pass < 2; pass++) {
              await showTools(page);
              await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
              await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
              await ready(page);
              const after = await renderedAnchor(page, text);
              assert(Math.abs(after.top - text.top) <= 1, `Repeated reopen ${pass}: ${JSON.stringify({text, after})}`);
            }
          });
          await t.test('font reflow and reopening at a different width preserve the text anchor', async () => {
            const before = await location(page);
            await showTools(page);
            await page.getByRole('button', {name: '阅读设置', exact: true}).click();
            await page.getByRole('button', {name: '放大', exact: true}).click();
            await page.waitForFunction(progression => JSON.parse(document.querySelector('output[aria-label="保存位置"]').textContent).progression !== progression, before.progression);
            await page.getByRole('button', {name: '关闭面板', exact: true}).click();
            assert.equal((await location(page)).cfi.split(':')[0], before.cfi.split(':')[0], 'Font reflow must keep the same text node');
            const text = await renderedAnchor(page, anchor);
            await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
            await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
            await ready(page);
            assert(Math.abs((await renderedAnchor(page, text)).top - text.top) <= 1, 'Reopening must retain the reflowed position');
            const saved = await location(page);
            await showTools(page);
            await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
            await page.setViewportSize({width: 844, height: 390});
            await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
            await ready(page);
            assert.equal((await location(page)).cfi.split(':')[0], saved.cfi.split(':')[0], 'Reopening at a different width must prefer CFI over the saved fraction');
            await visibleContent(page);
          });
          await showTools(page);
          const jump = page.getByRole('spinbutton', {name: '跳转章节', exact: true});
          const beforeEdit = await location(page);
          await jump.fill('');
          assert.equal(await jump.inputValue(), '');
          assert.equal((await location(page)).cfi, beforeEdit.cfi, 'Clearing a chapter must not navigate');
          await jump.fill('2');
          assert.equal((await location(page)).cfi, beforeEdit.cfi, 'A draft chapter must not navigate');
          await jump.press('Enter');
          await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="保存位置"]').textContent).href.endsWith('two.xhtml'));
          assert.equal(await jump.inputValue(), '2');
          assert.equal(await jump.evaluate(element => document.activeElement === element), false);
          await page.setViewportSize({width: 844, height: 390});
          await mobileGeometry(page);
          await page.screenshot({path: path.join(output, `${engine}-landscape.png`)});
          await t.test('comic layout persists independently of global defaults and can return to inheritance', async () => {
            const globalSettings = () => page.locator('output[aria-label="全局阅读设置"]').textContent().then(JSON.parse);
            const storedView = () => page.evaluate(() => JSON.parse(localStorage.getItem('epub-artwork-ui-fixture')));
            const before = await location(page), globalBefore = await globalSettings();
            await showTools(page);
            await page.getByRole('button', {name: '阅读设置', exact: true}).click();
            const choice = page.getByRole('group', {name: '阅读布局', exact: true});
            assert.equal(await choice.getByRole('button', {name: '默认', exact: true}).getAttribute('aria-pressed'), 'true');
            await choice.getByRole('button', {name: '单页', exact: true}).click(); await ready(page);
            await page.getByRole('button', {name: '关闭面板', exact: true}).click();
            assert.equal(await page.locator('.nc-epub-stage').getAttribute('data-epub-flow'), 'paginated');
            assert.equal((await storedView()).layout, 'single');
            assert.deepEqual(await globalSettings(), globalBefore);
            assert.equal((await location(page)).href, before.href, 'Layout switching retains the document chapter');
            const saved = await location(page);
            await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
            await page.getByRole('button', {name: '重开阅读器', exact: true}).click(); await ready(page);
            assert.equal(await page.locator('.nc-epub-stage').getAttribute('data-epub-flow'), 'paginated');
            assert.equal((await location(page)).cfi.split(':')[0], saved.cfi.split(':')[0]);
            await showTools(page); await page.getByRole('button', {name: '阅读设置', exact: true}).click();
            await choice.getByRole('button', {name: '默认', exact: true}).click(); await ready(page);
            assert.equal(await page.locator('.nc-epub-stage').getAttribute('data-epub-flow'), 'scrolled-continuous');
            assert.equal((await storedView()).layout, undefined);
            assert.deepEqual(await globalSettings(), globalBefore);
            await page.screenshot({path: path.join(output, `${engine}-comic-layout-default.png`)});
          });
        } else if (scenario === 'close-while-loading') {
          await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
          await page.evaluate(() => {
            const observer = new MutationObserver(() => {
              const viewport = document.querySelector('.nc-epub-viewport[aria-busy="true"]');
              const close = document.querySelector('button[aria-label="关闭阅读器"]');
              if (!viewport || !close) return;
              window.loadingExit = {loading: true, iframe: !!viewport.querySelector('iframe')};
              observer.disconnect(); close.click();
            });
            observer.observe(document.querySelector('#root'), {childList: true, subtree: true});
          });
          await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
          await page.waitForFunction(() => !!window.loadingExit);
          assert.deepEqual(await page.evaluate(() => window.loadingExit), {loading: true, iframe: false});
          await page.getByRole('button', {name: '重开阅读器', exact: true}).click();
          await ready(page);
          await visibleContent(page);
          await page.getByRole('button', {name: '关闭阅读器', exact: true}).click();
          await page.getByRole('button', {name: '重开阅读器', exact: true}).waitFor();
        } else if (scenario === 'single-image-failure') {
          const saved = await location(page);
          await page.getByRole('button', {name: '翻译', exact: true}).click();
          const retry = page.locator('.nc-image-translation.error .nc-image-translation-action');
          await retry.waitFor({state: 'visible'});
          await page.waitForFunction(() => document.querySelector('output[aria-label="已提交图片"]').textContent.includes('image-2.png'));
          await page.mouse.move(195, 422);
          await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
          await retry.tap();
          await page.waitForFunction(() => document.querySelector('output[aria-label="已提交图片"]').textContent.includes('image-1.png'));
          await retry.waitFor({state: 'detached'});
          assert.equal((await location(page)).cfi, saved.cfi, 'Retry must preserve the reading anchor');
        } else {
          const prefetch = scenario === 'prefetched-enhancement-failure', href = `OPS/image-${prefetch ? 2 : 1}.png`;
          if (prefetch) {
            await page.getByRole('button', {name: '翻译', exact: true}).click();
            await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="图片状态"]').textContent)
              .filter(page => /image-[12]\.png$/.test(page.id)).filter(page => page.outputs.length).length === 2);
          }
          await page.evaluate(async href => {
            window.epubEnhancementFixture.failHref = href; window.epubEnhancementFixture.failures = 1;
            await window.epubEnhancementFixture.enable();
          }, href);
          await page.locator('[data-enhancement-state="queued"], [data-enhancement-state="running"]').waitFor();
          // Wait for the failed record, not just a request reaching the simulated service.
          await page.waitForFunction(() => new Promise(resolve => {
            const failed = window.epubEnhancementFixture.requests.find(request => request.failed);
            if (!failed) {resolve(false); return;}
            const request = indexedDB.open('node-comics-reading-v2-image-processing-requests');
            request.onsuccess = () => {
              const db = request.result, records = db.transaction('records').objectStore('records').getAll();
              records.onsuccess = () => {resolve(records.result.some(record => record.state === 'failed' && record.errorCode === 'HTTP_503')); db.close();};
            };
          }));
          if (prefetch) {
            assert.equal(await page.getByRole('button', {name: '重试增强', exact: true}).count(), 0, 'A prefetched failure must not replace the current image status');
            await page.evaluate(href => {
              for (const frame of document.querySelectorAll('.nc-epub-viewport iframe')) {
                const artwork = frame.contentDocument?.querySelector(`img[data-nc-epub-image="${href}"]`);
                if (artwork) {artwork.scrollIntoView({block: 'start'}); return;}
              }
              throw Error('Prefetched artwork is not mounted');
            }, href);
            await page.waitForFunction(href => JSON.parse(document.querySelector('output[aria-label="图片状态"]').textContent)[0]?.id === 'epub-image:' + href, href);
          }
          const retry = page.getByRole('button', {name: '重试增强', exact: true});
          await retry.waitFor();
          await page.screenshot({path: path.join(output, `${engine}-${scenario}.png`)});
          const saved = await location(page), submissions = await page.locator('output[aria-label="已提交图片"]').textContent();
          await page.mouse.move(195, 422);
          await page.waitForFunction(() => document.querySelector('.nc-reader').classList.contains('controls-hidden'));
          await retry.tap();
          await page.waitForFunction(href => window.epubEnhancementFixture.requests.filter(request => request.href === href).length === 2, href);
          await retry.waitFor({state: 'detached'});
          await page.locator('[data-enhancement-state]').waitFor({state: 'detached'});
          assert.equal(await page.locator('output[aria-label="已提交图片"]').textContent(), submissions, 'Enhancement retry must not submit another translation');
          assert.equal((await location(page)).cfi, saved.cfi, 'Enhancement retry must preserve the reading anchor');
          assert.equal(await page.evaluate(() => window.epubEnhancementFixture.requests.some(request => request.href === 'unknown')), false, 'Enhancement inputs must match known original or full translated images');
        }
        assert.deepEqual(errors, [], 'Reader lifecycle must not emit unhandled errors');
        assert.deepEqual(external, [], 'Only the local fixture may be requested');
      } catch (error) {
        await page.screenshot({path: path.join(output, `${engine}-${scenario}-failed.png`)}).catch(() => {});
        if (errors.length) console.error(errors);
        throw error;
      } finally {await browser.close();}
    });
  }
}
