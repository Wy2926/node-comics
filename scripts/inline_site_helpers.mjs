// Shared browser assertions; every site owns its URLs, selectors and fixture markup.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInlineImages(context, fixture) {
  const {browser, page, activate, button, source, out, check} = context;
  const data = 'data:image/png;base64,' + source.toString('base64');
  await browser.route(fixture.route, route => route.fulfill({contentType: 'text/html', body:
    `<!doctype html><meta charset="utf-8"><title>${fixture.id} inline fixture</title>
    <style>body{margin:0;background:#eaf0f8}main{width:760px;margin:180px auto}img{display:block;width:760px;height:60px}#ad{position:absolute;top:0;left:0;width:760px;height:100px}.lazy{height:400px}</style>
    <img id="ad" src="${data}"><main>${fixture.markup(data)}</main>`}));
  await page.goto(fixture.url);
  const first = page.locator(fixture.first), lazy = page.locator(fixture.lazy);
  await first.evaluate(image => image.decode());
  const before = await first.boundingBox(), original = await first.getAttribute('src');
  await activate();
  await first.evaluate(image => {image.dataset.fixtureOriginal = image.getAttribute('src');});
  await page.waitForFunction(selector => document.querySelector(selector).style.content.includes('blob:'), fixture.first);
  assert.equal(await page.locator('#ad').evaluate(image => image.style.content), '');
  assert.equal(await lazy.evaluate(image => image.style.content), '');
  assert.deepEqual(await first.boundingBox(), before);
  assert.equal(await first.getAttribute('src'), original);
  await page.screenshot({path: path.join(out, fixture.id + '-translated.png')});
  await button('恢复原图');
  await page.waitForFunction(selector => !document.querySelector(selector).style.content, fixture.first);
  assert.equal(await first.getAttribute('src'), original);
  assert.deepEqual(await first.boundingBox(), before);
  await page.screenshot({path: path.join(out, fixture.id + '-restored.png')});
  await button('显示译图');
  await lazy.evaluate((image, data) => {image.src = data;}, data);
  await page.waitForFunction(selector => document.querySelector(selector).style.content.includes('blob:'), fixture.lazy);
  await first.evaluate(image => {image.src = 'data:image/png;base64,invalid';});
  await page.waitForFunction(selector => !document.querySelector(selector).style.content, fixture.first);
  await first.evaluate(image => {image.src = image.dataset.fixtureOriginal;});
  await page.waitForFunction(selector => document.querySelector(selector).style.content.includes('blob:'), fixture.first);
  await page.evaluate(() => scrollTo(0, 100));
  const scroll = await page.evaluate(() => scrollY);
  await button('恢复原图'); assert.equal(await page.evaluate(() => scrollY), scroll);
  await page.goto(fixture.catalogUrl);
  await activate();
  // The activation reply guarantees a scan; allow observer work before inspecting exclusions.
  await page.waitForTimeout(300);
  assert.equal(await page.locator(fixture.first).evaluate(image => image.style.content), '');
  assert.equal(await page.locator('#ad').evaluate(image => image.style.content), '');
  check(`${fixture.id}: short comic slices translate, ads/loading/error images stay excluded, lazy/replaced originals recover, restore keeps geometry/scroll, catalogs never fall back`);
  await browser.unroute(fixture.route);
  return {liveSource: false};
}
