import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://www.sunday-webry.com', cdn = 'https://cdn-img.www.sunday-webry.com';
  const imageUrl = cdn + '/public/page/2/900-abcdef';
  const data = episode => ({readableProduct: {id: episode, typeName: 'episode', title: '第1話', permalink: origin + '/episode/' + episode,
    series: {id: '7', title: 'Inline fixture'}, pageStructure: {choJuGiga: 'baku', readingDirection: 'rtl', startPosition: 'latter',
      pages: [0, 1].map(() => ({type: 'main', width: 800, height: 1100, src: imageUrl}))}}});
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const requests = [];
  // Keep the source original only in the temporary fixture. No live model or artwork is used.
  const encoded = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const w = Math.floor(bitmap.width / 32) * 8, h = Math.floor(bitmap.height / 32) * 8;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ctx.drawImage(bitmap, x * w, y * h, w, h, y * w, x * h, w, h);
    bitmap.close(); return canvas.toDataURL().split(',')[1];
  }, source.toString('base64'));
  await browser.route(cdn + '/**', route => {requests.push(route.request().url()); return route.fulfill({contentType: 'image/png', body: Buffer.from(encoded, 'base64')});});
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#eaf0f8}.js-viewer-content{width:760px;margin:160px auto}p{margin:0}canvas{display:block;width:760px;height:260px}#ad{position:absolute;top:0}#second{height:400px}</style>
    <script id="episode-json" type="text/json" data-value="${escape(JSON.stringify(data('11')))}"></script>
    <canvas id="ad" width="800" height="1100"></canvas><div class="js-viewer"><div class="js-viewer-content">
    <p class="js-page-area"><canvas id="first" class="js-page-image" width="800" height="1100"></canvas></p>
    <p class="js-page-area"><canvas id="second" class="js-page-image" width="0" height="0"></canvas></p></div></div>`}));
  await page.goto(origin + '/episode/11');
  // Taint the canvas exactly as the live reader does; HTTP originals must still translate.
  await page.evaluate(async url => {const image = new Image(); image.src = url; await image.decode();
    document.querySelector('#first').getContext('2d').drawImage(image, 0, 0);}, imageUrl);
  assert.equal(await page.locator('#first').evaluate(canvas => {try {canvas.toDataURL(); return false;} catch {return true;}}), true);
  requests.length = 0;
  const first = page.locator('#first'), box = await first.boundingBox();
  await activate(); await page.waitForFunction(() => document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'), {}, {timeout: 30000});
  assert(requests.length > 0); assert.equal(await page.locator('#ad').evaluate(canvas => canvas.nextElementSibling?.hasAttribute('data-nc-canvas-translation') ?? false), false);
  assert.equal(await page.locator('#second').evaluate(canvas => canvas.nextElementSibling?.hasAttribute('data-nc-canvas-translation') ?? false), false); assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'webry-inline-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  assert.deepEqual(await first.boundingBox(), box); await button('显示译图');
  await page.locator('#second').evaluate(canvas => {canvas.width = 800; canvas.height = 1100;});
  await page.waitForFunction(() => document.querySelector('#second').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  await first.evaluate(canvas => {canvas.width = 0;});
  await page.waitForFunction(() => !document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  await first.evaluate(canvas => {canvas.width = 800;});
  await page.waitForFunction(() => document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  await button('恢复原图'); await page.screenshot({path: path.join(out, 'webry-inline-restored.png')});
  await page.evaluate(value => {history.pushState({}, '', '/episode/12'); document.querySelector('#episode-json').setAttribute('data-value', JSON.stringify(value));}, data('12'));
  await activate(); await page.waitForFunction(() => document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  await page.locator('#episode-json').evaluate(script => {script.setAttribute('data-value', '{}');});
  await page.waitForFunction(() => !document.querySelector('#first').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  check('Sunday Webry: tainted canvases use decoded HTTP originals; ads/loading excluded; lazy pages, redraw invalidation, restoration and SPA navigation retain geometry');
  await browser.unroute(origin + '/**'); await browser.unroute(cdn + '/**');
  if (process.env.RUN_LIVE_WEBRY === '1') {
    // The source is live; translation requests remain on the isolated local fixture server.
    await page.goto(origin + '/episode/12207421984241764591', {waitUntil: 'domcontentloaded'});
    const selector = '.js-viewer .js-viewer-content > p.js-page-area canvas.js-page-image';
    await page.locator(selector).first().waitFor({timeout: 60000});
    const canvas = page.locator(selector).first(), before = await canvas.boundingBox();
    await activate(); await page.locator('[data-nc-canvas-translation]').first().waitFor({timeout: 30000});
    assert.deepEqual(await canvas.boundingBox(), before);
    await page.screenshot({path: path.join(out, 'webry-live-translated.png')});
    await button('恢复原图'); await page.locator('[data-nc-canvas-translation]').first().waitFor({state: 'detached'});
    await page.screenshot({path: path.join(out, 'webry-live-restored.png')});
    await page.locator('.js-readable-products-pagination').scrollIntoViewIfNeeded();
    await page.locator('.js-readable-products-pagination a[href$="/12207421984289271969"]').click();
    await page.waitForURL('**/episode/12207421984289271969');
    await page.waitForFunction(() => JSON.parse(document.querySelector('#episode-json')?.getAttribute('data-value') ?? '{}').readableProduct?.id === '12207421984289271969');
    await page.locator(selector).first().waitFor(); await page.locator(selector).first().scrollIntoViewIfNeeded();
    await activate(); await page.locator('[data-nc-canvas-translation]').first().waitFor({timeout: 30000});
    await button('恢复原图'); await page.locator('[data-nc-canvas-translation]').first().waitFor({state: 'detached'});
    check('Live Sunday Webry: decoded HTTP originals translate against a local fixture, restore, and survive actual SPA chapter navigation');
    return {liveSource: true};
  }
  return {liveSource: false};
}
