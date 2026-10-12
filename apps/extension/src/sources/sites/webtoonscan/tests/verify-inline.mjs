// Generic recognition on owned reader/catalog/other pages. Images and translation are synthetic.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://webtoonscan.com', cdn = 'https://webtoonscan-fixture.test/';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.webtoonFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.webtoonFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#eef4fa}main{width:650px;margin:120px auto}img{display:block;width:600px;height:600px}#thumb{width:80px;height:80px}footer{height:1000px}</style>
    <img id="thumb" src="${cdn}thumb.png"><main><img id="first" src="${cdn}first.png"><img id="lazy" data-src="${cdn}lazy.png"></main><footer></footer>`}));
  try {
    await page.goto(origin + '/manhwa/sample-book/chapter-1/');
    const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
    const box = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#thumb').evaluate(i => i.style.content), '');
    assert.equal(await lazy.evaluate(i => i.style.content), '');
    assert.deepEqual(await first.boundingBox(), box); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'webtoonscan-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.deepEqual(await first.boundingBox(), box);
    await button('显示译图'); await lazy.evaluate(i => {i.src = i.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 100)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.screenshot({path: path.join(out, 'webtoonscan-restored.png')});
    for (const target of ['/manhwa/sample-book/', '/?s=sample&post_type=wp-manga']) {
      await page.goto(origin + target); await first.evaluate(i => i.decode()); await activate();
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      await button('恢复原图');
    }
    check('WebtoonScan explicitly reuses generic recognition on reader/catalog/other pages: loaded/lazy large images translate, thumbnails are excluded, original URLs/geometry/scroll restore; source and model are synthetic.');
    return {liveSource: false};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.webtoonFixtureFetch; delete globalThis.webtoonFixtureFetch;});
  }
}
