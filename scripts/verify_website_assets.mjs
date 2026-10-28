import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = new URL(process.env.WEBSITE_PREVIEW_URL || 'http://127.0.0.1:4321').origin;
const output = resolve(process.env.WEBSITE_ASSETS_OUTPUT || 'output/playwright/website-assets');
const published = !['127.0.0.1','localhost'].includes(new URL(origin).hostname);
const browser = await chromium.launch({channel:'chrome', headless:true});
const errors = [], results = {origin, publishedCacheCheck:published, images:[]};
await mkdir(output, {recursive:true});
async function context(options = {}) {
  // Do not install route handlers: Playwright routing disables the real browser HTTP cache.
  const ctx = await browser.newContext({locale:'en', viewport:{width:1440,height:1000}, ...options});
  ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return ctx;
}
async function decode(image) { await image.scrollIntoViewIfNeeded(); await image.evaluate(node => node.decode()); }
async function openFlags(page) {
  await page.locator('.language-menu summary').focus();
  await page.keyboard.press('Enter');
  for (const image of await page.locator('.language-menu nav .language-flag').all()) await decode(image);
  assert.equal(await page.locator('.language-flag').evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0)), true);
}
async function noOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), page.url());
}
try {
  const ctx = await context(), page = await ctx.newPage(), requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  await page.goto(origin + '/en/guides/android-firefox/');
  await page.locator('.language-menu summary .language-flag').evaluate(image => image.decode());
  const flagURLs = await page.locator('.language-menu nav .language-flag').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
  assert.equal(new Set(flagURLs).size, 17);
  assert(flagURLs.every(url => /^\/_astro\/[a-z]{2}\.[\w-]+\.svg$/.test(url)));
  const coldFlags = requested.filter(url => flagURLs.includes(url));
  assert.equal(coldFlags.length, 1, 'closed menu must not download the other 16 flags');
  assert.equal(coldFlags[0], await page.locator('.language-menu summary .language-flag').getAttribute('src'));
  await openFlags(page);
  assert.equal(new Set(requested.filter(url => flagURLs.includes(url))).size, 17);
  if (published) for (const url of flagURLs) {
    const response = await ctx.request.get(origin + url);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['cache-control'], /max-age=31536000/);
    assert.match(response.headers()['cache-control'], /immutable/);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.language-menu').evaluate(node => node.open), false);
  await page.goto(origin + '/en/guides/');
  assert.deepEqual(await page.locator('.language-menu nav .language-flag').evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))), flagURLs);
  await openFlags(page);
  const warm = await page.evaluate(urls => performance.getEntriesByType('resource').filter(entry => urls.includes(new URL(entry.name).pathname)).map(entry => ({url:new URL(entry.name).pathname, transfer:entry.transferSize, decoded:entry.decodedBodySize})), flagURLs);
  if (published) {
    assert.equal(warm.length, 17);
    assert(warm.every(entry => entry.transfer === 0 && entry.decoded > 0), 'cross-page flag requests must reuse the browser cache');
  }
  results.flags = {coldRequests:coldFlags.length, expandedFlags:17, warm};
  await ctx.close();

  for (const locale of ['zh-CN','en','ar']) {
    const path = locale === 'zh-CN' ? '' : locale + '/';
    const mobile = await context({locale, viewport:{width:390,height:844}, deviceScaleFactor:2});
    const tab = await mobile.newPage(), imagesRequested = [];
    tab.on('request', request => { if (request.resourceType() === 'image') imagesRequested.push(new URL(request.url()).pathname); });
    await tab.goto(`${origin}/${path}guides/android-firefox/`);
    const originals = await tab.locator('.guide-screenshot > a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    assert.equal(originals.length, 3);
    for (const image of await tab.locator('.guide-screenshot img').all()) {
      await decode(image);
      const info = await image.evaluate(node => ({src:new URL(node.currentSrc).pathname, srcset:node.srcset, sizes:node.sizes, width:node.clientWidth, height:node.clientHeight, loading:node.loading}));
      assert.match(info.src, /\.webp$/);
      assert.match(info.srcset, /320w.*540w.*720w/);
      assert.equal(info.loading, 'lazy');
      assert(Math.abs(info.height / info.width - 2400 / 1080) < .01);
      const response = await mobile.request.get(origin + info.src);
      assert.equal(response.status(), 200);
      const bytes = (await response.body()).length;
      assert(bytes < 200_000, 'mobile image budget');
      results.images.push({locale, ...info, bytes});
    }
    assert(!imagesRequested.some(url => originals.includes(url)), 'full PNGs must not download while browsing the guide');
    await tab.screenshot({path:join(output, `phone-${locale}.png`)});
    const popupPromise = tab.waitForEvent('popup');
    await tab.locator('.guide-screenshot > a').last().click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).pathname, originals.at(-1));
    await popup.close();
    await tab.evaluate(() => scrollTo({top:0, behavior:'instant'}));
    await openFlags(tab);
    await tab.locator('.language-menu nav').evaluate(node => node.scrollTop = 0);
    await tab.screenshot({path:join(output, `menu-${locale}.png`)});
    await tab.setViewportSize({width:320,height:740});
    await noOverflow(tab);
    assert(await tab.locator('.language-menu nav').evaluate(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
    }), `${locale}: open flag menu must remain inside the narrow viewport`);
    await mobile.close();
  }

  for (const variant of ['no-js','failed-images']) {
    const ctx = await context({javaScriptEnabled:variant !== 'no-js', viewport:{width:390,height:844}}), page = await ctx.newPage();
    if (variant === 'failed-images') await ctx.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
    await page.goto(origin + '/en/guides/android-firefox/');
    await page.locator('.language-menu summary').click();
    assert.equal(await page.locator('.language-menu nav a').count(), 17);
    await page.locator('.language-menu a[lang=ar]').scrollIntoViewIfNeeded();
    await page.locator('.language-menu a[lang=ar]').click();
    await page.waitForURL('**/ar/guides/android-firefox/');
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert(await page.locator('main').innerText());
    assert.equal(await page.locator('.guide-screenshot img').evaluateAll(nodes => nodes.every(node => node.alt && node.width > 0 && node.height > 0)), true);
    await noOverflow(page);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  results.fallbacks = ['no-js', 'failed-images'];
  results.pageErrors = errors;
  await writeFile(join(output,'verification.json'), JSON.stringify(results,null,2));
  console.log(`Passed lazy/cached flags, responsive mobile screenshots, original links, RTL, no-JS and failure fallback (${origin}).`);
} finally { await browser.close(); }
