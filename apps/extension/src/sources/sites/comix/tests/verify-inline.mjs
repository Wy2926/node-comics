// Called by scripts/verify_inline_translation.mjs with the isolated translation API.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function verifyInline({browser,page,activate,button,source,out,check}) {
  const live=process.env.RUN_LIVE_COMIX==='1';
  console.log('Comix inline: opening isolated reader fixture');
  const url='https://comix.to/title/inline-fixture/321-chapter-1';
  const image='data:image/png;base64,'+source.toString('base64');
  await browser.route('https://comix.to/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><title>Comix inline fixture</title>
    <style>body{margin:0;background:#151924;color:white}.rpage-view{width:760px;margin:200px auto 0}.rpage-page{position:relative}.rpage-page__img{display:block;width:760px}canvas{height:320px}#ordinary{height:60px}#ad{position:absolute;left:0;top:0;width:250px;height:420px}#lazy{height:240px}</style>
    <img id="ad" src="${image}"><canvas id="unrelated" width="760" height="400" style="position:absolute;left:-1000px"></canvas>
    <main class="rpage-main"><div class="rpage-view">
    <div class="rpage-page" data-page="1"><img id="ordinary" class="rpage-page__img" width="760" height="60" src="${image}"></div>
    <div class="rpage-page" data-page="2"><canvas id="decoded" class="rpage-page__img" width="760" height="320"></canvas></div>
    <div class="rpage-page is-loading" data-page="3"><canvas id="lazy" class="rpage-page__img" width="760" height="240"></canvas></div>
    <div class="rpage-page is-errored" data-page="4"><canvas id="failed" class="rpage-page__img" width="760" height="200"></canvas></div>
    </div></main><script>for(const [n,c] of [...document.querySelectorAll('canvas')].entries()){const x=c.getContext('2d');x.fillStyle=['#446688','#ffdcad','#cde6ff','#ffcccc'][n];x.fillRect(0,0,c.width,c.height);x.fillStyle='#20304b';x.font='32px sans-serif';x.fillText('Comix decoded page '+n,40,100);}document.querySelector('#decoded').onclick=()=>document.body.dataset.clicked='yes';</script>`}));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});
  await page.waitForFunction(()=>document.querySelector('#ordinary')?.naturalWidth>0,null,{timeout:10000});
  const original=await page.locator('#decoded').evaluate(canvas=>canvas.toDataURL());
  const geometry=await page.locator('.rpage-view').boundingBox();
  console.log('Comix inline: activating fixture translation');
  await activate();
  await page.waitForFunction(()=>document.querySelector('#ordinary').style.content.includes('blob:')&&document.querySelector('#decoded').nextElementSibling?.hasAttribute('data-nc-canvas-translation'),null,{timeout:20000});
  assert.equal(await page.locator('#ad').evaluate(image=>image.style.content),'');
  assert.equal(await page.locator('#lazy').evaluate(canvas=>!!canvas.nextElementSibling?.hasAttribute('data-nc-canvas-translation')),false);
  assert.equal(await page.locator('#failed').evaluate(canvas=>!!canvas.nextElementSibling?.hasAttribute('data-nc-canvas-translation')),false);
  assert.deepEqual(await page.locator('.rpage-view').boundingBox(),geometry);
  await page.locator('#decoded').click();assert.equal(await page.locator('body').getAttribute('data-clicked'),'yes');
  await page.screenshot({path:path.join(out,'comix-translated.png')});
  check('Comix adapter translates ordinary short slices and decoded canvases; excludes ads, loading and failed slots; preserves geometry and clicks');
  await button('恢复原图');
  await page.waitForFunction(()=>document.querySelector('#ordinary').style.content===''&&!document.querySelector('#decoded').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  assert.equal(await page.locator('#decoded').evaluate(canvas=>canvas.toDataURL()),original);
  await page.screenshot({path:path.join(out,'comix-restored.png')});
  await button('显示译图');
  await page.waitForFunction(()=>document.querySelector('#decoded').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  await page.locator('#lazy').evaluate(canvas=>canvas.parentElement.classList.remove('is-loading'));
  await page.waitForFunction(()=>document.querySelector('#lazy').nextElementSibling?.hasAttribute('data-nc-canvas-translation'),null,{timeout:20000});
  const old=await page.locator('#decoded').evaluate(canvas=>canvas.nextElementSibling.src);
  await page.locator('#decoded').evaluate(canvas=>{canvas.parentElement.classList.add('is-loading');const ctx=canvas.getContext('2d');ctx.fillStyle='#daf8dc';ctx.fillRect(0,0,760,320);canvas.parentElement.classList.remove('is-loading');});
  await page.waitForFunction(old=>{const result=document.querySelector('#decoded').nextElementSibling;return result?.hasAttribute('data-nc-canvas-translation')&&result.src!==old;},old,{timeout:20000});
  check('Comix restores original pixels, discovers lazy completions and replaces stale translations after same-element canvas redraws');
  const beforeRebind=await page.locator('#decoded').evaluate(canvas=>canvas.nextElementSibling.src);
  await page.locator('#decoded').evaluate(canvas=>{
    const slot=canvas.parentElement,originalPage=slot.dataset.page;
    slot.dataset.page='5';
    const ctx=canvas.getContext('2d');ctx.fillStyle='#e5d7ff';ctx.fillRect(0,0,canvas.width,canvas.height);
    slot.dataset.page=originalPage;
  });
  await page.waitForFunction(old=>{const result=document.querySelector('#decoded').nextElementSibling;return result?.hasAttribute('data-nc-canvas-translation')&&result.src!==old;},beforeRebind,{timeout:20000});
  check('Comix invalidates a canvas rebound between scans even when its page number returns to the original value');
  await page.locator('.rpage-view').evaluate(view=>{view.style.cssText='width:760px;margin:200px auto 0';view.className='rpage-strip';});
  await button('恢复原图');await button('显示译图');
  await page.waitForFunction(()=>document.querySelector('#ordinary').style.content.includes('blob:')&&document.querySelector('#decoded').nextElementSibling?.hasAttribute('data-nc-canvas-translation'));
  check('Comix paginated and vertical strip layouts share adapter selection without requiring a paginated wrapper');
  await page.evaluate(()=>history.pushState({},'','/title/inline-fixture/322-chapter-2'));
  await page.waitForFunction(()=>!document.querySelector('[data-nc-canvas-translation]')&&!document.querySelector('#ordinary').style.content);
  await activate();await page.waitForFunction(()=>document.querySelector('#ordinary').style.content.includes('blob:'),null,{timeout:20000});
  check('Comix chapter navigation clears old translations and allows another manual activation');
  await browser.unroute('https://comix.to/**');
  if(live) {
    const liveUrl=process.env.COMIX_INLINE_URL||'https://comix.to/title/nr83-the-sword-bearing-flower/6887743-chapter-2';
    console.log('Comix inline: checking live chapter '+new URL(liveUrl).pathname);
    await page.goto(liveUrl,{waitUntil:'domcontentloaded'});
    await page.locator('.rpage-main .rpage-page:not(.is-loading):not(.is-errored) > img.rpage-page__img').first().waitFor({timeout:45000});
    await activate();
    await page.waitForFunction(()=>[...document.querySelectorAll('img.rpage-page__img')].some(image=>image.style.content.includes('blob:')),null,{timeout:25000});
    await page.screenshot({path:path.join(out,'comix-live-image.png')});
    const slot=page.locator('.rpage-page[data-page="10"]');await slot.scrollIntoViewIfNeeded();
    await slot.locator('canvas.rpage-page__img').waitFor({timeout:45000});
    await slot.locator('[data-nc-canvas-translation]').waitFor({timeout:30000});
    await page.screenshot({path:path.join(out,'comix-live-canvas.png')});
    await button('恢复原图');await page.waitForFunction(()=>!document.querySelector('[data-nc-canvas-translation]'));
    check('Live Comix image and scrambled-canvas source pages display local fixture translations and restore originals; no live provider used');
  }
  return {liveSource:live};
}
