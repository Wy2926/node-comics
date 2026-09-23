// Live regression: run from the repository root with PLAYWRIGHT_MODULE and TEST_CHROMIUM configured.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),out=path.join(root,'artifacts/comix-chapter-6887743');
await mkdir(out,{recursive:true});
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('https://comix.to/*','https://*.wowpic1.store/*','https://*.wowpic2.store/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const probe=path.join(extension,'probe.js'),source=path.join(root,'apps/extension/src/sources').replaceAll('\\','/');
await writeFile(probe,`export {readNetworkPages} from '${source}/runtime/network.ts';export {fetchSourceImage} from '${source}/runtime/image-fetch.ts';export {readSourceImage} from '${source}/runtime/source-image.ts';export {image} from '${source}/sites/comix/image.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-source.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,viewport:{width:1280,height:1100},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
let created=0;context.on('page',()=>created++);
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  await page.goto(new URL('reader.html',worker.url()).href);const before=created;
  page.on('console',message=>{if(message.text().startsWith('verified '))console.log(message.text());});
  const result=await page.evaluate(async()=>{
    const {readNetworkPages,readSourceImage,fetchSourceImage,image}=await import(chrome.runtime.getURL('verify-source.js'));
    const manifest=await readNetworkPages('https://comix.to/title/nr83-the-sword-bearing-flower/6887743-chapter-2');
    const rows=[],previews=[],references={
      10:[20,18,8,7,15,4,13,12,23,1,10,16,9,22,24,5,0,17,6,2,11,19,3,14,21],
      20:[12,1,2,20,11,10,23,19,16,24,14,18,8,17,7,21,4,15,9,3,13,5,6,22,0],
      110:[14,23,10,11,3,19,5,17,4,15,6,9,8,21,7,13,18,22,24,2,12,16,1,0,20],
    };
    let cursor=0;
    await Promise.all(Array.from({length:3},async()=>{while(cursor<manifest.items.length){
      const i=cursor++,item=manifest.items[i],number=i+1;
      try{
        const blob=await readSourceImage({manifestId:manifest.id,pageId:item.id,expectedUrl:item.url}),bitmap=await createImageBitmap(blob);
        const row={page:number,width:bitmap.width,height:bitmap.height,processed:!!item.processing};
        if(references[number]){
          const response=await fetchSourceImage(item.url,undefined,image.headers);
          const raw=await createImageBitmap(response.blob,{colorSpaceConversion:'none'}),canvas=new OffscreenCanvas(raw.width,raw.height),ctx=canvas.getContext('2d',{colorSpace:'srgb'}),w=Math.floor(raw.width/5),h=Math.floor(raw.height/5);
          ctx.drawImage(raw,0,0);
          for(const [from,to] of references[number].entries())ctx.drawImage(raw,from%5*w,Math.floor(from/5)*h,w,h,to%5*w,Math.floor(to/5)*h,w,h);
          const expected=ctx.getImageData(0,0,raw.width,raw.height).data;ctx.clearRect(0,0,raw.width,raw.height);ctx.drawImage(bitmap,0,0);
          const actual=ctx.getImageData(0,0,raw.width,raw.height).data;
          row.referencePixelsMatch=expected.every((value,index)=>value===actual[index]);row.hash=response.headers.get('X-Scramble-Hash');raw.close();
          previews.push({number,hash:row.hash,url:URL.createObjectURL(blob)});
        }
        bitmap.close();rows.push(row);
      }catch(error){rows.push({page:number,error:error.message});}
      if(rows.length%10===0)console.log('verified '+rows.length+'/'+manifest.items.length);
    }}));
    document.body.replaceChildren();document.body.style.cssText='background:#ddd;display:flex;gap:20px;padding:20px;align-items:start';
    for(const {number,hash,url} of previews.sort((a,b)=>a.number-b.number)){
      const figure=document.createElement('figure'),label=document.createElement('figcaption'),image=document.createElement('img');
      label.textContent=`Page ${number} / ${hash}`;image.src=url;image.style.cssText='width:360px;height:auto';figure.style.margin='0';figure.append(label,image);document.body.append(figure);await image.decode();
    }
    return {total:manifest.items.length,rows:rows.sort((a,b)=>a.page-b.page)};
  });
  result.sourceTabsCreated=created-before;
  await writeFile(path.join(out,'browser.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:path.join(out,'recovered-images.png'),fullPage:true});
  const failures=result.rows.filter(row=>row.error||row.referencePixelsMatch===false);
  console.log(JSON.stringify({total:result.total,decoded:result.rows.filter(row=>!row.error).length,processed:result.rows.filter(row=>row.processed).length,referenceMatches:result.rows.filter(row=>row.referencePixelsMatch).map(({page,hash})=>({page,hash})),failures,sourceTabsCreated:result.sourceTabsCreated}));
  assert.equal(result.total,117);assert.equal(failures.length,0);assert.equal(result.sourceTabsCreated,0);assert.equal(result.rows.filter(row=>row.referencePixelsMatch).length,3);
}finally{await context.close();}
