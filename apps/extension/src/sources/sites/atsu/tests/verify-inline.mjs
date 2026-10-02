import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://atsu.moe', cdn = 'https://cdn.atsu.moe', image = cdn + '/static/pages/Work1/Chap1/0.png';
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  // Playwright page routes do not intercept MV3 worker fetches. Stub only our exact synthetic CDN pages.
  await worker.evaluate(({cdn, bytes}) => {
    globalThis.atsuInlineOriginalFetch = fetch;
    const body = Uint8Array.from(atob(bytes), character => character.charCodeAt(0));
    globalThis.fetch = (input, options) => {
      const target = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      return target.origin === cdn && /^\/static\/pages\/(?:Work1\/)?Chap1\/[01]\.png$/.test(target.pathname) && !target.search
        ? Promise.resolve(new Response(body, {status: 200, headers: {'Content-Type': 'image/png'}}))
        : globalThis.atsuInlineOriginalFetch(input, options);
    };
  }, {cdn, bytes: source.toString('base64')});
  await browser.route(cdn + '/**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Atsumaru fixture</title>
    <style>body{margin:0;background:#eaf0f8}main{width:760px;margin:160px auto}img{display:block;width:760px;height:100px}#ad{position:absolute;top:0}#lazy{height:500px}</style>
    <main><img id="ad" src="${image}"><div data-reader-page data-page-number="0"><img id="first" src="${image}"></div>
    <div data-reader-page data-page-number="1"><img id="lazy"></div></main>`}));
  await page.goto(origin + '/read/Work1/Chap1');
  const first = page.locator('#first'); await first.evaluate(img => img.decode()); const box = await first.boundingBox();
  await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  assert.equal(await page.locator('#ad').evaluate(img => img.style.content), '');
  assert.equal(await page.locator('#lazy').evaluate(img => img.style.content), '');
  assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'atsu-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
  assert.equal(await first.getAttribute('src'), image); assert.deepEqual(await first.boundingBox(), box);
  await button('显示译图');
  await page.locator('#lazy').evaluate((img, url) => {img.src = url;}, cdn + '/static/pages/Chap1/1.png');
  await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
  await first.evaluate((img, url) => {img.src = url;}, cdn + '/static/pages/Work1/Other/0.png');
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  await first.evaluate((img, url) => {img.src = url;}, image);
  await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await button('恢复原图'); await page.screenshot({path: path.join(out, 'atsu-restored.png')});
  await page.goto(origin + '/manga/Work1'); await activate();
  assert.equal(await first.evaluate(img => img.style.content), '');
  check('Atsumaru: namespaced and chapter-only reader images translate; ads, unloaded images and foreign chapters are excluded; lazy targets and restoration retain geometry; catalog does not acquire reader images.');
  await browser.unroute(origin + '/**'); await browser.unroute(cdn + '/**');
  await worker.evaluate(() => {globalThis.fetch = globalThis.atsuInlineOriginalFetch; delete globalThis.atsuInlineOriginalFetch;});
  return {liveSource: false};
}
