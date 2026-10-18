import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Run against a built preview, using the existing Playwright installation.
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = new URL(process.env.WEBSITE_PREVIEW_URL || 'http://127.0.0.1:4321').origin;
const output = resolve('artifacts/website-compare');
const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id', 'ar'];
const sourceLanguage = { mono: 'ja', color: 'zh-TW' };
const prefix = locale => locale === 'zh-CN' ? '' : `${locale.toLowerCase()}/`;
const widths = [1440, 1280, 768, 390, 320];
const errors = [], external = [];
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROMIUM ? { executablePath: process.env.TEST_CHROMIUM } : { channel: 'chrome' }) });
await mkdir(output, { recursive: true });

async function context(extra = {}) {
  const result = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...extra,
  });
  await result.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  result.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return result;
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  assert.ok(overflow.page <= overflow.viewport, `horizontal overflow ${JSON.stringify(overflow)}: ${page.url()}`);
}

async function captureGallery(page, name, fullPage = false) {
  const dismissLanguage = page.locator('[data-language-notice] button');
  if (await dismissLanguage.isVisible()) await dismissLanguage.click();
  await page.evaluate(() => {
    const section = document.querySelector('#translation');
    const header = document.querySelector('.site-header');
    scrollTo({ top: section.getBoundingClientRect().top + scrollY - (header?.getBoundingClientRect().height ?? 80) - 24, behavior: 'instant' });
  });
  await page.locator('.home-image-pair img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
  if (fullPage) await page.screenshot({ path: join(output, `${name}-full.png`), fullPage: true, animations: 'disabled' });
}

const manifest = page => page.locator('[data-home-assets]').evaluate(node => JSON.parse(node.textContent));
const paths = picture => [picture.src, picture.full, ...picture.srcset.split(',').map(candidate => candidate.trim().split(/\s+/)[0])].filter(Boolean);
const assetsMatch = (request, picture) => paths(picture).includes(new URL(request.url()).pathname);

async function ready(page) {
  await page.locator('[data-home-showcase][data-enhanced=true]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function selected(page, sample, language) {
  await page.waitForFunction(({ sample, language }) => {
    const root = document.querySelector('[data-home-showcase]');
    return root?.dataset.sample === sample && root.dataset.language === language
      && document.querySelector('.home-image-pair')?.getAttribute('aria-busy') === 'false';
  }, { sample, language });
  const data = await manifest(page);
  assert.equal(await page.locator('button[data-sample][aria-pressed=true]').getAttribute('data-sample'), sample);
  assert.equal(await page.locator('[data-language-choice][aria-pressed=true]').getAttribute('data-language-choice'), language);
  assert.equal(await page.locator('select[data-language-select]').inputValue(), language);
  assert.equal(await page.locator('[data-open-original]').getAttribute('href'), data.samples[sample].original.full);
  assert.equal(await page.locator('[data-open-translated]').getAttribute('href'), data.samples[sample].translations[language].full);
  assert.equal((await page.locator('[data-translated-language]').textContent()).trim(), data.languageNames[language]);
  assert.equal((await page.locator('[data-original-language]').textContent()).trim(), data.languageNames[sourceLanguage[sample]]);
  for (const [view, picture] of [['original', data.samples[sample].original], ['translated', data.samples[sample].translations[language]]]) {
    const image = page.locator(`[data-comparison=${view}] img`);
    assert.equal(await image.getAttribute('src'), picture.src);
    assert.equal(await image.getAttribute('srcset'), picture.srcset);
    assert.equal(await page.locator(`[data-comparison=${view}] a`).getAttribute('href'), picture.full);
    await image.evaluate(node => node.decode());
    assert.ok(await image.evaluate(node => node.complete && node.naturalWidth > 0));
  }
  assert.equal((await page.locator('[data-image-status]').textContent()).trim(), '');
}

async function choose(page, sample, language, mobile = false) {
  const root = page.locator('[data-home-showcase]');
  if (await root.getAttribute('data-sample') !== sample) {
    await page.locator(`button[data-sample=${sample}]`).click();
    await page.waitForFunction(sample => document.querySelector('[data-home-showcase]')?.dataset.sample === sample
      && document.querySelector('.home-image-pair')?.getAttribute('aria-busy') === 'false', sample);
    await selected(page, sample, await root.getAttribute('data-language'));
  }
  if (mobile) await page.locator('select[data-language-select]').selectOption(language);
  else await page.locator(`[data-language-choice="${language}"]`).click();
  await selected(page, sample, language);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-home-showcase]');
    return {
      sample: root.dataset.sample, language: root.dataset.language,
      select: document.querySelector('[data-language-select]').value,
      original: document.querySelector('[data-original-language]').textContent,
      translated: document.querySelector('[data-translated-language]').textContent,
      fullSizeLinks: [...document.querySelectorAll('[data-open-original], [data-open-translated]')].map(link => link.getAttribute('href')),
      images: [...document.querySelectorAll('.home-image-pair img')].map(image => ({ src: image.getAttribute('src'), srcset: image.getAttribute('srcset'), alt: image.alt, href: image.closest('a').getAttribute('href') })),
      pressed: [...document.querySelectorAll('button[data-sample], [data-language-choice]')].map(button => [button.getAttribute('aria-pressed'), button.hidden]),
    };
  });
}

let scriptGzipBytes, homeHtmlBytes, homeHtmlGzipBytes;
try {
  const ctx = await context(), page = await ctx.newPage();
  for (const locale of locales) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const response = await page.goto(`${origin}/${prefix(locale)}`);
    if (locale === 'zh-CN') {
      const html = await response.text();
      homeHtmlBytes = Buffer.byteLength(html);
      homeHtmlGzipBytes = gzipSync(html).byteLength;
    }
    await ready(page);
    const data = await manifest(page), initial = locale === 'ja' ? 'en' : locale;
    assert.deepEqual(Object.keys(data.languageNames).sort(), [...locales].sort());
    for (const sample of ['mono', 'color']) assert.deepEqual(Object.keys(data.samples[sample].translations).sort(), locales.filter(language => language !== sourceLanguage[sample]).sort());
    assert.equal(await page.locator('main input[type=file], main astro-island, .home-plan, .home-cycle').count(), 0);
    assert.equal(await page.locator('.home-screenshot img').count(), 1);
    assert.equal(await page.locator('.hero-store').count(), 5);
    assert.equal(await page.locator('.home-hero .button').count(), 1);
    assert.match(await page.locator('.home-hero a[data-install-extension]').getAttribute('href'), /^https:\/\/chromewebstore\.google\.com\//);
    assert.equal(await page.locator('#see-it').count(), 1);
    assert.equal(await page.locator('#translation').count(), 1);
    assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
    if (locale === 'zh-CN') assert.equal(await page.locator('h1').textContent(), '不离开网页读懂眼前的漫画');
    await page.locator('#translation').scrollIntoViewIfNeeded();
    await selected(page, 'mono', initial);
    assert.equal(await page.locator('[data-language-choice]:visible').count(), 16);
    for (const language of locales.filter(language => language !== 'ja')) {
      const button = page.locator(`[data-language-choice="${language}"]`);
      assert.ok((await button.textContent()).trim(), `${locale}/${language}: native language name`);
      await button.focus();
      assert.ok(await button.evaluate(node => node === document.activeElement), `${locale}/${language}: keyboard focus`);
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow(page);
      assert.equal(await page.locator('select[data-language-select]').isVisible(), width <= 1000, `${locale}/${width}: native picker breakpoint`);
      assert.equal(await page.locator('[data-language-choice]:visible').count(), width <= 1000 ? 0 : 16, `${locale}/${width}: language button breakpoint`);
    }
    assert.ok(await page.locator('select[data-language-select]').isVisible());
    assert.equal(await page.locator('select[data-language-select] option:not([hidden]):not([disabled])').count(), 16);
    if (['zh-CN', 'en', 'de', 'ar'].includes(locale)) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 1000 ? 1300 : 1200 });
        await captureGallery(page, `gallery-${locale}-${width}`, true);
      }
    }
    if (scriptGzipBytes === undefined) {
      const scripts = await page.locator('script[type=module]').evaluateAll(nodes => nodes.map(node => ({ src: node.getAttribute('src'), content: node.textContent })));
      for (const script of scripts) {
        const text = script.src ? await (await ctx.request.get(new URL(script.src, origin).href)).text() : script.content;
        if (!text.includes('[data-home-showcase]')) continue;
        scriptGzipBytes = gzipSync(text).byteLength;
        assert.ok(scriptGzipBytes <= 4096, `homepage interaction budget: ${scriptGzipBytes} gzip bytes`);
      }
      assert.ok(scriptGzipBytes, 'use a built preview, not the Vite development server');
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/en/`);
  await ready(page);
  await page.locator('#translation').scrollIntoViewIfNeeded();
  for (const sample of ['mono', 'color']) {
    for (const language of locales.filter(language => language !== sourceLanguage[sample])) await choose(page, sample, language);
  }
  for (const language of ['zh-CN', 'en', 'ar']) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 1000 ? 1300 : 1200 });
      await choose(page, 'color', language, width <= 1000);
      await captureGallery(page, `gallery-color-${language}-${width}`, true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await choose(page, 'color', 'ja');
  await page.locator('button[data-sample=mono]').click();
  await selected(page, 'mono', 'en');
  await page.locator('button[data-sample=color]').click();
  await selected(page, 'color', 'ja');
  await choose(page, 'mono', 'zh-TW');
  await page.locator('button[data-sample=color]').click();
  await selected(page, 'color', 'en');
  await page.locator('button[data-sample=mono]').click();
  await selected(page, 'mono', 'zh-TW');
  await page.setViewportSize({ width: 390, height: 844 });
  await choose(page, 'mono', 'ar', true);
  const range = page.locator('.home-image-pair input[type=range]');
  await range.focus();
  await page.keyboard.press('Home');
  assert.equal(await range.inputValue(), '0');
  await page.keyboard.press('End');
  assert.equal(await range.inputValue(), '100');
  assert.ok(await range.getAttribute('aria-valuetext'));
  await page.keyboard.press('Home');
  await noOverflow(page);
  await page.screenshot({ path: join(output, 'gallery-mobile-ar-translation.png'), animations: 'disabled' });
  await ctx.close();

  // A fresh context proves that menus and metadata do not fetch unselected translations.
  const networkContext = await context(), networkPage = await networkContext.newPage();
  const imageRequests = [];
  networkPage.on('request', request => { if (request.resourceType() === 'image') imageRequests.push(new URL(request.url()).pathname); });
  await networkPage.goto(`${origin}/en/`);
  await ready(networkPage);
  await networkPage.locator('#translation').scrollIntoViewIfNeeded();
  await selected(networkPage, 'mono', 'en');
  const data = await manifest(networkPage);
  const sampleAssets = Object.values(data.samples).flatMap(sample => [sample.original, ...Object.values(sample.translations)]).flatMap(paths);
  const allowedInitial = new Set([...paths(data.samples.mono.original), ...paths(data.samples.mono.translations.en)]);
  assert.deepEqual(imageRequests.filter(url => sampleAssets.includes(url) && !allowedInitial.has(url)), [], 'unselected artwork downloaded on initial load');
  assert.equal(imageRequests.some(url => paths(data.inline.original).includes(url)), false, 'hero original must wait for interaction');
  await networkPage.locator('[data-inline-comparison] input[type=range]').focus();
  await networkPage.waitForFunction(() => document.querySelector('[data-inline-comparison]')?.dataset.inlineReady === 'true');
  assert.ok(imageRequests.some(url => paths(data.inline.original).includes(url)));
  const heroRange = networkPage.locator('[data-inline-comparison] input[type=range]');
  await networkPage.keyboard.press('Home');
  assert.equal(await heroRange.inputValue(), '0');
  await networkPage.keyboard.press('End');
  assert.equal(await heroRange.inputValue(), '100');
  await heroRange.hover({ position: { x: 20, y: 20 } });
  assert.ok(Number(await heroRange.inputValue()) < 10, 'desktop pointer did not move the hero comparison');
  await networkPage.locator('#translation').scrollIntoViewIfNeeded();

  // Controlled failure must preserve both images, language state, and full-size links.
  const before = await snapshot(networkPage);
  const failImage = route => assetsMatch(route.request(), data.samples.mono.translations.fr) ? route.abort('failed') : route.fallback();
  await networkContext.route('**/*', failImage);
  await networkPage.locator('[data-language-choice=fr]').click();
  await networkPage.waitForFunction(() => document.querySelector('[data-image-status]')?.textContent.trim()
    && document.querySelector('.home-image-pair')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await snapshot(networkPage), before, 'failed switch changed the visible comparison');
  assert.ok(await networkPage.locator('[data-image-retry]').isVisible());
  assert.equal(await networkPage.locator('button[data-sample]:disabled, [data-language-choice]:disabled, select[data-language-select]:disabled').count(), 0);
  await networkContext.unroute('**/*', failImage);
  await networkPage.locator('[data-image-retry]').click();
  await selected(networkPage, 'mono', 'fr');
  assert.ok(await networkPage.locator('[data-image-retry]').isHidden());
  await choose(networkPage, 'mono', 'en');
  const failOriginal = route => assetsMatch(route.request(), data.samples.color.original) ? route.abort('failed') : route.fallback();
  await networkContext.route('**/*', failOriginal);
  await networkPage.locator('button[data-sample=color]').click();
  await networkPage.waitForFunction(() => document.querySelector('[data-image-status]')?.textContent.trim()
    && document.querySelector('.home-image-pair')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await snapshot(networkPage), before, 'failed original created a mixed-sample comparison');
  await networkContext.unroute('**/*', failOriginal);
  await networkPage.locator('[data-image-retry]').click();
  await selected(networkPage, 'color', 'en');
  await choose(networkPage, 'mono', 'fr');

  // Hold one selected response to make loading and rapid input deterministic.
  let releaseResponse, markRequest;
  const responseGate = new Promise(resolveGate => { releaseResponse = resolveGate; });
  const requestSeen = new Promise(resolveSeen => { markRequest = resolveSeen; });
  const slowImage = async route => {
    if (!assetsMatch(route.request(), data.samples.mono.translations.de)) return route.fallback();
    markRequest();
    await responseGate;
    return route.fallback();
  };
  await networkContext.route('**/*', slowImage);
  const stable = await snapshot(networkPage);
  try {
    await networkPage.locator('[data-language-choice=de]').click();
    await Promise.race([requestSeen, new Promise((_, reject) => setTimeout(() => reject(Error('selected image was not requested')), 10000))]);
    assert.equal(await networkPage.locator('.home-image-pair').getAttribute('aria-busy'), 'true');
    assert.equal(await networkPage.locator('button[data-sample]:disabled').count(), 2);
    assert.equal(await networkPage.locator('[data-language-choice]:disabled').count(), 17);
    assert.ok(await networkPage.locator('select[data-language-select]').isDisabled());
    assert.deepEqual((await snapshot(networkPage)).images, stable.images, 'half-decoded pair became visible');
    // Mouse events on disabled controls must not queue a competing selection.
    await networkPage.locator('[data-language-choice=ko]').click({ force: true });
    await networkPage.locator('button[data-sample=color]').click({ force: true });
  } finally { releaseResponse(); }
  await selected(networkPage, 'mono', 'de');
  await networkContext.unroute('**/*', slowImage);
  await choose(networkPage, 'color', 'ko');

  // Native mobile selection must roll back too, without moving the reading position.
  await networkPage.setViewportSize({ width: 390, height: 844 });
  await networkPage.locator('#translation').scrollIntoViewIfNeeded();
  const mobileBefore = await snapshot(networkPage), scrollBefore = await networkPage.evaluate(() => scrollY);
  const failMobile = route => assetsMatch(route.request(), data.samples.color.translations.ru) ? route.abort('failed') : route.fallback();
  await networkContext.route('**/*', failMobile);
  await networkPage.locator('select[data-language-select]').selectOption('ru');
  await networkPage.waitForFunction(() => document.querySelector('[data-image-status]')?.textContent.trim()
    && document.querySelector('.home-image-pair')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await snapshot(networkPage), mobileBefore);
  assert.ok(Math.abs(await networkPage.evaluate(() => scrollY) - scrollBefore) <= 2, 'failed switch moved the reading position');
  await networkContext.unroute('**/*', failMobile);
  await choose(networkPage, 'color', 'ru', true);
  await networkContext.close();

  const touchContext = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(`${origin}/en/`);
  await ready(touchPage);
  await touchPage.locator('#translation').scrollIntoViewIfNeeded();
  await selected(touchPage, 'mono', 'en');
  const touchRange = touchPage.locator('.home-image-pair input[type=range]');
  await touchRange.scrollIntoViewIfNeeded();
  const box = await touchRange.boundingBox(), cdp = await touchContext.newCDPSession(touchPage);
  assert.ok(box);
  const point = fraction => ({ x: box.x + box.width * fraction, y: Math.max(1, box.y + Math.min(box.height / 2, 120)) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(.2)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(.8)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(Number(await touchRange.inputValue()) >= 75, 'touch drag did not move the comparison');
  const touchScrollBefore = await touchPage.evaluate(() => scrollY);
  const verticalStart = { x: box.x + box.width / 2, y: Math.min(750, Math.max(240, box.y + box.height / 2)) };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [verticalStart] });
  for (const offset of [40, 90, 150]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: verticalStart.x, y: verticalStart.y - offset }] });
    await touchPage.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForFunction(before => scrollY > before + 20, touchScrollBefore);
  assert.equal(touchContext.pages().length, 1, 'touch comparison unexpectedly opened a new image');
  await noOverflow(touchPage);
  for (const view of ['original', 'translated']) {
    const largeImage = touchPage.locator(`[data-open-${view}]`);
    const largeImageUrl = new URL(await largeImage.getAttribute('href'), origin).href;
    const opened = touchPage.waitForEvent('popup');
    await largeImage.click();
    const fullPage = await opened;
    await fullPage.waitForLoadState();
    assert.equal(fullPage.url(), largeImageUrl);
    await fullPage.locator('img').evaluate(image => image.decode());
    const actualSize = await fullPage.locator('img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
    const expectedImage = view === 'original' ? data.samples.mono.original : data.samples.mono.translations.en;
    assert.deepEqual(actualSize, { width: expectedImage.width, height: expectedImage.height });
    await fullPage.close();
  }
  await touchContext.close();

  for (const view of ['original', 'translated']) {
    const retryContext = await context(), retryPage = await retryContext.newPage();
    const initial = view === 'original' ? data.samples.mono.original : data.samples.mono.translations.en;
    let failed = false;
    const failOnce = route => {
      if (!failed && assetsMatch(route.request(), initial)) { failed = true; return route.abort('failed'); }
      return route.fallback();
    };
    await retryContext.route('**/*', failOnce);
    await retryPage.goto(`${origin}/en/`);
    await ready(retryPage);
    await retryPage.locator('#translation').scrollIntoViewIfNeeded();
    await retryPage.locator('[data-image-retry]').waitFor({ state: 'visible' });
    assert.ok(failed, `initial ${view} was not intercepted`);
    assert.ok((await retryPage.locator('[data-image-status]').textContent()).trim());
    await retryPage.locator('[data-image-retry]').scrollIntoViewIfNeeded();
    await retryPage.screenshot({ path: join(output, `gallery-initial-${view}-error.png`), animations: 'disabled' });
    await retryContext.unroute('**/*', failOnce);
    await retryPage.locator('[data-image-retry]').click();
    await selected(retryPage, 'mono', 'en');
    assert.ok(await retryPage.locator('[data-image-retry]').isHidden());
    await retryPage.locator('.home-image-pair[data-inline-ready=true]').waitFor();
    await captureGallery(retryPage, `gallery-initial-${view}-recovered`);
    await retryContext.close();
  }

  for (const variant of [{ javaScriptEnabled: false }, { reducedMotion: 'reduce' }]) {
    const fallbackContext = await context({ locale: 'ar', viewport: { width: 390, height: 844 }, ...variant });
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(`${origin}/ar/`);
    if (variant.javaScriptEnabled !== false) await ready(fallbackPage);
    await fallbackPage.locator('#translation').scrollIntoViewIfNeeded();
    await fallbackPage.locator('[data-comparison=translated] img').evaluate(image => image.decode());
    await noOverflow(fallbackPage);
    if (variant.javaScriptEnabled === false) {
      assert.equal(await fallbackPage.locator('[data-home-showcase]').getAttribute('data-enhanced'), null);
      assert.equal(await fallbackPage.locator('[data-home-controls]:visible').count(), 0);
      assert.ok(await fallbackPage.locator('[data-comparison=original] img').isVisible());
      assert.ok(await fallbackPage.locator('[data-comparison=translated] img').isVisible());
      assert.equal(await fallbackPage.locator('[data-gallery-link]').count(), 32);
      assert.equal(await fallbackPage.locator('[data-gallery-original]').count(), 2);
      assert.equal(await fallbackPage.locator('.home-hero a[data-install-extension]').getAttribute('href'), '/ar/download/');
      await fallbackPage.locator('noscript details summary').first().click();
      assert.ok(await fallbackPage.locator('[data-gallery-link]').first().isVisible());
      await noOverflow(fallbackPage);
    } else {
      assert.equal(await fallbackPage.locator('[data-reveal=pending]').count(), 0);
      await choose(fallbackPage, 'mono', 'fr', true);
      assert.equal(await fallbackPage.locator('.home-image-pair img').evaluateAll(images => images.flatMap(image => image.getAnimations()).length), 0);
      assert.equal(await fallbackPage.locator('#translation').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    }
    await fallbackPage.screenshot({ path: join(output, variant.javaScriptEnabled === false ? 'gallery-no-js-ar.png' : 'gallery-reduced-motion-ar.png'), animations: 'disabled' });
    await fallbackContext.close();
  }
  assert.deepEqual(errors, [], 'browser page errors');
  assert.deepEqual(external, [], 'unexpected third-party requests');
  const report = { locales: locales.length, translations: 32, widths, allLanguageSelections: true, mobileNativePicker: true, lazyUnselectedImages: true, failureRollback: true, initialImageRetry: true, rapidSwitchGuard: true, preferredLanguageRestoration: true, pointerKeyboardAndTouch: true, nativeVerticalScroll: true, fullImagePopup: true, noJavaScriptGallery: true, reducedMotion: true, unchangedHero: true, scriptGzipBytes, homeHtmlBytes, homeHtmlGzipBytes, pageErrors: errors, thirdPartyRequests: external.length };
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
