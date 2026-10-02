import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://rawotaku.com', cdn = 'https://sv1.freeimgmg.online/files/7/11/';
  const reader = origin + '/read/fixture/ja/chapter-1-raw/', catalog = origin + '/read/fixture-raw/';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.rawotakuFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.rawotakuFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>RawOtaku fixture</title>
    <style>body{margin:0;background:#eaf0f8}main{width:760px;margin:180px auto}img{display:block;width:760px;height:100px}#lazy{height:500px}#ad{position:absolute;top:0}</style>
    <img id="ad" src="${cdn}1.webp"><main><div id="vertical-content"><div class="iv-card"><img id="first" class="image-vertical" alt="0" src="${cdn}1.webp" data-src="${cdn}1.webp"></div>
    <div class="iv-card"><img id="lazy" class="image-vertical" alt="1" data-src="${cdn}2.webp"></div></div></main>`}));
  let liveSource = false;
  try {
    await page.goto(reader); const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
    const box = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#ad').evaluate(i => i.style.content), ''); assert.equal(await lazy.evaluate(i => i.style.content), '');
    assert.deepEqual(await first.boundingBox(), box); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'rawotaku-translated.png')}); await button('恢复原图');
    await page.waitForFunction(() => !document.querySelector('#first').style.content); assert.deepEqual(await first.boundingBox(), box);
    await button('显示译图'); await lazy.evaluate(i => {i.src = i.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await first.evaluate(i => {i.src = 'data:image/png;base64,invalid';});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await first.evaluate((i, src) => {i.src = src;}, original);
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => document.querySelector('#vertical-content').id = 'horizontal-content');
    await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 100)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.screenshot({path: path.join(out, 'rawotaku-restored.png')});
    await page.goto(catalog); await activate(); assert.equal(await first.evaluate(i => i.style.content), '');
    check('RawOtaku: vertical/horizontal正文 and short slices translate, lazy loading and image replacement recover, ads/errors excluded, original src/geometry/scroll retained, catalog has no generic fallback.');
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    if (process.env.RUN_LIVE_RAWOTAKU === '1') {
      // Live DOM and browser CDN loading; submitted bytes/overlay remain the local synthetic fixture.
      // This keeps the common fixture API independent of the real image's encoding and dimensions.
      await worker.evaluate(bytes => {
        globalThis.fetch = (input, options) => /^https:\/\/sv[1-5]\.freeimgmg\.online\/files\//.test(String(typeof input === 'string' ? input : input.url ?? input))
          ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
          : globalThis.rawotakuFixtureFetch(input, options);
      }, [...source]);
      await page.goto(origin + '/read/ブルーロック/ja/chapter-1-raw/');
      const image = page.locator('#vertical-content > .iv-card > img.image-vertical').first();
      await image.waitFor();
      await page.waitForFunction(() => {
        const img = document.querySelector('#vertical-content .iv-card img');
        return img?.complete && img.naturalWidth > 80 && img.currentSrc === img.dataset.src;
      });
      await image.evaluate(i => i.decode()); const rect = await image.boundingBox();
      await activate(); await page.waitForFunction(() => document.querySelector('#vertical-content .iv-card img').style.content.includes('blob:'));
      assert.deepEqual(await image.boundingBox(), rect); await page.screenshot({path: path.join(out, 'rawotaku-live-translated.png')});
      await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#vertical-content .iv-card img').style.content);
      assert.deepEqual(await image.boundingBox(), rect); await page.screenshot({path: path.join(out, 'rawotaku-live-restored.png')});
      check('Live RawOtaku DOM recognizes loaded CDN originals and displays/restores simulated results without changing geometry; translation input bytes and provider are synthetic.');
      liveSource = true;
    }
    return {liveSource};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.rawotakuFixtureFetch; delete globalThis.rawotakuFixtureFetch;});
  }
}
