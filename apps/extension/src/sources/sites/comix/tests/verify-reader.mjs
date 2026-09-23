// Exercise the built reader, including source fetch, normalization, digest worker, cache and display.
// Run from repo root against the current build.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),out=path.join(root,'artifacts/comix-reader-6887743');await mkdir(out,{recursive:true});
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('https://comix.to/*','https://*.wowpic1.store/*','https://*.wowpic2.store/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const probe=path.join(extension,'probe.js'),source=path.join(root,'apps/extension/src').replaceAll('\\','/');
await writeFile(probe,`export {readNetworkPages} from '${source}/sources/runtime/network.ts';export {catalog} from '${source}/comics/repositories/index.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-source.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const rows=[],workers=[];let created=0;context.on('page',()=>created++);
try{
  const background=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  page.on('worker',worker=>workers.push(worker.url()));
  const reader=new URL('reader.html',background.url()).href;await page.goto(reader);
  await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN'})));
  const sourceManifest=await page.evaluate(async()=>{
    const {readNetworkPages}=await import(chrome.runtime.getURL('verify-source.js'));
    const manifest=await readNetworkPages('https://comix.to/title/nr83-the-sword-bearing-flower/6887743-chapter-2');return {id:manifest.id,count:manifest.items.length};
  });const before=created;
  await page.goto(reader+'?manifest='+encodeURIComponent(sourceManifest.id));
  await page.getByLabel('跳转页码').waitFor({timeout:60000});
  for(let number=1;number<=sourceManifest.count;number++){
    await page.getByLabel('跳转页码').fill(String(number),{force:true});
    await page.waitForFunction(index=>{const cell=document.querySelector(`[data-page-index="${index}"]`);return cell?.querySelector('img.nc-page-image')?.naturalWidth>0||!!cell?.querySelector('.nc-image-failure');},number-1,{timeout:60000});
    const row=await page.locator(`[data-page-index="${number-1}"]`).evaluate((cell,number)=>({page:number,shown:!!cell.querySelector('img.nc-page-image')?.naturalWidth,error:cell.querySelector('.nc-image-failure p')?.textContent}),number);
    rows.push(row);if(number%10===0)console.log('reader '+number+': '+(row.shown?'shown':row.error));
    if(number===10||number===20||number===110)await page.screenshot({path:path.join(out,`page-${number}.png`)});
  }
  const materializations=await page.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-source.js'));return (await catalog.list('materializations',{limit:1500})).map(row=>({bytes:row.byteSize,sha:row.imageSha256}));});
  const url=workers.find(url=>/hash\.worker-[^/]+\.js$/.test(url));assert(url,'Reader must run a packaged digest worker');
  const digest=await page.evaluate(url=>new Promise((resolve,reject)=>{const worker=new Worker(url,{type:'module'});worker.onmessage=event=>{worker.terminate();event.data.error?reject(Error(event.data.error)):resolve(event.data.sha256);};worker.onerror=()=>{worker.terminate();reject(Error('worker failed'));};worker.postMessage(new Blob([new Uint8Array(2*1024*1024).fill(97)]));}),url);
  const digestMatches=digest===createHash('sha256').update(Buffer.alloc(2*1024*1024,97)).digest('hex');assert(digestMatches);
  await page.goto(reader+'?manifest='+encodeURIComponent(sourceManifest.id));
  await page.getByLabel('跳转页码').waitFor({timeout:60000});
  await page.getByLabel('跳转页码').fill('10',{force:true});
  await page.waitForFunction(()=>document.querySelector('[data-page-index="9"] img.nc-page-image')?.naturalWidth>0,{},{timeout:30000});
  await page.locator('.busy-pill').waitFor({state:'hidden',timeout:30000});
  await page.screenshot({path:path.join(out,'reopened-10.png')});
  const result={rows,sourceTabsCreated:created-before,workers:workers.map(url=>new URL(url).pathname),materialized:materializations.length,largePages:materializations.filter(row=>row.bytes>=1024*1024).length,digestMatches};
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({shown:rows.filter(row=>row.shown).length,total:rows.length,failures:rows.filter(row=>!row.shown),materialized:result.materialized,largePages:result.largePages,workers:workers.length,digestMatches,sourceTabsCreated:result.sourceTabsCreated}));
  assert(rows.every(row=>row.shown));assert.equal(result.materialized,117);assert(result.largePages>0);
  assert.equal(result.sourceTabsCreated,0);
}finally{await context.close();}
