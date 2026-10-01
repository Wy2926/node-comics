// Real files through the extension's actual browser normalization and input preparation.
// Local-only; output can be passed directly to verify_overlay_live.py.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
const web=process.env.OVERLAY_TEST_WEB||'http://127.0.0.1:5176';
const names=(await readdir(source)).filter(name=>/\.(png|jpe?g|webp)$/i.test(name)).sort();
assert(names.length&&names.length<=16,'Use a bounded set of real images');
await mkdir(path.join(out,'inputs'),{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
try{
  const page=await browser.newPage();
  await page.route(web+'/input-verification',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Real input verification</title>'}));
  await page.route(web+'/real-input/*',async route=>{
    const name=decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    assert(names.includes(name));
    const mime=/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg';
    await route.fulfill({body:await readFile(path.join(source,name)),contentType:mime});
  });
  await page.exposeFunction('saveInput',async(name,base64)=>{
    assert(name===path.basename(name));await writeFile(path.join(out,'inputs',name),Buffer.from(base64,'base64'));
  });
  await page.goto(web+'/input-verification');
  const report=await page.evaluate(async names=>{
    const {prepareComicPage}=await import('/src/comics/pages/normalize.ts');
    const {prepareTranslationInput}=await import('/src/translation/input/prepare.ts');
    const {hashFile}=await import('/src/importers/hash.ts');
    const save=async(name,blob)=>{
      const bytes=new Uint8Array(await blob.arrayBuffer());let text='';
      for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));
      await window.saveInput(name,btoa(text));
    };
    const pages=[];
    for(const [index,name] of names.entries()){
      const original=await(await fetch('/real-input/'+encodeURIComponent(name))).blob();
      const start=performance.now();
      let last=start,gap=0;const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},16);
      try{
        const normalized=await prepareComicPage({name,blob:original}),normalMs=performance.now()-start;
        const prepared=await prepareTranslationInput({...normalized,imageMime:normalized.blob.type},async()=>normalized.blob,()=>true);
        const prepareMs=performance.now()-start-normalMs,blob=prepared.blob??normalized.blob;
        clearInterval(timer); // Exclude verifier hashing/base64 serialization from UI timing.
        const sha=await hashFile(blob);if(sha!==prepared.image.sha256)throw Error('Prepared hash differs');
        const extension={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
        await save(`${index+1}-prepared${extension[blob.type]}`,blob);
        // First page only: real model/OCR baseline without input compression.
        if(index===0)await save(`0-baseline${extension[normalized.blob.type]}`,normalized.blob);
        pages.push({name,width:normalized.width,height:normalized.height,originalBytes:original.size,
          normalizedBytes:normalized.blob.size,widthOut:prepared.width,heightOut:prepared.height,
          uploadBytes:blob.size,normalMs:Math.round(normalMs),prepareMs:Math.round(prepareMs),maxTimerGapMs:Math.round(gap),sha});
      }finally{clearInterval(timer);}
    }
    return {pages};
  },names);
  await writeFile(path.join(out,'preparation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
