import assert from 'node:assert/strict';
import path from 'node:path';

/** Real MV3 pipeline, synthetic source EPUB images and translation service; no source account or provider. */
export async function verifyInline({browser, page, activate, button, source, out, check}) {
  const origin = 'https://koobone.com', png = source.toString('base64');
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const setup = `const bytes=Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0));
    const original=()=>URL.createObjectURL(new Blob([bytes],{type:'image/png'}));`;
  await browser.route(origin + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/web.htm') body = `<!doctype html><meta charset="utf-8"><title>KOOBONE inline fixture</title>
      <style>body{margin:0;background:#e8edf5;font:16px system-ui}nav{padding:12px}iframe{width:900px;height:600px;border:4px solid #334155}
      #view_page,#view_line{margin:70px 0 0 120px}#shelf{position:absolute;left:0;top:110px;width:100px;height:140px}#img_preload_1{display:none}</style>
      <nav><button id="spread">Double page</button><button id="line">Scroll reader</button><button id="single">Single page</button><button id="exit">Close reader</button></nav>
      <img id="shelf" src="data:image/png;base64,${png}"><img id="img_preload_1" src="data:image/png;base64,${png}">
      <div id="view_page"><iframe id="iframe_page" src="/wpage.htm?9"></iframe></div>
      <div id="view_line" style="display:none"><iframe id="iframe_line" src="/wline.htm?7"></iframe></div>
      <script>
      const paged=document.querySelector('#view_page'),linear=document.querySelector('#view_line');
      document.querySelector('#spread').onclick=()=>document.querySelector('#iframe_page').contentWindow.spread();
      document.querySelector('#line').onclick=()=>{paged.style.display='none';linear.style.display='block';};
      document.querySelector('#single').onclick=()=>{paged.style.display='block';linear.style.display='none';};
      document.querySelector('#exit').onclick=()=>{paged.style.display='none';linear.style.display='none';};
      </script>`;
    else if (pathname === '/wpage.htm') body = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#div_onepic,#div_twopic{display:flex;justify-content:center}img{height:540px}#div_twopic{display:none}</style>
      <button id="next">Next page</button><span id="position">1</span>
      <div id="div_onepic"><img id="img_full"></div><div id="div_twopic"><img id="img_left"><img id="img_right"></div>
      <script>${setup}
      let position=1;const full=document.querySelector('#img_full');
      for(const image of document.querySelectorAll('img'))image.src=original();
      full.decode().then(()=>{URL.revokeObjectURL(full.src);document.body.dataset.ready='yes';});
      document.querySelector('#next').onclick=()=>{full.src=original();full.style.cssText='height:540px';document.querySelector('#position').textContent=String(++position);};
      window.spread=()=>{document.querySelector('#div_onepic').style.display='none';document.querySelector('#div_twopic').style.display='flex';};
      </script>`;
    else if (pathname === '/wline.htm') body = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}img{height:600px;width:auto}#precont{display:none}</style>
      <div id="precont"><img id="epub_img_99"></div><div id="nowcont">${Array.from({length:16},(_,i)=>`<div id="div_zoom_${i+1}"><img id="epub_img_${i+1}"></div>`).join('')}</div>
      <script>${setup}for(const image of document.querySelectorAll('img'))image.src=original();</script>`;
    else body = '<!doctype html><title>Unrelated frame</title><p>Not a reader</p>';
    await route.fulfill({contentType: 'text/html', body});
  });
  await page.goto(origin + '/web.htm');
  const frame = () => page.frames().find(f => new URL(f.url()).pathname === '/wpage.htm');
  const linear = () => page.frames().find(f => new URL(f.url()).pathname === '/wline.htm');
  await frame().waitForFunction(() => document.body.dataset.ready === 'yes');
  const full = frame().locator('#img_full'), box = await full.boundingBox(), original = await full.getAttribute('src');
  await activate();
  await frame().waitForFunction(() => document.querySelector('#img_full').style.content.includes('blob:'), null, {timeout:20000});
  assert.deepEqual(await full.boundingBox(), box);
  assert.equal(await full.getAttribute('src'), original);
  assert.equal(await page.locator('#shelf').evaluate(i => i.style.content), '');
  assert.equal(await page.locator('#img_preload_1').evaluate(i => i.style.content), '');
  assert.equal(await linear().locator('img').evaluateAll(images => images.filter(i => i.style.content).length), 0);
  await page.screenshot({path:path.join(out,'koobone-translated.png')});
  await button('恢复原图');
  await frame().waitForFunction(() => !document.querySelector('#img_full').style.content);
  assert.deepEqual(await full.boundingBox(), box); assert.equal(await full.getAttribute('src'), original);
  await button('显示译图');
  await frame().waitForFunction(() => document.querySelector('#img_full').style.content.includes('blob:'));
  const translated = await full.evaluate(i => i.style.content);
  await frame().locator('#next').click();
  await frame().waitForFunction(previous => document.querySelector('#img_full').style.content.includes('blob:') &&
    document.querySelector('#img_full').style.content !== previous, translated);
  assert.equal(await frame().locator('#position').textContent(), '2'); assert.deepEqual(await full.boundingBox(), box);
  check('KOOBONE single page: revoked Blob originals translate, source attributes and geometry survive restoration, same-element turns replace stale results; covers and hidden preload readers remain untouched.');

  await page.locator('#spread').click();
  await frame().waitForFunction(() => ['img_left','img_right'].every(id => document.getElementById(id).style.content.includes('blob:')));
  assert.equal(await full.evaluate(i => i.style.content), '');
  await page.screenshot({path:path.join(out,'koobone-spread.png')});
  await page.locator('#line').click();
  await linear().waitForFunction(() => document.querySelector('#epub_img_1').style.content.includes('blob:'));
  assert.equal(await frame().locator('img').evaluateAll(images => images.filter(i => i.style.content).length), 0);
  assert.equal(await linear().locator('#epub_img_99').evaluate(i => i.style.content), '');
  assert.equal(await linear().locator('#epub_img_16').evaluate(i => i.style.content), '');
  await linear().evaluate(() => scrollTo(0, 1850));
  await linear().waitForFunction(() => document.querySelector('#epub_img_4').style.content.includes('blob:'));
  const scroll = await linear().evaluate(() => scrollY);
  await button('恢复原图');
  await linear().waitForFunction(() => !document.querySelector('#epub_img_4').style.content);
  assert.equal(await linear().evaluate(() => scrollY), scroll);
  await page.screenshot({path:path.join(out,'koobone-restored.png')});
  await button('显示译图');
  await linear().waitForFunction(() => document.querySelector('#epub_img_4').style.content.includes('blob:'));
  assert.equal(await linear().evaluate(() => scrollY), scroll);
  const oldFrame = frame();
  await page.locator('#single').click();
  await oldFrame.waitForFunction(() => document.querySelector('#img_left').style.content.includes('blob:'));
  await page.locator('#iframe_page').evaluate(f => {f.src='/wpage.htm?reload=1';});
  await page.waitForFunction(() => document.querySelector('#iframe_page').contentDocument?.body?.dataset.ready === 'yes');
  // Chromium reports subframe navigation as tab loading. The shared activation fence intentionally
  // ends authorization on loading, including same-URL reloads; explicit activation restores it.
  await page.waitForLoadState('load');
  await worker.evaluate(async url => {
    for (let attempt=0; attempt<100; attempt++) {
      const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
      if(tab?.status==='complete')return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Reader frame navigation did not finish');
  },page.url());
  await activate();
  await frame().waitForFunction(() => document.querySelector('#img_full').style.content.includes('blob:'));
  await page.locator('#iframe_page').evaluate(f => {f.src='/login.php';});
  await page.waitForFunction(() => document.querySelector('#iframe_page').contentDocument?.title === 'Unrelated frame');
  await page.locator('#exit').click();
  check('KOOBONE double pages and scrolling: cross-realm mutations and scrolls refresh the visible window, inactive readers restore, distant pages stay untouched, scroll survives toggling and explicit reactivation rebinds reloaded frames.');
  await button('关闭');
  await browser.unroute(origin + '/**');
  return {liveSource:false};
}
