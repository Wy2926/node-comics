import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const catalog=JSON.parse(await readFile('backend/extension-release.json','utf8'));
const releases=catalog.releases.filter(item=>item.version===catalog.current);
assert.deepEqual(releases.map(item=>item.browser).sort(),['chrome','edge','firefox']);
const output='artifacts/extension-download';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 for(const locale of ['','en/','zh-tw/','ja/','ko/']){
  await page.goto(origin+'/'+locale+'download/');
  for(const release of releases){
   const card=page.locator(`[data-browser="${release.browser}"]`),link=card.locator('.package-download');
   assert.equal(new URL(await link.getAttribute('href'),origin).href,new URL(release.path,'https://comics.nodelane.net').href);
   assert.equal(await link.getAttribute('download'),release.filename);
   assert.ok((await card.innerText()).includes('v'+release.version));
   const storeBox=await card.locator('.store-link').boundingBox(),downloadBox=await link.boundingBox();
   assert(downloadBox.y>=storeBox.y+storeBox.height,'Package download must appear below its own store button');
  }
  assert.equal(await page.locator('[data-browser="firefox"] .store-link').getAttribute('href'),'https://addons.mozilla.org/firefox/addon/nodelane-comics/');
  assert.equal(await page.locator('[data-browser="firefox"] .package-download').count(),1);
  assert.equal(await page.locator('.package-download').count(),3);
  assert.equal(await page.locator('.direct-download').count(),0);
  assert.equal(await page.locator('.install-steps li').count(),3);
  const logos=page.locator('.store-card img.store-icon');
  assert.equal(await logos.count(),3);
  for(const logo of await logos.all()){
   await logo.scrollIntoViewIfNeeded();
   await logo.evaluate(async image=>{await image.decode();if(!image.naturalWidth)throw Error('Browser logo failed');});
  }
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:output+'/'+(origin.includes('127.0.0.1')?'local':'live')+'-'+(locale.replace('/','')||'zh-CN')+'.png',fullPage:true});
 }
 if(!origin.includes('127.0.0.1')){
  await page.goto(origin+'/download/');
  for(const release of releases){
   const promise=page.waitForEvent('download');await page.locator(`[data-browser="${release.browser}"] .package-download`).click();
   const download=await promise;assert.equal(download.suggestedFilename(),release.filename);
   const path=output+'/'+release.filename;await download.saveAs(path);
   const bytes=await readFile(path);
   assert.equal(bytes.length,release.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.sha256);
   console.log(`PASS ${release.browser} real browser download, filename, byte size and SHA-256`);
  }
 }
 assert.deepEqual(errors,[]);console.log('PASS five language download pages, versioned link, installation steps and screenshots');
}finally{await browser.close();}
