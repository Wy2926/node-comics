// Synthetic source pixels + simulated translation only. Verify generic recognition remains active after site ownership.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://comickz.co.uk', cdn = 'https://cdn1.comicknew.pictures/inline-fixture/1_1/en/test/';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.comickzFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}})) : globalThis.comickzFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>ComicK fixture</title>
    <style>body{margin:0}main{width:600px;margin:100px auto}img{display:block;width:600px;height:600px}#thumb{width:60px;height:60px}footer{height:1600px}</style>
    <img id="thumb" src="${cdn}thumb.webp"><main><img id="first" src="${cdn}first.webp"><img id="lazy" data-src="${cdn}lazy.webp"></main><footer></footer>`}));
  try {
    await page.goto(origin + '/comic/inline-fixture/Test-chapter-1-en');
    const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(image => image.decode());
    const rect = await first.boundingBox(), original = await first.getAttribute('src');
    await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#thumb').evaluate(image => image.style.content), '');
    assert.equal(await lazy.evaluate(image => image.style.content), '');
    assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'comickz-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.deepEqual(await first.boundingBox(), rect);
    await button('显示译图'); await lazy.evaluate(image => {image.src = image.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await lazy.scrollIntoViewIfNeeded(); const scroll = await page.evaluate(() => scrollY), lazyRect = await lazy.boundingBox();
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#lazy').style.content);
    assert.equal(await page.evaluate(() => scrollY), scroll); assert.deepEqual(await lazy.boundingBox(), lazyRect);
    await button('显示译图'); await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await page.evaluate(url => history.pushState({}, '', url), origin + '/comic/inline-fixture');
    await page.waitForFunction(() => ['first', 'lazy'].every(id => !document.getElementById(id).style.content));
    check('ComicK ownership explicitly retains generic loaded/lazy image recognition, thumbnail filtering, original geometry/scroll restoration and navigation invalidation; synthetic images/translation only.');
    return {liveSource: false};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.comickzFixtureFetch; delete globalThis.comickzFixtureFetch;});
  }
}
