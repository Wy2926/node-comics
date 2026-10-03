import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://mangadna.com', cdn = 'https://cdn01.mangadna.com/uploads/7/1/';
  const imagesPattern = 'https://cdn01.mangadna.com/uploads/7/**';
  const reader = origin + '/manga/fixture/chapter-1', catalog = origin + '/manga/fixture';
  await browser.route(imagesPattern, route => route.fulfill({contentType: 'image/png', body: source}));
  await browser.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <link rel="canonical" href="${route.request().url()}"><title>MangaDNA fixture</title>
    <style>body{margin:0;background:#eaf0f8}.read-content{width:760px;margin:180px auto}img.loading{display:block;width:760px;height:100px}#lazy{height:500px}#ad{position:absolute;top:0}</style>
    <div class="post-title"><h1>Fixture - Chapter 1</h1></div><div class="c-breadcrumb"><ol class="breadcrumb"><li><a href="${catalog}">Fixture</a></li></ol></div>
    <select class="navi-change-chapter"><option data-c="chapter-1" selected>Chapter 1</option></select>
    <img id="ad" class="loading" alt="Fixture - Chapter 1 Page 1" src="${cdn}1-abc.jpg">
    <div class="read-content"><img id="first" class="loading" alt="Fixture - Chapter 1 Page 1" src="${cdn}1-abc.jpg" data-src="${cdn}1-abc.jpg">
    <img id="lazy" class="loading" alt="Fixture - Chapter 1 Page 2" data-src="${cdn}2-abc.jpg">
    <img id="foreign" class="loading" alt="Fixture - Chapter 1 Page 3" src="${cdn.replace('/7/1/', '/7/2/')}3-abc.jpg" data-src="${cdn.replace('/7/1/', '/7/2/')}3-abc.jpg"></div>`}));
  try {
    await page.goto(reader); const first = page.locator('#first'), lazy = page.locator('#lazy'); await first.evaluate(i => i.decode());
    await page.locator('#foreign').evaluate(i => i.decode());
    const box = await first.boundingBox(), original = await first.getAttribute('src'); await activate();
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    assert.equal(await page.locator('#ad').evaluate(i => i.style.content), '');
    assert.equal(await page.locator('#foreign').evaluate(i => i.style.content), '');
    assert.equal(await lazy.evaluate(i => i.style.content), '');
    assert.deepEqual(await first.boundingBox(), box); assert.equal(await first.getAttribute('src'), original);
    await page.locator('link[rel="canonical"]').evaluate(link => {link.href = link.href.replace('/chapter-1', '/chapter-2');});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await page.locator('link[rel="canonical"]').evaluate((link, url) => {link.href = url;}, reader);
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => {
      document.querySelector('h1').textContent = 'Fixture - Chapter 2';
      document.querySelector('#first').alt = 'Fixture - Chapter 2 Page 1';
    });
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await page.evaluate(() => {
      document.querySelector('h1').textContent = 'Fixture - Chapter 1';
      document.querySelector('#first').alt = 'Fixture - Chapter 1 Page 1';
    });
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.screenshot({path: path.join(out, 'mangadna-translated.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('#first').style.content);
    assert.deepEqual(await first.boundingBox(), box);
    await button('显示译图'); await lazy.evaluate(i => {i.src = i.dataset.src;});
    await page.waitForFunction(() => document.querySelector('#lazy').style.content.includes('blob:'));
    await first.evaluate(i => {i.src = 'data:image/png;base64,invalid';});
    await page.waitForFunction(() => !document.querySelector('#first').style.content);
    await first.evaluate((i, src) => {i.src = src;}, original);
    await page.waitForFunction(() => document.querySelector('#first').style.content.includes('blob:'));
    await page.evaluate(() => scrollTo(0, 100)); const scroll = await page.evaluate(() => scrollY);
    await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.screenshot({path: path.join(out, 'mangadna-restored.png')});
    await page.goto(catalog); await activate(); assert.equal(await first.evaluate(i => i.style.content), '');
    check('MangaDNA: source body short slices, identity mutations, lazy loading, replacement and original restore; ads excluded, src/geometry/scroll preserved, no catalog fallback. Source and translation API are synthetic.');
    return {liveSource: false};
  } finally {await browser.unroute(origin + '/**'); await browser.unroute(imagesPattern);}
}
