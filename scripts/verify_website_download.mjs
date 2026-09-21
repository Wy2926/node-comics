import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_PREVIEW_URL||'http://127.0.0.1:4321';
const catalog=JSON.parse(await readFile('backend/extension-release.json','utf8'));
const release=catalog.releases.find(item=>item.version===catalog.current);
const output='artifacts/extension-download';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 for(const locale of ['','en/','zh-tw/','ja/','ko/']){
  await page.goto(origin+'/'+locale+'download/');
  const link=page.locator('.direct-download a');
  assert.equal(await link.getAttribute('href'),release.path);
  assert.ok((await page.locator('.direct-download').innerText()).includes('v'+release.version));
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
  const promise=page.waitForEvent('download');await page.locator('.direct-download a').click();
  const download=await promise;assert.equal(download.suggestedFilename(),release.filename);
  const path=output+'/'+release.filename;await download.saveAs(path);
  const bytes=await readFile(path);
  assert.equal(bytes.length,release.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.sha256);
  console.log('PASS real browser download, filename, byte size and SHA-256');
 }
 assert.deepEqual(errors,[]);console.log('PASS five language download pages, versioned link, installation steps and screenshots');
}finally{await browser.close();}
