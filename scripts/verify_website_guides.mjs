import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4331';
const out=path.resolve('artifacts/website-guides');
const locales=['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id','ar'];
const screenshotLocales=['zh-CN','en','ja','ko'];
const slugs=['manga-translation','local-comics','translation-modes','remote-library','local-translation','find-manga'];
const prefix=locale=>locale==='zh-CN'?'':locale.toLowerCase()+'/';
const imageLocale=locale=>locale.startsWith('zh')?'zh-CN':['ja','ko'].includes(locale)?locale:'en';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const checkedImages=new Set(), errors=[], results=[];
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
async function context(locale,options={}){
  const value=await browser.newContext({locale,viewport:{width:1440,height:1000},...options});
  await value.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort());
  value.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  return value;
}
async function noOverflow(page){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow: ${page.url()}`);}
async function loaded(locator){
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(image=>image.decode());
  assert(await locator.evaluate(image=>image.naturalWidth>0));
}
try {
  for(const locale of locales){
    const ctx=await context(locale), page=await ctx.newPage();
    await page.goto(`${origin}/${prefix(locale)}guides/`);
    assert.equal(await page.locator('.workflow-card').count(),6);
    await noOverflow(page);
    if(locale==='zh-CN'){
      for(const img of await page.locator('.workflow-image img').all())await loaded(img);
      await page.keyboard.press('Control+Home');
      await page.waitForFunction(()=>scrollY===0);
      await page.locator('h1').click();
      await page.screenshot({path:path.join(out,'directory-desktop.png'),fullPage:true});
    }
    await page.setViewportSize({width:320,height:740});
    await noOverflow(page);
    for(const slug of slugs){
      await page.setViewportSize({width:1440,height:1000});
      await page.goto(`${origin}/${prefix(locale)}guides/${slug}/`);
      assert.equal(await page.locator('html').getAttribute('lang'),locale);
      await noOverflow(page);
      const links=await page.locator('.desktop-screenshot > a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));
      assert(links.length>0,`${slug}: missing illustration`);
      for(const href of links){
        const key=locale+href;
        if(checkedImages.has(key))continue;
        const filename=path.posix.basename(href).split('.')[0]+'.webp';
        const response=await ctx.request.get(origin+href);
        assert.equal(response.status(),200);
        const source=await readFile(path.resolve('backend/website/src/assets/guides',imageLocale(locale),filename));
        assert.equal(hash(await response.body()),hash(source),`${locale}/${slug}: wrong language image`);
        checkedImages.add(key);
      }
      await page.setViewportSize({width:320,height:740});
      await noOverflow(page);
      if(slug==='find-manga'&&screenshotLocales.includes(locale)){
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('.guide-contents a[href="#section-1"]').click();
        await page.waitForURL('**/#section-1');
        await loaded(page.locator('.desktop-screenshot img').first());
        await page.waitForFunction(()=>document.querySelector('#section-1').getBoundingClientRect().top<300);
        await page.screenshot({path:path.join(out,`${locale}-desktop.png`)});
        const popupPromise=page.waitForEvent('popup');
        await page.locator('.desktop-screenshot > a').first().click();
        const popup=await popupPromise;
        await popup.waitForLoadState();
        assert.equal(new URL(popup.url()).pathname,links[0]);
        await popup.close();
        await page.setViewportSize({width:390,height:844});
        await loaded(page.locator('.desktop-screenshot img').first());
        await noOverflow(page);
        await page.screenshot({path:path.join(out,`${locale}-mobile.png`)});
      }
      results.push(`${locale}/${slug}`);
    }
    await ctx.close();
    console.log(`Verified ${locale}: directory and ${slugs.length} illustrated guides, desktop / 320px, original-image language mapping.`);
  }
  const plain=await context('en',{javaScriptEnabled:false}), page=await plain.newPage();
  await page.goto(origin+'/en/guides/local-comics/');
  await page.locator('.guide-contents a[href="#section-2"]').click();
  await page.waitForURL('**/#section-2');
  assert(await page.locator('.guide-prose').innerText());
  assert(await page.locator('.desktop-screenshot img').nth(1).getAttribute('srcset'));
  await plain.close();
  const failed=await context('en'), fallback=await failed.newPage();
  await failed.route('**/*.webp',route=>route.abort());
  await fallback.goto(origin+'/en/guides/find-manga/');
  assert(await fallback.locator('.guide-prose p').count()>3);
  assert(await fallback.locator('.desktop-screenshot img').evaluateAll(nodes=>nodes.every(node=>node.alt)));
  await fallback.locator('.guide-contents a[href="#section-3"]').click();
  await fallback.waitForURL('**/#section-3');
  await noOverflow(fallback);
  await failed.close();
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'verification.json'),JSON.stringify({origin,pages:results,checkedImages:checkedImages.size,noJavaScript:true,imageFailureFallback:true,pageErrors:errors},null,2));
  console.log(`Passed ${results.length} illustrated pages, 17 directories, four-language desktop/mobile screenshots, full-size links, no-JS and image-failure checks.`);
}finally{await browser.close();}
