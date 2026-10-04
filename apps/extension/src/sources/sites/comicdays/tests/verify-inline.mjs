// Isolated MV3 + mock translation service. RUN_LIVE_COMICDAYS=1 also reads the real public chapter.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://comic-days.com', cdn = 'https://cdn-img.comic-days.com';
  const sourceWidth = source.readUInt32BE(16), sourceHeight = source.readUInt32BE(20);
  const imageUrl = cdn + '/public/page/2/900-abcdef', failedUrl = cdn + '/public/page/2/901-abcdef';
  const data = episode => ({readableProduct: {id: episode, typeName: 'episode', title: 'Engine fixture', permalink: origin + '/episode/' + episode,
    pageStructure: {choJuGiga: 'baku', readingDirection: 'rtl', pages: [imageUrl, imageUrl, failedUrl].map(src => ({type: 'main', width: sourceWidth, height: sourceHeight, src}))}}});
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  // Independent synthetic encoding. The product decoder must reconstruct these exact original pixels.
  const encoded = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const w = Math.floor(bitmap.width / 32) * 8, h = Math.floor(bitmap.height / 32) * 8;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ctx.drawImage(bitmap, x * w, y * h, w, h, y * w, x * h, w, h);
    bitmap.close(); return Array.from(new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()));
  }, source.toString('base64'));
  const worker = browser.serviceWorkers()[0];
  // Browser routing does not intercept every extension service-worker fetch.
  // Intercept only the synthetic URLs; live artwork still uses the real transport.
  await worker.evaluate(({imageUrl, failedUrl, encoded}) => {
    globalThis.comicdaysFixtureFetch = globalThis.fetch;
    globalThis.comicdaysFailedReads = 0;
    globalThis.fetch = (input, options) => {
      const url = String(typeof input === 'string' ? input : input.url ?? input);
      if (url === failedUrl) {
        globalThis.comicdaysFailedReads++;
        return Promise.resolve(new Response('', {status: 503}));
      }
      if (url === imageUrl) return Promise.resolve(new Response(new Uint8Array(encoded), {headers: {'Content-Type': 'image/png'}}));
      return globalThis.comicdaysFixtureFetch(input, options);
    };
  }, {imageUrl, failedUrl, encoded});
  try {
    let failedReads = 0;
    await browser.route(cdn + '/**', route => {
      if (route.request().url() === failedUrl) {failedReads++; return route.fulfill({status: 503, body: ''});}
      return route.fulfill({contentType: 'image/png', body: Buffer.from(encoded)});
    });
    await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <style>body{margin:0;background:#eef3fa}.js-viewer-content{display:flex;gap:12px;padding:80px 12px}p{margin:0;position:relative}canvas{display:block;width:380px;height:522.5px}#ad{position:absolute;left:-1500px}</style>
      <script id="episode-json" type="text/json" data-value="${escape(JSON.stringify(data('11')))}"></script>
      <canvas id="ad" width="${sourceWidth}" height="${sourceHeight}"></canvas><div class="js-viewer"><div class="js-viewer-content">
      <p class="js-page-area"><canvas id="first" class="js-page-image" width="${sourceWidth}" height="${sourceHeight}"></canvas></p>
      <p class="js-page-area"><canvas id="second" class="js-page-image" width="0" height="0"></canvas></p>
      <p class="js-page-area"><canvas id="failed" class="js-page-image" width="${sourceWidth}" height="${sourceHeight}"></canvas></p></div></div>`}));
    await page.goto(origin + '/episode/11');
    await page.evaluate(async url => {const img = new Image(); img.src = url; await img.decode();
      document.querySelector('#first').getContext('2d').drawImage(img, 0, 0);}, imageUrl);
    const first = page.locator('#first'), before = await first.boundingBox();
    assert(await first.evaluate(c => {try {c.toDataURL(); return false;} catch {return true;}}));
    await activate();
    await page.waitForFunction(() => document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'), {}, {timeout: 30000});
    assert.deepEqual(await first.boundingBox(), before);
    assert(failedReads > 0 || await worker.evaluate(() => globalThis.comicdaysFailedReads > 0));
    assert.equal(await page.locator('#failed').evaluate(c => c.nextElementSibling?.hasAttribute('data-nc-canvas-translation') ?? false), false);
    assert.equal(await page.locator('#ad').evaluate(c => c.nextElementSibling?.hasAttribute('data-nc-canvas-translation') ?? false), false);
    // Compare the composite against the synthetic source outside the mock translated region.
    const fixtureError = await page.locator('#first + [data-nc-canvas-translation]').evaluate(async (img, base64) => {
      const expected = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
      const c = new OffscreenCanvas(expected.width, expected.height), x = c.getContext('2d'); x.drawImage(expected, 0, 0);
      const a = x.getImageData(0, 0, c.width, c.height).data; x.clearRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
      const b = x.getImageData(0, 0, c.width, c.height).data; expected.close();
      let error = 0, count = 0;
      for (let i = 0; i < a.length; i++) {const p = Math.floor(i / 4), px = p % c.width, py = Math.floor(p / c.width);
        if (px >= 36 && px < 556 && py >= 36 && py < 236) continue;
        error += Math.abs(a[i] - b[i]); count++;}
      return error / count;
    }, source.toString('base64'));
    // Final display composites use the existing lossy WebP cache; decoder losslessness is tested separately.
    assert(fixtureError < 2, 'reconstructed composite differs from the original: ' + fixtureError);
    await page.locator('#second').evaluate((c, size) => {c.width = size.width; c.height = size.height;}, {width: sourceWidth, height: sourceHeight});
    await page.waitForFunction(() => document.querySelector('#second').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
    await page.screenshot({path: path.join(out, 'comicdays-fixture-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
    assert.deepEqual(await first.boundingBox(), before);
    await button('显示译图'); await page.waitForFunction(() => document.querySelector('[data-nc-canvas-translation]'));
    await page.locator('#episode-json').evaluate(s => s.setAttribute('data-value', '{}'));
    await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
    await page.evaluate(value => {history.pushState({}, '', '/episode/12'); document.querySelector('#episode-json').setAttribute('data-value', JSON.stringify(value));}, data('12'));
    await activate(); await page.waitForFunction(() => document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
    check(`Comic DAYS: GigaViewer composite matches the original (mean channel error ${fixtureError.toFixed(4)}); tainted canvases, failed neighbour, lazy pages, restore and SPA invalidation preserve geometry`);
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '/**');
    await worker.evaluate(() => {
      globalThis.fetch = globalThis.comicdaysFixtureFetch;
      delete globalThis.comicdaysFixtureFetch; delete globalThis.comicdaysFailedReads;
    });
  }
  if (process.env.RUN_LIVE_COMICDAYS !== '1') return {liveSource: false};

  const selector = '.js-viewer .js-viewer-content > p.js-page-area canvas.js-page-image';
  await page.goto(origin + '/episode/12207421984001216436', {waitUntil: 'domcontentloaded'});
  await page.locator(selector).first().waitFor({timeout: 60000});
  const canvas = page.locator(selector).first();
  await page.waitForFunction(selector => document.querySelector(selector)?.width === 1125, selector);
  const box = await canvas.boundingBox();
  assert(await canvas.evaluate(c => {try {c.toDataURL(); return false;} catch {return true;}}));
  await activate(); await page.locator('[data-nc-canvas-translation]').first().waitFor({timeout: 60000});
  assert.deepEqual(await canvas.boundingBox(), box);
  // Capture after the first completed render, not during the site's transient keyboard hint.
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  const original = await canvas.screenshot({path: path.join(out, 'comicdays-live-original-crop.png')});
  await button('显示译图'); await page.locator('[data-nc-canvas-translation]').first().waitFor();
  const translated = await canvas.screenshot({path: path.join(out, 'comicdays-live-translated-crop.png')});
  // Chrome downsamples <img> and <canvas> differently. Compare artwork using
  // the same canvas renderer; keep the real <img> screenshot and exact layout check too.
  await canvas.evaluate(c => {
    const img = c.nextElementSibling, reference = document.createElement('canvas');
    reference.width = img.naturalWidth; reference.height = img.naturalHeight;
    reference.style.cssText = img.style.cssText; reference.style.setProperty('z-index', '2', 'important');
    reference.dataset.fixtureReference = ''; reference.getContext('2d').drawImage(img, 0, 0); img.after(reference);
  });
  const reference = await canvas.screenshot({path: path.join(out, 'comicdays-live-canvas-reference.png')});
  await page.locator('[data-fixture-reference]').evaluate(c => c.remove());
  const overlayGeometry = await canvas.evaluate(c => [c, c.nextElementSibling].map(e => {const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return {x: r.x, y: r.y, width: r.width, height: r.height, imageRendering: s.imageRendering, transform: s.transform};}));
  assert.deepEqual(overlayGeometry[1], overlayGeometry[0]);
  const differences = await page.evaluate(async ({original, translated, reference}) => {
    const decode = async base64 => createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
    const a = await decode(original);
    const c = new OffscreenCanvas(a.width, a.height), x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(a, 0, 0); const ap = x.getImageData(0, 0, c.width, c.height).data;
    a.close();
    const compare = async encoded => {
      const b = await decode(encoded);
      x.clearRect(0, 0, c.width, c.height); x.drawImage(b, 0, 0); const bp = x.getImageData(0, 0, c.width, c.height).data;
      b.close(); let error = 0, count = 0;
      // Exclude the mock overlay and status badge at the top; all lower artwork must match.
      for (let i = Math.ceil(c.height * .35) * c.width * 4; i < ap.length; i++) {error += Math.abs(ap[i] - bp[i]); count++;}
      return error / count;
    };
    return {image: await compare(translated), canvas: await compare(reference)};
  }, {original: original.toString('base64'), translated: translated.toString('base64'), reference: reference.toString('base64')});
  assert(differences.canvas < 1, 'live original and decoded artwork differ outside the mock overlay: ' + JSON.stringify(differences));
  await page.screenshot({path: path.join(out, 'comicdays-live-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  assert.deepEqual(await canvas.boundingBox(), box);
  assert.deepEqual(await canvas.screenshot(), original, 'restoring must preserve the original canvas pixels');
  await page.screenshot({path: path.join(out, 'comicdays-live-restored.png')});
  await button('显示译图'); await page.locator('[data-nc-canvas-translation]').first().waitFor();
  await page.locator('.js-viewer .js-slide-forward').click({position: {x: 24, y: 200}});
  await page.waitForFunction(selector => {
    const visible = [...document.querySelectorAll(selector)].filter(c => {const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top < innerHeight;});
    return visible.length === 2 && visible.every(c => c.nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  }, selector, {timeout: 60000});
  await page.screenshot({path: path.join(out, 'comicdays-live-next-spread.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  check(`Live Comic DAYS: decoded artwork matches (same-renderer mean channel error ${differences.canvas.toFixed(4)}, img resampling ${differences.image.toFixed(4)}); exact overlay geometry, two-page turn and pixel-identical restoration succeed; local mock translation only`);
  return {liveSource: true};
}
