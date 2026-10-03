import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://mangapill.com', cdn = 'https://cdn.readdetectiveconan.com/file/mangap/2/10001000/';
  const reader = origin + '/chapters/2-10001000/fixture-chapter-1', catalog = origin + '/manga/2/fixture';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.mangapillFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.mangapillFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <link rel="canonical" href="${reader}"><style>body{margin:0;background:#eaf0f8}main{width:760px;margin:180px auto}img{display:block;width:760px;height:100px}#lazy{height:500px}#ad{position:absolute;top:0}</style>
    <img id="ad" class="js-page" src="${cdn}1.jpeg"><main><h1 id="top">Fixture Chapter 1</h1><a data-hotkey="m" href="${catalog}">Fixture</a>
    <div id="chapter-selector-modal-title">Fixture Chapters</div>
    <chapter-page><span data-summary>page 1/2</span><img id="first" class="js-page" alt="Fixture Chapter 1 Page 1" src="${cdn}1.jpeg" data-src="${cdn}1.jpeg"></chapter-page>
    <chapter-page><span data-summary>page 2/2</span><img id="lazy" class="js-page" alt="Fixture Chapter 1 Page 2" data-src="${cdn}2.jpeg"></chapter-page></main>`}));
  let liveSource = false;
  try {
    await page.goto(reader); const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(image => image.decode());
    const rect = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#ad').evaluate(image => image.style.content), '');
    assert.equal(await lazy.evaluate(image => image.style.content), '');
    assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'mangapill-translated.png')}); await button('恢复原图');
    await page.waitForFunction(() => !document.querySelector('#first').style.content); assert.deepEqual(await first.boundingBox(), rect);
    await button('显示译图'); await lazy.evaluate(image => {image.src = image.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await first.evaluate(image => {image.src = 'data:image/png;base64,invalid';});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await first.evaluate((image, src) => {image.src = src;}, original);
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 100)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.screenshot({path: path.join(out, 'mangapill-restored.png')});
    await page.goto(catalog); await activate(); assert.equal(await first.evaluate(image => image.style.content), '');
    check('MangaPill: loaded chapter-page originals and short slices translate/restore, lazy loading and image replacement recover, ads/errors excluded, original src/geometry/scroll retained, catalog has no generic fallback.');
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    if (process.env.RUN_LIVE_MANGAPILL === '1') {
      // Source DOM and browser originals are live; submitted pixels/results remain synthetic.
      await page.goto(process.env.MANGAPILL_READER_URL || origin + '/chapters/2-10001000/one-piece-chapter-1');
      const image = page.locator('chapter-page img.js-page').first(); await image.waitFor();
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const image = document.querySelector('chapter-page img.js-page');
        return image?.complete && image.naturalWidth > 80 && image.currentSrc === image.dataset.src;
      }, null, {timeout: 60000});
      await image.evaluate(value => value.decode()); const box = await image.boundingBox();
      const urls = await page.locator('chapter-page img.js-page').evaluateAll(images => images.map(image => image.dataset.src).filter(Boolean));
      await worker.evaluate(({urls, bytes}) => {
        const originals = new Set(urls);
        globalThis.fetch = (input, options) => originals.has(String(typeof input === 'string' ? input : input.url ?? input))
          ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
          : globalThis.mangapillFixtureFetch(input, options);
      }, {urls, bytes: [...source]});
      await activate(); await page.waitForFunction(() => document.querySelector('chapter-page img.js-page').style.content.includes('blob:'));
      assert.deepEqual(await image.boundingBox(), box); await page.screenshot({path: path.join(out, 'mangapill-live-translated.png')});
      await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('chapter-page img.js-page').style.content);
      assert.deepEqual(await image.boundingBox(), box); await page.screenshot({path: path.join(out, 'mangapill-live-restored.png')});
      check('Live MangaPill DOM recognizes loaded originals and displays/restores simulated results with unchanged geometry; translation inputs/provider are synthetic.');
      liveSource = true;
    }
    return {liveSource};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.mangapillFixtureFetch; delete globalThis.mangapillFixtureFetch;});
  }
}
