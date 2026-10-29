import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WEBSITE_PREVIEW_URL || 'http://127.0.0.1:4321';
const output = path.resolve('artifacts/website-sites');
const languages = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id', 'ar'];
const prefix = locale => locale === 'zh-CN' ? '' : `${locale.toLowerCase()}/`;
const widths = [1920, 1440, 1280, 768, 390, 320];
const failures = [], external = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir(output, { recursive: true });
let count;
async function context(locale, extra = {}) {
  const result = await browser.newContext({ locale, viewport: { width: 1440, height: 1050 }, ...extra });
  await result.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  result.on('page', page => page.on('pageerror', error => failures.push(error.message)));
  return result;
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${page.url()} ${page.viewportSize().width}`);
}
async function animationNames(page) {
  return page.locator('.sites-track').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
}

try {
  for (const locale of languages) {
    const ctx = await context(locale), page = await ctx.newPage();
    await page.goto(`${origin}/${prefix(locale)}sites/`);
    await page.evaluate(() => document.fonts.ready);
    const cards = page.locator('.supported-site');
    count ??= await cards.count();
    assert.ok(count > 0);
    assert.equal(await cards.count(), count);
    assert.equal(await page.locator('main astro-island').count(), 0);
    assert.equal(await page.locator('main [data-install-extension], main a[href$="/download/"]').count(), 0);
    assert.equal(await page.locator('.header-download[data-install-extension]').count(), 1);
    for (const width of widths) { await page.setViewportSize({ width, height: 1050 }); await noOverflow(page); }
    for (const width of [1440, 390]) {
      if (!['zh-CN', 'en', 'de', 'ar'].includes(locale)) continue;
      await page.setViewportSize({ width, height: 1050 });
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(output, `intro-${locale}-${width}.png`) });
      await page.evaluate(() => scrollTo({ top: document.querySelector('#directory').getBoundingClientRect().top + scrollY - 120, behavior: 'instant' }));
      await page.screenshot({ path: path.join(output, `directory-${locale}-${width}.png`) });
    }
    // Decode actual packaged icons, including ones outside the lazy-loading window.
    const broken = await cards.locator('img').evaluateAll(async images => {
      for (const img of images) img.loading = 'eager';
      await Promise.all(images.map(img => img.decode().catch(() => {})));
      return images.filter(img => !img.naturalWidth).map(img => img.src);
    });
    assert.deepEqual(broken, [], `${locale}: source icons`);

    await page.goto(`${origin}/${prefix(locale)}`);
    assert.equal(await page.locator('.sites-group:not(.sites-clone) a').count(), count);
    assert.equal(await page.locator('.home-sites input, .sites-pause').count(), 0);
    for (const width of widths) { await page.setViewportSize({ width, height: 1050 }); await noOverflow(page); }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator('.home-sites').scrollIntoViewIfNeeded();
    await page.locator('.home-sites-heading').hover();
    await page.waitForFunction(() => document.querySelector('[data-sites-carousel]')?.dataset.moving === 'true');
    assert.ok((await animationNames(page)).every(name => name.includes('sites-scroll')));
    if (['zh-CN', 'en', 'ar'].includes(locale)) {
      await page.screenshot({ path: path.join(output, `carousel-${locale}-1440.png`), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.home-sites').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `carousel-${locale}-390.png`), animations: 'disabled' });
    }
    await page.locator('.sites-marquee').hover({ position: { x: 10, y: 20 } });
    assert.deepEqual(await page.locator('.sites-track').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationPlayState)), ['paused', 'paused', 'paused']);
    const last = page.locator('.sites-group:not(.sites-clone) a').last();
    await last.focus();
    assert.deepEqual(await animationNames(page), ['none', 'none', 'none']);
    assert.ok(await last.evaluate(node => {
      const rect = node.getBoundingClientRect(), row = node.closest('.sites-row').getBoundingClientRect();
      return rect.left >= row.left - 1 && rect.right <= row.right + 1;
    }), `${locale}: offscreen link must scroll into keyboard reach`);
    await page.keyboard.press('Enter');
    await page.waitForURL(`**/${prefix(locale)}sites/#*`);
    const anchor = new URL(page.url()).hash;
    assert.equal(await page.locator(anchor).count(), 1);
    await page.goBack();
    assert.equal(await page.locator('.sites-row').count(), 3);
    if (locale === 'en') {
      // The repeated visual strip must also be clickable with the mouse.
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.locator('.home-sites').scrollIntoViewIfNeeded();
      await page.locator('.home-sites-heading a').focus();
      // Move into the stationary viewport first: hovering pauses the moving links.
      await page.locator('.sites-marquee').hover({ position: { x: 10, y: 50 } });
      await page.waitForFunction(() => document.querySelector('[data-sites-carousel]')?.dataset.moving === 'true' && document.querySelector('.sites-track')?.getAnimations().length > 0);
      await page.evaluate(() => {
        const row = document.querySelector('.sites-row'); row.scrollLeft = 0;
        const animation = row.querySelector('.sites-track').getAnimations()[0];
        animation.currentTime = Number(animation.effect.getTiming().duration) * .98;
      });
      const clone = page.locator('.sites-row').first().locator('.sites-clone a').first();
      const target = await clone.getAttribute('href');
      await clone.click();
      await page.waitForURL(origin + target);
    }
    await ctx.close();
  }
  for (const variant of [{ javaScriptEnabled: false }, { reducedMotion: 'reduce' }]) {
    const ctx = await context('ar', { viewport: { width: 390, height: 844 }, ...variant });
    const page = await ctx.newPage();
    await page.goto(`${origin}/ar/`);
    await page.locator('.home-sites').scrollIntoViewIfNeeded();
    assert.deepEqual(await animationNames(page), ['none', 'none', 'none']);
    assert.equal(await page.locator('.sites-clone:visible').count(), 0);
    const link = page.locator('.sites-group:not(.sites-clone) a').last();
    await link.focus(); await page.keyboard.press('Enter');
    await page.waitForURL('**/ar/sites/#*');
    assert.equal(await page.locator('.supported-site').count(), count);
    await noOverflow(page);
    await ctx.close();
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(external, []);
  const home = await readFile('backend/website/dist/index.html', 'utf8');
  const directory = await readFile('backend/website/dist/sites/index.html', 'utf8');
  const report = { languages: languages.length, sites: count, widths, noScript: true, reducedMotion: true, keyboard: true, cloneLinks: true, noPauseCheckbox: true, hoverPause: true, navigationOnlyDownload: true, sourceRequests: external.length, pageErrors: failures, htmlGzipBytes: { home: gzipSync(home).byteLength, directory: gzipSync(directory).byteLength } };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
