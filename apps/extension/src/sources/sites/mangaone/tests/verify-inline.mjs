import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://manga-one.com';
  const translated = () => page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#eaf0f8}main{padding:120px 20px;display:flex;gap:12px}img{width:360px;height:495px}#ad{width:360px;height:495px;position:absolute;left:-2000px}</style>
    <img id="ad" alt="page_0"><main class="fixture_viewer_wrapper">
    <div data-testid="placeholder"><img id="first" class="fixture_page" alt="page_0"></div>
    <div data-testid="placeholder"><img id="duplicate" class="fixture_page" alt="page_1"></div>
    <div data-testid="placeholder"><img id="lazy" class="fixture_page" alt="page_2"></div></main>`}));
  try {
    await page.goto(origin + '/manga/659/chapter/11');
    await page.evaluate(base64 => {
      // The source viewer's decoded Blob can omit MIME; preserve the original bytes.
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      // Revoke one shared URL after both body slots decoded, like the real reader.
      const url = URL.createObjectURL(new Blob([bytes]));
      let loaded = 0;
      for (const id of ['first', 'duplicate', 'ad']) {
        const image = document.getElementById(id);
        image.onload = () => {if (++loaded === 3) URL.revokeObjectURL(url);}; image.src = url;
      }
    }, source.toString('base64'));
    await page.waitForFunction(() => ['first', 'duplicate', 'ad'].every(id => document.getElementById(id).complete));
    const first = page.locator('#first'); await first.evaluate(img => img.decode());
    const src = await first.getAttribute('src'), box = await first.boundingBox();
    assert(await first.evaluate(async img => {try {await fetch(img.src); return false;} catch {return true;}}), 'fixture Blob must already be revoked');
    await activate(); await translated();
    await page.waitForFunction(() => document.querySelector('#duplicate').style.content.includes('blob:'));
    assert.equal(await page.locator('#ad').evaluate(img => img.style.content), '');
    assert.equal(await page.locator('#lazy').evaluate(img => img.style.content), '');
    assert.equal(await first.getAttribute('src'), src);
    assert.deepEqual(await first.boundingBox(), box);
    await page.locator('#lazy').evaluate((img, base64) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
      img.onload = () => URL.revokeObjectURL(url); img.src = url;
    }, source.toString('base64'));
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await page.screenshot({path: path.join(out, 'mangaone-fixture-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.equal(await first.getAttribute('src'), src); assert.deepEqual(await first.boundingBox(), box);
    await button('显示译图'); await translated();
    // A recycled DOM element must not retain another logical page's translation.
    await first.evaluate(img => {img.className = 'fixture_cover';});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await first.evaluate(img => {img.className = 'fixture_page'; img.alt = '第0页';}); await translated();
    await first.evaluate(img => {img.src = URL.createObjectURL(new Blob(['invalid image']));});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert(await page.locator('#duplicate').evaluate(img => img.style.content.includes('blob:')));
    await first.evaluate((img, base64) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
      img.onload = () => URL.revokeObjectURL(url); img.src = url;
    }, source.toString('base64')); await translated();
    await page.evaluate(() => history.pushState({}, '', '/search'));
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await page.evaluate(() => history.pushState({}, '', '/manga/659/chapter/12'));
    await activate(); await translated();
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await page.screenshot({path: path.join(out, 'mangaone-fixture-restored.png')});
    check('Manga One: MIME-less Blob reading, duplicate slots, lazy images, body filtering, recycled elements, failed neighbour, SPA invalidation and exact geometry restoration');
  } finally {await browser.unroute(origin + '/**');}
  if (process.env.RUN_LIVE_MANGAONE !== '1') return {liveSource: false};

  const selector = '[class*="_viewer_wrapper"] [data-testid="placeholder"] > img[class*="_page"]';
  await page.goto(origin + '/manga/659/chapter/359725', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(img => img.complete && img.naturalWidth), selector, {timeout: 60000});
  const first = page.locator(selector).first();
  const pixels = async img => {
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), drawing = canvas.getContext('2d');
    drawing.drawImage(img, 0, 0); const bytes = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
    return {src: img.src, bytes: bytes.byteLength, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]};
  };
  const original = await first.evaluate(pixels);
  assert(original.src.startsWith('blob:' + origin + '/')); assert(original.bytes > 0);
  const box = await first.boundingBox();
  await activate(); await page.waitForFunction(selector => document.querySelector(selector).style.content.includes('blob:'), selector, {timeout: 60000});
  assert.deepEqual(await first.boundingBox(), box);
  await page.screenshot({path: path.join(out, 'mangaone-live-translated.png')});
  await button('恢复原图'); await page.waitForFunction(selector => !document.querySelector(selector).style.content, selector);
  assert.equal(await first.getAttribute('src'), original.src); assert.deepEqual(await first.boundingBox(), box);
  assert.deepEqual(await first.evaluate(pixels), original);
  // The real viewer accepts ArrowLeft for the next RTL spread.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(({selector, src}) => [...document.querySelectorAll(selector)].some(img => {
    const r = img.getBoundingClientRect(); return img.src !== src && img.complete && r.left >= 0 && r.right <= innerWidth && r.top < innerHeight && r.bottom > 0;
  }), {selector, src: original.src});
  await button('显示译图');
  await page.waitForFunction(({selector, src}) => [...document.querySelectorAll(selector)].some(img => {
    const r = img.getBoundingClientRect(); return img.src !== src && r.left >= 0 && r.right <= innerWidth && img.style.content.includes('blob:');
  }), {selector, src: original.src}, {timeout: 60000});
  await page.screenshot({path: path.join(out, 'mangaone-live-next-spread.png')});
  await button('恢复原图');
  check('Live Manga One: same-origin decoded Blob bytes, exact layout/original restoration and next spread; local mock translation only');
  return {liveSource: true};
}
