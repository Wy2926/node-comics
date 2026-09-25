// Explicit live HTTP regression: bare reader -> complete work -> pages in an isolated MV3 profile.
// Uses public samples only; no product APIs, user profile, image downloads or translation calls.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),out=path.join(root,'artifacts/chapter-imports');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
const samples=[
  {id:'dm5',url:'https://www.dm5.com/m518896/',work:'dm5:shanhainizhan1',pages:13},
  {id:'comicpash',url:'https://comicpash.jp/episodes/17f11c20955a2',work:'comicpash:series:1fafeeae328df',pages:22},
];
for(const sample of samples){const install=JSON.parse(await readFile(path.join(root,`apps/extension/src/sources/sites/${sample.id}/installation.json`),'utf8'));manifest.host_permissions.push(...install.optionalOrigins);}
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const src=path.join(root,'apps/extension/src').replaceAll('\\','/'),probe=path.join(extension,'probe.js');
await writeFile(probe,`export {readImportCatalog} from '${src}/sources/runtime/import.ts';export {readNetworkPages,readNetworkCatalog} from '${src}/sources/runtime/network.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-source.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,body:'{}'}));
const results=[];
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  await page.goto(new URL('reader.html',worker.url()).href);
  for(const sample of samples){
    const result=await page.evaluate(async sample=>{
      const {readImportCatalog,readNetworkPages,readNetworkCatalog}=await import(chrome.runtime.getURL('verify-source.js'));
      const request=globalThis.fetch;let chapterRequests=0,parentUrl,stage='identity';
      globalThis.fetch=(url,options)=>{if(String(url)===sample.url)chapterRequests++;return request(url,options);};
      try{
        const catalog=await readImportCatalog(sample.url,target=>{parentUrl=target;stage='catalog';return readNetworkCatalog(target);}),entry=catalog.entries.find(entry=>entry.id===catalog.defaultEntryId);
        stage='pages';
        const manifest=await readNetworkPages(entry.url);
        return {id:sample.id,status:'passed',parentUrl,work:catalog.id,chapters:catalog.entries.length,pages:manifest.items.length,chapterRequests};
      }catch(error){return {id:sample.id,status:'failed',parentUrl,stage,chapterRequests,error:error.message};}finally{globalThis.fetch=request;}
    },sample);
    results.push(result);console.log(JSON.stringify(result));
    if(result.status==='failed')continue;
    assert.equal(result.work,sample.work);assert.equal(result.pages,sample.pages);assert(result.chapters>1);
    assert.equal(result.chapterRequests,1,'A successful parent response should be reused for page discovery');
  }
  assert.equal((await context.pages()).filter(page=>page.url().startsWith('https:')).length,0);
  await writeFile(path.join(out,'results.json'),JSON.stringify({results,scope:'Live HTTP, preauthorized isolated Chromium MV3; no image decode or native permission prompt'},null,2));
  assert(results.every(result=>result.status==='passed'),'Live source validation failed; see results.json for the last successful stage');
}finally{await context.close();}
