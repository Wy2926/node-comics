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

async function mobileGeometry(page) {
  await visibleContent(page);
  const geometry = await page.evaluate(() => {
    const box = selector => {const value = document.querySelector(selector).getBoundingClientRect(); return {top: value.top, bottom: value.bottom};};
    return {top: box('.nc-reader-rail.left'), bottom: box('.nc-reader-rail.right'), canvas: box('.nc-epub-stage'), overflow: document.documentElement.scrollWidth > innerWidth + 1};
  });
  assert.equal(geometry.overflow, false);
  assert(geometry.canvas.top >= geometry.top.bottom - 1 && geometry.canvas.bottom <= geometry.bottom.top + 1, 'Tools must not cover EPUB content');
  for (const name of ['关闭阅读器', '打开目录', '阅读设置']) await reachable(page, name);
  await (await reachable(page, '打开目录')).click();
  await (await reachable(page, '关闭面板')).click();
}

for (const engine of (process.env.EPUB_ENGINES || 'chromium,firefox,webkit').split(',')) {
  for (const scenario of ['navigation-and-reopen', 'close-while-loading', 'single-image-failure']) {
    test(`${engine}: mobile EPUB ${scenario}`, {timeout: 180_000}, async t => {
      const browser = await playwright[engine].launch({headless: true});
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
        if (scenario === 'navigation-and-reopen') {
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
          await t.test('reopening preserves the rendered text within one line', {
            todo: engine === 'webkit' && 'EPUB.js retains the same CFI but loses a measured 60px intra-node offset; real iOS devices remain unverified.',
          }, () => {
            assert(anchor && reopened && Math.abs(reopened.top - anchor.top) <= Math.max(anchor.lineHeight, reopened.lineHeight) + 2,
              `Reopening must keep the rendered text within one line: ${JSON.stringify({anchor, reopened})}`);
          });
          await page.screenshot({path: path.join(output, `${engine}-reopened.png`)});
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
        } else {
          const saved = await location(page);
          await page.getByRole('button', {name: '常规翻译', exact: true}).click();
          const retry = page.locator('.nc-image-translation.error .nc-image-translation-action');
          await retry.waitFor({state: 'visible'});
          await page.waitForFunction(() => document.querySelector('output[aria-label="已提交图片"]').textContent.includes('image-2.png'));
          await retry.click();
          await page.waitForFunction(() => document.querySelector('output[aria-label="已提交图片"]').textContent.includes('image-1.png'));
          await retry.waitFor({state: 'detached'});
          assert.equal((await location(page)).cfi, saved.cfi, 'Retry must preserve the reading anchor');
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
