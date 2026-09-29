// Actual browser decoders/canvas, isolated synthetic pixels; optional local real-provider artifacts.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const web=process.env.OVERLAY_TEST_WEB||'http://127.0.0.1:5176',out=path.resolve(process.env.OVERLAY_TEST_OUT||'artifacts/translation-overlay-validation');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1000,height:800}});
try{
  await page.route(web+'/overlay-validation',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Overlay validation</title><body style="font:18px system-ui;padding:30px;background:#eee"><h1>Native overlay composition</h1></body>'}));
  await page.goto(web+'/overlay-validation');
  const checks=await page.evaluate(async()=>{
    const {materializeResult}=await import('/src/translation/materialize.ts'),{hashFile}=await import('/src/importers/hash.ts');
    const checks=[],assert=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};
    const source=new OffscreenCanvas(4,4),ctx=source.getContext('2d');
    const data=ctx.createImageData(4,4);
    for(let i=0;i<16;i++)data.data.set([0,0,0,[255,128,64,0][i%4]],i*4);ctx.putImageData(data,0,0);
    const original=await source.convertToBlob({type:'image/png'});
    const overlay=new OffscreenCanvas(2,2),drawing=overlay.getContext('2d');drawing.fillStyle='white';drawing.fillRect(0,0,2,2);drawing.clearRect(0,1,1,1);
    const patch=await overlay.convertToBlob({type:'image/webp',quality:1});
    const result={kind:'translated',representation:'overlay-v1',input_sha256:await hashFile(original),normalization_version:1,width:4,height:4,bbox:{x:1,y:1,width:2,height:2},composite:'source-atop',artifact:{sha256:await hashFile(patch),byte_size:patch.size,mime:patch.type,path:'/v1/translations/test/result'}};
    const rendered=await materializeResult(result,original,patch),bitmap=await createImageBitmap(rendered),canvas=new OffscreenCanvas(4,4),render=canvas.getContext('2d');render.drawImage(bitmap,0,0);bitmap.close();
    const pixels=render.getImageData(0,0,4,4).data;
    assert([...pixels].filter((_,i)=>i%4===3).every((a,i)=>a===data.data[i*4+3]),'source-atop preserves every original alpha byte');
    assert([1,2].every(x=>pixels[(1*4+x)*4]===255),'opaque patch replaces RGB over semitransparent original');
    assert(pixels[(2*4+1)*4]===0,'transparent patch leaves original pixels unchanged');
    assert(pixels[0]===0&&pixels[(3*4+2)*4]===0,'pixels outside integer bbox remain original');
    const rejects=async(value,base,artifact,label)=>{let failed=false;try{await materializeResult(value,base,artifact);}catch{failed=true;}assert(failed,label);};
    await rejects(result,new Blob(['wrong']),patch,'different input digest refuses composition');
    await rejects(result,undefined,patch,'missing original refuses composition');
    await rejects({...result,bbox:{x:3,y:1,width:2,height:2}},original,patch,'out-of-range bbox refuses composition');
    await rejects({...result,artifact:{...result.artifact,sha256:'a'.repeat(64)}},original,patch,'corrupt artifact digest refuses composition');
    for(const kind of ['no_text','translated'])assert(await materializeResult({...result,kind,representation:'original',bbox:undefined,composite:undefined,artifact:null},original)===original,kind+' original representation returns original bytes');
    const {prepareComicPage}=await import('/src/comics/pages/normalize.ts');
    const normalized=await prepareComicPage({name:'static',blob:original});assert(normalized.blob===original&&normalized.imageSha256===result.input_sha256,'static sRGB PNG preserves exact upload bytes');
    const {needsNormalization}=await import('/src/comics/pages/image-metadata.ts');
    for(const name of ['orientation-6.jpg','srgb-icc.png','animated.png','animated.webp','animated.gif']){
      const input=await(await fetch('/tests/fixtures/normalization/'+name)).blob(),prepared=await prepareComicPage({name,blob:input});
      assert(prepared.blob.type==='image/png'&&!await needsNormalization(prepared.blob),name+' becomes a static PNG without EXIF/ICC/animation metadata');
      assert(prepared.imageSha256===await hashFile(prepared.blob)&&prepared.imageSha256!==await hashFile(input),name+' binds SHA-256 to the actual normalized upload bytes');
      if(name==='orientation-6.jpg')assert(prepared.width===2&&prepared.height===3,'EXIF orientation 6 is applied before dimensions are frozen');
      if(name.startsWith('animated')){
        const frame=await createImageBitmap(prepared.blob),surface=new OffscreenCanvas(frame.width,frame.height),draw=surface.getContext('2d');draw.drawImage(frame,0,0);frame.close();const rgba=draw.getImageData(0,0,1,1).data;
        assert(rgba[0]===255&&rgba[2]===0,name+' uses the first static frame');
      }
    }
    for(const [label,blob] of [['Original',original],['Patch',patch],['Composed',rendered]]){const card=document.createElement('figure');card.style='display:inline-block';card.innerHTML='<figcaption>'+label+'</figcaption>';const image=document.createElement('img');image.src=URL.createObjectURL(blob);image.style='width:240px;height:240px;image-rendering:pixelated;background:repeating-conic-gradient(#aaa 0% 25%,#fff 0% 50%) 50% / 24px 24px';card.append(image);document.body.append(card);}
    return checks;
  });
  if(process.env.REAL_TRANSLATION_INPUT&&process.env.REAL_TRANSLATION_RESULT&&process.env.REAL_TRANSLATION_ARTIFACT){
    const originalMime={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[path.extname(process.env.REAL_TRANSLATION_INPUT).toLowerCase()];assert(originalMime,'Unsupported original file extension');
    const payload={originalMime,original:(await readFile(process.env.REAL_TRANSLATION_INPUT)).toString('base64'),artifact:(await readFile(process.env.REAL_TRANSLATION_ARTIFACT)).toString('base64'),result:JSON.parse(await readFile(process.env.REAL_TRANSLATION_RESULT,'utf8'))};
    const real=await page.evaluate(async payload=>{
      const {materializeResult}=await import('/src/translation/materialize.ts');
      const blob=(base64,mime)=>new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:mime});
      const result=payload.result.result??payload.result,original=blob(payload.original,payload.originalMime),artifact=blob(payload.artifact,result.artifact.mime),rendered=await materializeResult(result,original,artifact);
      const image=document.createElement('img');image.src=URL.createObjectURL(rendered);image.style='max-width:600px;display:block';document.body.append(image);await image.decode();
      const {exportOverlay}=await import('/tests/overlay-export-fixture.ts'),{hashFile}=await import('/src/importers/hash.ts');
      const exported=await exportOverlay(original,artifact,result);
      if(exported.sourceReads!==1||exported.imageSha256!==await hashFile(rendered))throw Error('Export did not materialize the exact full translated image');
      return {width:image.naturalWidth,height:image.naturalHeight,bytes:rendered.size,artifactBytes:artifact.size,exportImageBytes:exported.imageBytes,archive:exported.archive,rendered:[...new Uint8Array(await rendered.arrayBuffer())]};
    },payload);
    assert(real.width>0&&real.height>0);await writeFile(path.join(out,'real-rendered.png'),new Uint8Array(real.rendered));delete real.rendered;
    await writeFile(path.join(out,'real-translated.cbz'),new Uint8Array(real.archive));delete real.archive;
    checks.push('real provider artifact decoded and materialized: '+JSON.stringify(real));
  }
  await page.screenshot({path:path.join(out,'composition.png'),fullPage:true});
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,realProviderArtifacts:!!process.env.REAL_TRANSLATION_INPUT},null,2));
  for(const check of checks)console.log('PASS '+check);
}finally{await browser.close();}
