import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://mangadot.net', image = origin + '/chapters/manga_7/ch1/1.png';
  await browser.route(origin + '/**', route => route.request().url().endsWith('.png')
    ? route.fulfill({contentType: 'image/png', body: source})
    : route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>MangaDot inline fixture</title>
      <style>body{margin:0;background:#eaf0f8}#root{width:760px;margin:160px auto}img{display:block;width:760px;height:100px}#ad{position:absolute;top:0}#lazy{height:500px}</style>
      <div id="root"><img id="ad" alt="Advertisement" src="${image}"><img id="first" alt="Page 1" src="${image}"><img id="lazy" alt="Page 2"></div>`}));
  await page.goto(origin + '/chapter/1');
  const first = page.locator('#first'); await first.evaluate(img => img.decode()); const box = await first.boundingBox();
  await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  assert.equal(await page.locator('#ad').evaluate(img => img.style.content), '');
  assert.equal(await page.locator('#lazy').evaluate(img => img.style.content), '');
  assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'mangadot-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
  assert.equal(await first.getAttribute('src'), image); assert.deepEqual(await first.boundingBox(), box);
  await button('显示译图'); await page.locator('#lazy').evaluate((img, url) => {img.src = url;}, origin + '/chapters/manga_7/ch1/2.png');
  await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
  await first.evaluate(img => {img.src = 'data:image/png;base64,invalid';});
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  await first.evaluate((img, url) => {img.src = url;}, image);
  await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await button('恢复原图'); await page.screenshot({path: path.join(out, 'mangadot-restored.png')});
  await page.goto(origin + '/manga/7'); await activate();
  assert.equal(await first.evaluate(img => img.style.content), '');
  check('MangaDot: loaded page images translate; ads and loading/error images are excluded; lazy images and original restoration retain geometry; catalog never falls back');
  await browser.unroute(origin + '/**'); return {liveSource: false};
}
