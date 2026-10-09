import assert from 'node:assert/strict';
import path from 'node:path';

// Runs inside the repository's isolated MV3/mock-service harness. No real translation provider.
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://comic-walker.com', work = 'KC_000001_S', episode = 'KC_0000010000100011_E';
  const selector = '.splide__list [data-type="contents"] > canvas[data-responsive="true"], .splide__list canvas[data-type="contents"][data-responsive="true"]';
  // Client-side entry keeps homepage SSR data, which has no work/chapter identity.
  const metadata = {props: {pageProps: {dehydratedState: {queries: []}}}};
  const fixtureUrl = `${origin}/detail/${work}/episodes/${episode}`;
  await browser.route(fixtureUrl, route => route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <title>ComicWalker fixture</title><style>body{margin:0;background:#f6f2e9}.track{height:900px;overflow:hidden;position:relative}.splide__list{display:flex;flex-direction:row-reverse;position:absolute;right:0;top:10px;width:10240px} [data-type=contents]{width:1280px;flex:none;display:grid;place-items:center}canvas{width:640px;height:880px;display:block}button{position:fixed;top:8px;left:8px;z-index:4}</style>
    <link rel="canonical" href="${fixtureUrl}"><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(metadata)}</script>
    <button onclick="window.pageIndex=(window.pageIndex||0)+1;document.querySelector('.splide__list').style.transform='translateX('+window.pageIndex*1280+'px)'">Next</button>
    <div class="track"><div class="splide__list">${Array.from({length: 8}, (_, i) => `<div data-type="contents"><canvas id="p${i}" data-responsive="true" width="800" height="1100"></canvas></div>`).join('')}</div></div>
    <script>const img=new Image();img.src='data:image/png;base64,${source.toString('base64')}';img.onload=()=>{document.querySelectorAll('canvas').forEach((canvas,i)=>{const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);ctx.fillStyle='#123456';ctx.font='50px sans-serif';ctx.fillText('Page '+i,100,600);});window.fixtureReady=true;};</script>`}));
  try {
    await page.goto(fixtureUrl); await page.waitForFunction(() => window.fixtureReady);
    const before = await page.locator('#p0').boundingBox(); await activate();
    await page.waitForFunction(() => document.querySelector('#p0 + [data-nc-canvas-translation]'), {}, {timeout: 30000});
    await page.waitForFunction(() => document.querySelector('#p1 + [data-nc-canvas-translation]'), {}, {timeout: 30000});
    assert(await page.locator('#p1').evaluate(c => c.getBoundingClientRect().right <= 0));
    assert(await page.locator('[data-nc-canvas-translation]').count() <= 5, 'lookahead must not walk through the chapter');
    assert.deepEqual(await page.locator('#p0').boundingBox(), before);
    await page.screenshot({path: path.join(out, 'comicwalker-prefetch.png')});
    await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
    assert.deepEqual(await page.locator('#p0').boundingBox(), before);
    await button('显示译图'); await page.waitForFunction(() => document.querySelector('#p0 + [data-nc-canvas-translation]'));
    await page.getByRole('button', {name: 'Next', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#p1 + [data-nc-canvas-translation]'), {}, {timeout: 30000});
    await page.screenshot({path: path.join(out, 'comicwalker-next-translated.png')});
    await page.locator('#p1').evaluate(canvas => {const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);});
    await page.waitForFunction(() => !document.querySelector('#p1 + [data-nc-canvas-translation]'));
    await page.locator('link[rel="canonical"]').evaluate(link => {link.href = 'https://comic-walker.com/';});
    await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
    check('ComicWalker: stale homepage metadata does not block offscreen lookahead; restore, next-page display, blank redraw and live canonical invalidation preserve geometry');
  } finally {await browser.unroute(fixtureUrl);}
  if (process.env.RUN_LIVE_COMICWALKER !== '1') return {liveSource: false};

  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  const close = page.getByRole('button', {name: '閉じる', exact: true});
  await close.waitFor({state: 'visible', timeout: 10000}).catch(error => {if (error.name !== 'TimeoutError') throw error;});
  if (await close.isVisible()) await close.click();
  const homeEpisode = '/detail/KC_021314_S/episodes/KC_0213140000300011_E?episodeType=latest';
  await page.locator(`a[href="${homeEpisode}"]`).click();
  await page.waitForURL(origin + homeEpisode);
  await page.locator(selector).first().waitFor({timeout: 60000});
  assert.equal(await page.locator('#__NEXT_DATA__').evaluate(s => JSON.parse(s.textContent).props.pageProps.workCode), undefined);
  await page.locator(selector).first().scrollIntoViewIfNeeded(); await activate();
  await page.waitForFunction(() => document.querySelector('[data-nc-canvas-translation]'), {}, {timeout: 45000});
  assert(await page.locator('[data-nc-canvas-translation]').count() <= 5);
  await page.screenshot({path: path.join(out, 'comicwalker-live-homepage-entry.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  check('ComicWalker live: clicking a homepage episode without reloading recognizes and translates canvases despite the unchanged homepage SSR data');

  const live = origin + '/detail/KC_008597_S/episodes/KC_0085970000200011_E';
  await page.goto(live, {waitUntil: 'domcontentloaded'});
  await page.locator(selector).first().waitFor({timeout: 60000});
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  const box = await page.locator(selector).first().boundingBox();
  assert.equal(await page.locator(selector).count(), 56);
  await activate();
  await page.waitForFunction(() => document.querySelector('[data-nc-canvas-translation]'), {}, {timeout: 45000});
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some((canvas, index) => {
    const rect = canvas.getBoundingClientRect();
    return index > 0 && rect.right <= 0 && canvas.nextElementSibling?.hasAttribute('data-nc-canvas-translation');
  }), selector, {timeout: 45000});
  assert(await page.locator('[data-nc-canvas-translation]').count() <= 5);
  assert.deepEqual(await page.locator(selector).first().boundingBox(), box);
  await page.screenshot({path: path.join(out, 'comicwalker-live-prefetch.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  assert.deepEqual(await page.locator(selector).first().boundingBox(), box);
  check('ComicWalker live: public 56-page reader pre-reads offscreen next canvas without turning, uses mock translations and restores original geometry');
  await button('显示译图');
  await page.getByRole('slider').press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') === '2');
  const visibleTranslated = () => page.waitForFunction(selector => {
    const canvases = [...document.querySelectorAll(selector)].filter(c => {const r = c.getBoundingClientRect();
      return r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0;});
    return canvases.length > 0 && canvases.every(c => c.nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  }, selector, {timeout: 45000});
  await visibleTranslated(); await page.screenshot({path: path.join(out, 'comicwalker-live-next-spread.png')});
  await page.getByRole('button', {name: /タテ読み|縦読み/}).click(); await visibleTranslated();
  await page.screenshot({path: path.join(out, 'comicwalker-live-vertical.png')});
  check('ComicWalker live: next spread and vertical-mode remount display translations');
  await page.getByRole('link', {name: /2026\/04\/10.*第2話-1/}).click();
  await page.waitForURL('**/episodes/KC_0085970000300011_E**');
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 38, selector);
  await page.locator(selector).first().scrollIntoViewIfNeeded(); await activate(); await visibleTranslated();
  await page.screenshot({path: path.join(out, 'comicwalker-live-spa-chapter.png')});
  await button('恢复原图'); await page.waitForFunction(() => !document.querySelector('[data-nc-canvas-translation]'));
  check('ComicWalker live: same-work SPA navigation binds the new 38-page episode despite stale initial Next.js data');
  return {liveSource: true};
}
