// Synthetic DOM/images and the common local translation API; no source or provider requests.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://klmanga.zone', cdn = 'https://klmanga-inline-fixture.test/images/';
  const catalog = origin + '/manga-raw/fixture-raw-free/', reader = catalog + 'chapter-1/';
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.klmangaFixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.klmangaFixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>KLManga fixture</title>
    <style>body{margin:0;background:#edf2f8}main{width:800px;margin:100px auto}img{display:block;width:600px;height:600px}
    #thumb{width:80px;height:80px}#long{width:800px;height:25014px}footer{height:1000px}</style>
    <img id="thumb" src="${cdn}thumb.png"><main><img id="first" src="${cdn}first.png"><img id="lazy" data-src="${cdn}lazy.png">
    <img id="long" src="${cdn}long.png"></main><footer></footer>`}));
  try {
    await page.goto(reader);
    const first = page.locator('#first'), lazy = page.locator('#lazy'), long = page.locator('#long');
    await first.evaluate(image => image.decode()); await long.evaluate(image => image.decode());
    const rect = await first.boundingBox(), original = await first.getAttribute('src');
    await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#thumb').evaluate(image => image.style.content), '');
    assert.equal(await lazy.evaluate(image => image.style.content), '');
    assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'klmanga-translated.png')});
    await button('恢复原图');
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.deepEqual(await first.boundingBox(), rect);
    await button('显示译图');
    await lazy.evaluate(image => {image.src = image.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await long.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#long').style.content.includes('blob:'));
    const longOriginal = await long.getAttribute('src');
    await page.evaluate(() => {
      const image = document.querySelector('#long'); scrollTo(0, image.getBoundingClientRect().top + scrollY + 3500);
    });
    const longRect = await long.boundingBox(), scroll = await page.evaluate(() => scrollY);
    assert.equal(longRect.width, 800); assert.equal(longRect.height, 25014); assert(scroll > 3500);
    await button('恢复原图');
    await page.waitForFunction(() => !document.querySelector('#long').style.content);
    assert.deepEqual(await long.boundingBox(), longRect); assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(await long.getAttribute('src'), longOriginal);
    await page.screenshot({path: path.join(out, 'klmanga-long-restored.png')});
    await button('显示译图');
    await page.waitForFunction(() => document.querySelector('#long').style.content.includes('blob:'));
    assert.deepEqual(await long.boundingBox(), longRect); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.evaluate(url => history.pushState({}, '', url), catalog);
    await page.waitForFunction(() => ['first', 'lazy', 'long'].every(id => !document.getElementById(id).style.content));
    check('KLManga generic recognition filters thumbnails, translates loaded/lazy 600×600 panels and the 800×25014 CSS long page, restores original src/geometry/scroll and clears overlays on reader-to-catalog navigation; image bytes/API are synthetic.');
    return {liveSource: false};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.klmangaFixtureFetch; delete globalThis.klmangaFixtureFetch;});
  }
}
