import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const cdn = 'https://webtoon-phinf.pstatic.net/fixture/';
  for (const host of ['www', 'm']) {
    const origin = `https://${host}.webtoons.com`, mobile = host === 'm';
    const catalog = origin + '/en/canvas/fixture/list?title_no=7';
    const reader = origin + '/en/canvas/fixture/episode-1/viewer?title_no=7&episode_no=1';
    const placeholder = 'https://webtoons-static.pstatic.net/image/bg_transparency.png';
    const fulfillImage = route => route.fulfill({contentType: 'image/png', body: source});
    await browser.route('https://webtoon-phinf.pstatic.net/fixture/**', fulfillImage);
    await browser.route(placeholder, fulfillImage);
    await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <style>body{margin:0;background:#eee}main{width:760px;margin:180px auto}img{display:block;width:760px;height:100px}</style>
      <img id="ad" src="${cdn}ad.png"><main>${mobile
        ? `<div id="_viewer"><div class="_imageWrap"><img id="first" class="_checkVisible" src="${cdn}first.png"></div>
          <div class="_imageWrap"><img id="lazy" class="_checkVisible" src="${placeholder}"></div>
          <img id="recommend" class="_checkVisible" src="${cdn}recommend.png"></div>`
        : `<div id="_imageList"><img id="first" class="_images" src="${cdn}first.png" data-url="${cdn}first.png">
          <img id="lazy" class="_images" data-url="${cdn}lazy.png"></div>`}</main>`}));
    try {
      await page.goto(reader); const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
      const rect = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      assert.equal(await page.locator('#ad').evaluate(i => i.style.content), ''); assert.equal(await lazy.evaluate(i => i.style.content), '');
      if (mobile) assert.equal(await page.locator('#recommend').evaluate(i => i.style.content), '');
      assert.deepEqual(await first.boundingBox(), rect); assert.equal(await first.getAttribute('src'), original);
      await page.screenshot({path: path.join(out, `webtoons-${host}-translated.png`)}); await button('恢复原图');
      await page.waitForFunction(() => !document.querySelector('#first').style.content); assert.deepEqual(await first.boundingBox(), rect);
      await page.screenshot({path: path.join(out, `webtoons-${host}-restored.png`)}); await button('显示译图');
      await lazy.evaluate((i, url) => {i.src = url;}, cdn + 'lazy.png');
      await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
      await first.evaluate(i => {i.src = 'data:image/png;base64,invalid';});
      await page.waitForFunction(() => !document.querySelector('#first').style.content);
      await first.evaluate((i, url) => {i.src = url;}, original);
      await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
      await page.goto(catalog); await activate(); assert.equal(await first.evaluate(i => i.style.content), '');
      check(`WEBTOON ${host}: slices translate/restore, placeholders and ads excluded, lazy and replaced images recover, catalog never falls back`);
    } finally {
      await browser.unroute(origin + '/**'); await browser.unroute('https://webtoon-phinf.pstatic.net/fixture/**');
      await browser.unroute(placeholder);
    }
  }
  return {liveSource: false};
}
