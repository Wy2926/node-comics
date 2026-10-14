// Synthetic DOM/images and the common local translation API; no source or provider requests.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  for (const origin of ['https://rawkuro.net', 'https://raw1001.net']) {
    const label = new URL(origin).hostname, cdn = 'https://rawkuro-inline-fixture.test/images/';
    const catalog = origin + '/manga/fixture/', reader = catalog + 'di1hua';
    const worker = browser.serviceWorkers()[0];
    await worker.evaluate(({cdn, bytes}) => {
      globalThis.rawkuroFixtureFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
        ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
        : globalThis.rawkuroFixtureFetch(input, options);
    }, {cdn, bytes: [...source]});
    await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
    await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>RawKuro fixture</title>
      <style>body{margin:0;background:#edf2f8}main{width:800px;margin:100px auto}img{display:block;width:600px;height:600px}
      #thumb{width:80px;height:80px}footer{height:1000px}</style>
      <img id="thumb" src="${cdn}thumb.png"><main><img id="first" src="${cdn}first.png"><img id="lazy" data-src="${cdn}lazy.png"></main><footer></footer>`}));
    try {
      await page.goto(reader);
      const first = page.locator('#first'), lazy = page.locator('#lazy');
      await first.evaluate(image => image.decode());
      const rect = await first.boundingBox(), original = await first.getAttribute('src');
      await activate();
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      assert.equal(await page.locator('#thumb').evaluate(image => image.style.content), '');
      assert.equal(await lazy.evaluate(image => image.style.content), '');
      assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
      await page.screenshot({path: path.join(out, label + '-translated.png')});
      await button('恢复原图');
      await page.waitForFunction(() => !document.querySelector('#first').style.content);
      assert.deepEqual(await first.boundingBox(), rect);
      await button('显示译图');
      await lazy.evaluate(image => {image.src = image.dataset.src;});
      await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
      await page.evaluate(url => history.pushState({}, '', url), catalog);
      await page.waitForFunction(() => ['first', 'lazy'].every(id => !document.getElementById(id).style.content));
      check(label + ' uses generic loaded/lazy image recognition, excludes thumbnails, restores original geometry and clears overlays on navigation; synthetic images/API.');
    } finally {
      await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
      await worker.evaluate(() => {globalThis.fetch = globalThis.rawkuroFixtureFetch; delete globalThis.rawkuroFixtureFetch;});
    }
  }
  return {liveSource: false};
}
