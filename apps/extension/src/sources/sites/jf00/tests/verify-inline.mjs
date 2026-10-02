import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://www.00jf.com', cdn = 'https://manhua.5um.net/colatj/fixture/1/';
  const catalog = origin + '/comic_7.html', reader = origin + '/chapter_7_11.html';
  // Playwright routes do not intercept the extension worker's image fetches.
  // Mock only this public fixture prefix; the normal permission/header/byte pipeline still runs.
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.jf00FixtureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(input).startsWith(cdn)
      ? Promise.resolve(new Response(new Uint8Array(bytes), {headers: {'Content-Type': 'image/png'}}))
      : globalThis.jf00FixtureFetch(input, options);
  }, {cdn, bytes: [...source]});
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#eee}main{width:760px;margin:180px auto}img{display:block;width:760px;height:100px}</style>
    <img id="ad" src="${cdn}ad.webp"><main><div class="comic-content"><img id="first" class="comic-image" alt="Work - Chapter 1 - 第1张图" src="${cdn}first.webp">
    <img id="lazy" class="comic-image" alt="Work - Chapter 1 - 第2张图" data-src="${cdn}lazy.webp"></div></main>`}));
  try {
    await page.goto(reader); const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
    const rect = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#ad').evaluate(i => i.style.content), ''); assert.equal(await lazy.evaluate(i => i.style.content), '');
    assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
    await page.screenshot({path: path.join(out, 'jf00-translated.png')}); await button('恢复原图');
    await page.waitForFunction(() => !document.querySelector('#first').style.content); assert.deepEqual(await first.boundingBox(), rect);
    await page.screenshot({path: path.join(out, 'jf00-restored.png')}); await button('显示译图');
    await lazy.evaluate(i => {i.src = i.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await first.evaluate(i => {i.src = 'data:image/png;base64,invalid';});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await first.evaluate((i, original) => {i.src = original;}, original);
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 100)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.goto(catalog); await activate(); assert.equal(await first.evaluate(i => i.style.content), '');
    check('00jf: loaded正文 translate/restore, ads and lazy/error images excluded, replacement recovery, geometry/scroll preserved, catalog has no generic fallback');
    return {liveSource: false};
  } finally {
    await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');
    await worker.evaluate(() => {globalThis.fetch = globalThis.jf00FixtureFetch; delete globalThis.jf00FixtureFetch;});
  }
}
