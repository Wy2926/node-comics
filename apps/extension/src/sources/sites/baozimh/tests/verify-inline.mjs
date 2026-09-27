import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://cn.twbzmg.com', image = 'https://s1.bzcdn.net/scomic/example-author/0/0-abcd/1.jpg';
  await browser.route('https://s1.bzcdn.net/**', route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Bao inline fixture</title>
    <style>body{margin:0;background:#fff8e8}.comic-contain{width:760px;margin:160px auto;padding:0}amp-img{display:block}img{display:block;width:760px;height:100px}#ad{position:absolute;top:0}#lazy{height:500px}</style>
    <img id="ad" src="${image}"><ul class="comic-contain"><amp-img class="comic-contain__item"><img id="first" amp-img-id="chapter-img-0-0" src="${image}"></amp-img>
    <amp-img class="comic-contain__item"><img id="lazy" amp-img-id="chapter-img-0-1"></amp-img></ul>`}));
  await page.goto(origin + '/comic/chapter/example-author/0_0.html');
  const first = page.locator('#first'); await first.evaluate(img => img.decode()); const box = await first.boundingBox();
  await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  assert.equal(await page.locator('#ad').evaluate(img => img.style.content), '');
  assert.equal(await page.locator('#lazy').evaluate(img => img.style.content), ''); assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'baozimh-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
  assert.equal(await first.getAttribute('src'), image); assert.deepEqual(await first.boundingBox(), box);
  await button('显示译图'); await page.locator('#lazy').evaluate((img, url) => {img.src = url;}, image.replace('/1.jpg', '/2.jpg'));
  await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
  await first.evaluate(img => {img.src = 'data:image/png;base64,invalid';});
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  await first.evaluate((img, url) => {img.src = url;}, image);
  await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await button('恢复原图'); await page.screenshot({path: path.join(out, 'baozimh-restored.png')});
  await page.evaluate(() => history.pushState({}, '', '/comic/chapter/example-author/0_1.html'));
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  check('Baozi: AMP originals translate and restore without layout movement; ads/unloaded/failed targets excluded; lazy loading and navigation invalidate old targets');
  await browser.unroute(origin + '/**'); await browser.unroute('https://s1.bzcdn.net/**');
  if (process.env.RUN_LIVE_BAOZIMH === '1') {
    await page.goto(origin + '/comic/chapter/zangsongzhefulilian-shantianzhongrenabetukasa/0_0.html', {waitUntil: 'domcontentloaded'});
    const target = page.locator('.comic-contain amp-img.comic-contain__item > img[amp-img-id]').first();
    await page.waitForFunction(() => document.querySelector('.comic-contain img[amp-img-id]')?.naturalWidth > 0, null, {timeout: 60000});
    await target.evaluate(img => img.decode()); const before = await target.boundingBox();
    await activate(); await page.waitForFunction(() => document.querySelector('.comic-contain img[amp-img-id]')?.style.content.includes('blob:'), null, {timeout: 60000});
    assert.deepEqual(await target.boundingBox(), before);
    await page.screenshot({path: path.join(out, 'baozimh-live-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('.comic-contain img[amp-img-id]').style.content);
    check('Baozi live AMP source image fetched and translated by synthetic service; original restored');
  }
  return {liveSource: process.env.RUN_LIVE_BAOZIMH === '1'};
}
