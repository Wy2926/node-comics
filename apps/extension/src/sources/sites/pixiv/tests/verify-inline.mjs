import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://www.pixiv.net', cdn = 'https://i.pximg.net/fixture/';
  await browser.route(cdn + '**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0}main{width:600px;margin:100px auto}img{display:block;width:600px;height:600px}#thumb{width:80px;height:80px}</style>
    <img id="thumb" src="${cdn}thumb.png"><main><img id="first" src="${cdn}first.png"><img id="lazy"></main>`}));
  try {
    for (const binding of ['', '#nodelane-pixiv=7&tag=%E4%BA%8C%E5%89%B5', '#nodelane-pixiv=7&category=manga', '#nodelane-pixiv=7&series=9']) {
      await page.goto(origin + '/artworks/101' + binding); const first = page.locator('#first'); await first.evaluate(i => i.decode());
      const rect = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      assert.equal(await page.locator('#thumb').evaluate(i => i.style.content), ''); assert.equal(await page.locator('#lazy').evaluate(i => i.style.content), '');
      assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
      await page.screenshot({path: path.join(out, binding ? 'pixiv-bound-translated.png' : 'pixiv-translated.png')});
      await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
      assert.deepEqual(await first.boundingBox(), rect); await button('显示译图');
      await page.locator('#lazy').evaluate((i, url) => {i.src = url;}, cdn + 'lazy.png');
      await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
      await page.evaluate(() => history.pushState({}, '', '/users/7/artworks'));
      await page.waitForFunction(() => !document.querySelector('#first').style.content && !document.querySelector('#lazy').style.content);
    }
    check('Pixiv uses generic image recognition on native and bound artwork URLs; excludes thumbnails, handles lazy images, restores originals and clears on SPA navigation');
    return {liveSource: false};
  } finally {await browser.unroute(origin + '/**'); await browser.unroute(cdn + '**');}
}
