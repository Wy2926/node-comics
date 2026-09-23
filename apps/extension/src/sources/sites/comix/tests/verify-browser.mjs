// Isolated MV3 browser acceptance. RUN_LIVE_COMIX=1 also imports the real sample via extension HTTP.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),out=path.join(root,'artifacts/comix-validation');await mkdir(out,{recursive:true});
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('https://comix.to/*','https://*.wowpic1.store/*','https://images.example/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
const probe=path.join(extension,'probe.js');
await writeFile(probe,`export {decodeImage,tileOrder} from '${path.join(root,'apps/extension/src/sources/sites/comix/images.ts').replaceAll('\\','/')}';export {readSourceCatalog} from '${path.join(root,'apps/extension/src/sources/runtime/catalog-reader.ts').replaceAll('\\','/')}';export {readSourceImage} from '${path.join(root,'apps/extension/src/sources/runtime/source-image.ts').replaceAll('\\','/')}';export {catalog} from '${path.join(root,'apps/extension/src/comics/repositories/index.ts').replaceAll('\\','/')}';`);
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-source.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,
  viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const checks=[],created=[],errors=[];let reader;
context.on('page',page=>{created.push(page);page.on('pageerror',error=>errors.push(error.message));});
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  reader=await context.newPage();await reader.goto(new URL('reader.html',worker.url()).href);
  await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN'})));await reader.reload();
  await reader.getByRole('button',{name:'漫画网站',exact:true}).click();
  await reader.getByLabel('通过链接添加漫画').waitFor();assert.equal(await reader.getByRole('heading',{name:'xkcd',exact:true}).count(),0);
  await reader.getByRole('heading',{name:'Comix',exact:true}).waitFor();
  await reader.screenshot({path:path.join(out,'sites.png')});checks.push('Comix listed, xkcd removed, direct URL entry visible');
  const pixelResult=await reader.evaluate(async()=>{
    const {decodeImage,tileOrder}=await import(chrome.runtime.getURL('verify-source.js'));
    const seed=239595250,order=tileOrder(seed,25),w=10,h=13,cols=5,rows=5,tw=2,th=2;
    const original=new OffscreenCanvas(w,h),scrambled=new OffscreenCanvas(w,h),a=original.getContext('2d'),b=scrambled.getContext('2d');
    a.fillStyle='#aabbcc';a.fillRect(0,0,w,h);
    for(let i=0;i<25;i++){a.fillStyle=`rgb(${i*7},${i*9},${i*5})`;a.fillRect(i%cols*tw,Math.floor(i/cols)*th,tw,th);}
    b.drawImage(original,0,0);for(const [from,to] of order.entries())b.drawImage(original,to%cols*tw,Math.floor(to/cols)*th,tw,th,from%cols*tw,Math.floor(from/cols)*th,tw,th);
    const decoded=await decodeImage(await scrambled.convertToBlob(),new Headers({'X-Scramble-Seed':String(seed),'X-Scramble-Grid':'5x5','X-Scramble-Algo':'3','X-Scramble-Hash':'188b9'}),'tiles-v1');
    const restored=new OffscreenCanvas(w,h),c=restored.getContext('2d'),bitmap=await createImageBitmap(decoded);c.drawImage(bitmap,0,0);bitmap.close();
    return a.getImageData(0,0,w,h).data.every((v,i)=>v===c.getImageData(0,0,w,h).data[i]);
  });assert(pixelResult);checks.push('Canvas decode restores every pixel, including grid remainder');
  if(process.env.RUN_LIVE_COMIX==='1'){
    const before=created.length;
    await reader.getByLabel('通过链接添加漫画').fill('https://comix.to/title/rrzm-the-regressed-genius-players-mythical-rank-weapon-creation');
    await reader.getByRole('button',{name:'添加到书架',exact:true}).click();
    await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth>0,{},{timeout:90000});
    assert.equal(created.length,before);
    await reader.screenshot({path:path.join(out,'live-reader.png')});
    const details=await reader.evaluate(async()=>{
      const {catalog}=await import(chrome.runtime.getURL('verify-source.js'));const data=await chrome.storage.local.get(null),source=(await catalog.list('catalogs')).find(v=>v.sourceId==='comix'),manifest=Object.values(data).find(v=>v?.adapter==='comix'&&v.items);
      return {chapters:source.entries.length,pages:manifest.items.length,processing:manifest.items.filter(v=>v.processing).length,managed:Object.keys(await chrome.storage.session.get(null)).filter(k=>k.startsWith('nc-managed:')||k.startsWith('nc-catalog-tab:'))};
    });assert(details.chapters>0);assert.deepEqual(details.managed,[]);
    checks.push({liveImport:details});
    const imageResult=await reader.evaluate(async()=>{
      const data=await chrome.storage.local.get(null),manifest=Object.values(data).find(v=>v?.adapter==='comix'&&v.items),item=manifest.items.find(v=>v.processing);
      const {readSourceImage}=await import(chrome.runtime.getURL('verify-source.js')),decoded=await readSourceImage({manifestId:manifest.id,pageId:item.id,expectedUrl:item.url}),bitmap=await createImageBitmap(decoded);
      const preview=document.createElement('img');preview.id='comix-decoded-preview';preview.src=URL.createObjectURL(decoded);preview.style.cssText='position:fixed;inset:0;margin:auto;max-height:100vh;max-width:100vw;z-index:999999;background:white';document.body.append(preview);await preview.decode();
      const result={width:bitmap.width,height:bitmap.height,mime:decoded.type};bitmap.close();return result;
    });assert.equal(imageResult.mime,'image/png');assert(imageResult.width>0);checks.push({liveScrambledImage:imageResult});
    await reader.screenshot({path:path.join(out,'live-decoded-image.png')});await reader.evaluate(()=>{const image=document.getElementById('comix-decoded-preview');URL.revokeObjectURL(image.src);image.remove();});
    const refreshed=await reader.evaluate(async()=>{const {readSourceCatalog}=await import(chrome.runtime.getURL('verify-source.js'));return (await readSourceCatalog('https://comix.to/title/rrzm-the-regressed-genius-players-mythical-rank-weapon-creation')).entries.length;});
    assert(refreshed>=details.chapters);assert.equal(created.length,before);checks.push('Live catalog refresh completes with no source tabs');
  }
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'browser.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){if(reader){console.log((await reader.locator('body').innerText()).slice(-2500));await reader.screenshot({path:path.join(out,'failure.png')});}throw error;}
finally{await context.close();}
