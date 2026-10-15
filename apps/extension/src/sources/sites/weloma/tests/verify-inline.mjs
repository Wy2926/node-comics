// Generic recognition against synthetic loaded/lazy WeLoMa DOM; no real model calls.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://weloma.net', cdn = 'https://weloma-fixture.test/';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.welomaFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.welomaFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>WeLoMa fixture</title>
    <style>body{margin:0;background:#edf2f8}main{width:800px;margin:100px auto}img{display:block;width:600px;height:600px}
    #thumb{width:80px;height:80px}footer{height:1000px}</style><img id="thumb" src="${cdn}cover.png">
    <main id="chapter-images"><img class="chapter-img" id="first" src="${cdn}first.png">
    <img class="chapter-img" id="lazy" data-img="${Buffer.from(cdn + 'lazy.png').toString('base64')}"></main><footer></footer>`}));
  try {
    await page.goto(origin + '/c/eFg12');
    const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
    const rect = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#thumb').evaluate(i => i.style.content), ''); assert.equal(await lazy.evaluate(i => i.style.content), '');
    assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'weloma-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.deepEqual(await first.boundingBox(), rect);
    await button('显示译图'); await lazy.evaluate(i => {i.src = atob(i.dataset.img);});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 120)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.screenshot({path: path.join(out, 'weloma-restored.png')});
    for (const target of ['/m/0AbCd', '/l/0OYCn?name=sample']) {
      await page.goto(origin + target); await first.evaluate(i => i.decode()); await activate();
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      await page.evaluate(() => history.pushState({}, '', '/c/eOther'));
      await page.waitForFunction(() => !document.querySelector('#first').style.content);
    }
    check('WeLoMa reuses generic recognition on reader/catalog/other pages: loaded/lazy originals, excluded thumbnails, geometry/scroll restore and navigation invalidation; synthetic images/API.');
    return {liveSource: false};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.welomaFixtureFetch; delete globalThis.welomaFixtureFetch;});
  }
}
