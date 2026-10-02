import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://mangaball.com', cdn = 'https://mangaball-inline.fixture.example';
  const titleId = '0123456789abcdef01234567', chapterId = '123456789abcdef012345678';
  const image = `${cdn}/storage/${titleId}/0/1.1/mangadex/en/001.webp`;
  const legacy = `${cdn}/storage/${titleId}/0/1.1/mangadex/en/${chapterId}-003.webp`;
  const replacement = `${cdn}/storage/${titleId}/changed-file.png`;
  let releaseReplacement;
  const replacementReady = new Promise(resolve => {releaseReplacement = resolve;});
  // Chromium worker fetches bypass Playwright page routing. Scope this stub to the synthetic CDN path.
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(({prefix, base64}) => {
    globalThis.fixtureMangaBallFetch = globalThis.fetch;
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(prefix)) {init?.signal?.throwIfAborted(); return new Response(bytes, {status: 200, headers: {'Content-Type': 'image/png'}});}
      return globalThis.fixtureMangaBallFetch(input, init);
    };
  }, {prefix: `${cdn}/storage/${titleId}/`, base64: source.toString('base64')});
  await browser.route(cdn + '/**', async route => {
    if (route.request().url() === replacement) await replacementReady;
    await route.fulfill({contentType: 'image/png', body: source});
  });
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>MangaBall inline fixture</title>
    <style>body{margin:0;background:#eaf0f8}main{width:760px;margin:160px auto}img{display:block;width:760px;height:100px}#ad{position:absolute;top:0}#lazy{height:500px}</style>
    <main><img id="ad" alt="Advertisement" src="${image}"><img id="first" alt="Fixture work Chapter 1.1 Page 1 - English" src="${image}">
    <img id="lazy" alt="Fixture work Chapter 1.1 Page 2 - English"><img id="legacy" alt="Fixture work Chapter 1.1 Page 3 - English" src="${legacy}"></main>`}));
  await page.goto(origin + '/chapter-detail/' + chapterId);
  const first = page.locator('#first'); await first.evaluate(img => img.decode()); const box = await first.boundingBox();
  await activate(); await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await page.waitForFunction(() => document.querySelector('#legacy').style.content.includes('blob:'));
  assert.equal(await page.locator('#ad').evaluate(img => img.style.content), '');
  assert.equal(await page.locator('#lazy').evaluate(img => img.style.content), '');
  assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'mangaball-translated.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
  assert.equal(await first.getAttribute('src'), image); assert.deepEqual(await first.boundingBox(), box);
  await button('显示译图'); await page.locator('#lazy').evaluate((img, url) => {img.src = url;}, image.replace('/001.webp', '/002.webp'));
  await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
  await first.evaluate((img, url) => {img.src = url;}, replacement);
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  releaseReplacement();
  await page.waitForFunction(() => document.querySelector('#first').complete && document.querySelector('#first').naturalWidth > 0 && document.querySelector('#first').style.content.includes('blob:'));
  assert.equal(await first.getAttribute('src'), replacement); assert.deepEqual(await first.boundingBox(), box);
  await first.evaluate(img => {img.alt = 'Cover';});
  await page.waitForFunction(() => !document.querySelector('#first').style.content);
  await first.evaluate(img => {img.alt = 'Fixture work Chapter 9 Page 40 - Spanish';});
  await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
  assert.equal(await first.getAttribute('src'), replacement); assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'mangaball-restored.png')});
  await page.goto(origin + '/title-detail/' + titleId); await activate();
  assert.equal(await first.evaluate(img => img.style.content), '');
  check('MangaBall: source DOM originals on another HTTPS CDN translate without filename or breadcrumb checks; ads, covers and unloaded images are excluded; changed filenames expire old targets, then loaded replacements and lazy images translate; original restoration retains geometry; catalog never falls back');
  await browser.unroute(origin + '/**'); await browser.unroute(cdn + '/**');
  await worker.evaluate(() => {globalThis.fetch = globalThis.fixtureMangaBallFetch; delete globalThis.fixtureMangaBallFetch;});
  return {liveSource: false};
}
