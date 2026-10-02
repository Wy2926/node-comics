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
    const {loadDeliveredResult,resultBlobKey}=await import('/src/storage/translations/results.ts');
    const {translationCache}=await import('/src/storage/translations/index.ts');
    const scope={key:'overlay-browser-cache-'+crypto.randomUUID()},job={id:crypto.randomUUID(),result:{key:result.artifact.sha256,recoverable:true},delivery:result,mode:'classic',target_language:'en',status:'succeeded',phase:'succeeded',quota_pages:1,created_at:new Date().toISOString(),version:1,cache_hit:false};
    const complete=await loadDeliveredResult({scope,job,original:async()=>original,download:async()=>patch,isCurrent:()=>true});
    const stored=await translationCache.get(resultBlobKey(scope,job));
    assert(stored?.type==='image/webp'&&await hashFile(stored)===await hashFile(rendered),'IndexedDB stores the complete composed WebP');
    assert((await translationCache.inventory([scope.key])).length===1,'only one complete image is persisted per result');
    window.cachedOverlay={scope,job,sha256:await hashFile(complete)};
    const {exportOverlay}=await import('/tests/overlay-export-fixture.ts');
    const exported=await exportOverlay(original,patch,result);
    assert(exported.imageName==='00001.webp'&&exported.imageSha256===await hashFile(rendered),'CBZ exports the identical complete WebP with its actual extension');
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
    const {prepareTranslationInput}=await import('/src/translation/input/prepare.ts');
    const {loadTranslationInput}=await import('/src/translation/input/load.ts');
    const {cacheInput,INPUT_BUDGET_BYTES}=await import('/src/translation/input/cache.ts');
    const {ByteCache}=await import('/src/storage/cache.ts');
    const inputCache=new ByteCache({name:'translation-inputs-v1',budgetBytes:INPUT_BUDGET_BYTES});
    const timings=[];
    for(const [width,height] of [[2400,3600],[2400,12000],[800,12000]]){
      const surface=new OffscreenCanvas(width,height),draw=surface.getContext('2d');
      draw.fillStyle='#faf5ed';draw.fillRect(0,0,width,height);draw.font='48px sans-serif';
      for(let y=20;y<height;y+=100){draw.fillStyle=y%200?'#222':'#5487ad';draw.fillRect(30,y,width-60,8);draw.fillText('漫画 translation fixture '+y,60,y+60);}
      const source=await surface.convertToBlob({type:'image/jpeg',quality:.92});surface.width=surface.height=1;
      const sourceHash=await hashFile(source),page={width,height,imageSha256:sourceHash,imageByteSize:source.size,imageMime:source.type};
      let last=performance.now(),maxTimerGap=0;const timer=setInterval(()=>{const now=performance.now();maxTimerGap=Math.max(maxTimerGap,now-last);last=now;},16);
      const start=performance.now();const prepared=await prepareTranslationInput(page,async()=>source,()=>true);
      const elapsed=performance.now()-start;clearInterval(timer);
      const input=prepared.blob??source,decoded=await createImageBitmap(input);
      assert(decoded.width===prepared.width&&decoded.height===prepared.height,`${width}x${height}: actual encoded size matches prepared metadata`);decoded.close();
      if(prepared.blob)assert(input.type==='image/webp'&&!await needsNormalization(input),'prepared WebP is static and normalized without ICC or orientation');
      assert(await hashFile(input)===prepared.image.sha256&&await hashFile(source)===sourceHash,`${width}x${height}: upload hash is frozen and original bytes are unchanged`);
      if(width===800){
        assert(prepared.width===800&&prepared.height===height,'narrow strip keeps its original dimensions');
        if(source.size<=1024*1024){assert(!prepared.blob&&!prepared.profile,'small narrow strip reuses original bytes without encoding');continue;}
        assert(!!prepared.blob,'large narrow strip also gets one same-size compression pass');
      }else assert(prepared.width===1800&&prepared.height===height*.75,'large page uses short-edge 1800 with unchanged aspect ratio');
      assert(input.size<source.size,'high-quality WebP is smaller than this representative JPEG fixture');
      if(height===3600){
        for(const [label,bytes] of [['Source at upload size',source],['WebP quality 0.90',input]]){
          const decoded=await createImageBitmap(bytes,{resizeWidth:prepared.width,resizeHeight:prepared.height,resizeQuality:'high'});
          const crop=document.createElement('canvas');crop.width=600;crop.height=220;crop.getContext('2d').drawImage(decoded,0,0);decoded.close();
          const card=document.createElement('figure');card.style='display:inline-block;margin:12px';const caption=document.createElement('figcaption');caption.textContent=label;card.append(caption,crop);document.body.append(card);
        }
      }
      const scope={key:crypto.randomUUID()},id=crypto.randomUUID();await cacheInput(scope.key,prepared.image.sha256,input);
      const frozen={sha256:prepared.image.sha256,sourceSha256:sourceHash,profile:prepared.profile,size:{width:prepared.width,height:prepared.height}};
      const result={kind:'translated',representation:'overlay-v1',normalization_version:1,input_sha256:prepared.image.sha256,width:prepared.width,height:prepared.height,bbox:{x:10,y:10,width:2,height:2},composite:'source-atop',artifact:{sha256:await hashFile(patch),byte_size:patch.size,mime:patch.type}};
      const job={id,status:'succeeded',result:{key:result.artifact.sha256,recoverable:true},delivery:result};
      const full=await loadDeliveredResult({scope,job,original:()=>loadTranslationInput(scope.key,frozen,async()=>{throw Error('Cached input reread source');},()=>true),download:async()=>patch,isCurrent:()=>true});
      await inputCache.clear();
      const cached=await loadDeliveredResult({scope,job,original:async()=>{throw Error('Cached result reread input');},download:async()=>{throw Error('Cached result redownloaded overlay');},isCurrent:()=>true});
      assert(await hashFile(cached)===await hashFile(full),'complete translated image remains readable after input cache eviction');
      const fullBitmap=await createImageBitmap(full);assert(fullBitmap.width===prepared.width&&fullBitmap.height===prepared.height,'translated image stays at upload resolution, not original resolution');fullBitmap.close();
      const restoreStart=performance.now();
      const rebuilt=await loadTranslationInput(scope.key,frozen,async()=>source,()=>true);
      const restoreMs=Math.round(performance.now()-restoreStart);
      assert(await hashFile(rebuilt)===prepared.image.sha256,'same-browser recovery reproduces frozen input bytes');
      const reused=await loadTranslationInput(scope.key,frozen,async()=>{throw Error('Restored input reread source');},()=>true);
      assert(await hashFile(reused)===prepared.image.sha256,'shared loader persists restored input and reuses it without reading source again');
      timings.push({width,height,inputBytes:source.size,uploadBytes:input.size,prepareMs:Math.round(elapsed),restoreMs,maxTimerGapMs:Math.round(maxTimerGap)});
    }
    checks.push('synthetic resize timings (single samples, not GPU/model validation): '+JSON.stringify(timings));
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
      return {width:image.naturalWidth,height:image.naturalHeight,mime:rendered.type,bytes:rendered.size,artifactBytes:artifact.size,exportImageBytes:exported.imageBytes,archive:exported.archive,rendered:[...new Uint8Array(await rendered.arrayBuffer())]};
    },payload);
    assert(real.width>0&&real.height>0);await writeFile(path.join(out,'real-rendered.'+({'image/png':'png','image/webp':'webp','image/jpeg':'jpg'}[real.mime])),new Uint8Array(real.rendered));delete real.rendered;
    await writeFile(path.join(out,'real-translated.cbz'),new Uint8Array(real.archive));delete real.archive;
    checks.push('real provider artifact decoded and materialized: '+JSON.stringify(real));
  }
  await page.screenshot({path:path.join(out,'composition.png'),fullPage:true});
  const cachedOverlay=await page.evaluate(()=>window.cachedOverlay);
  await page.reload();
  await page.evaluate(async saved=>{
    const {loadDeliveredResult}=await import('/src/storage/translations/results.ts'),{hashFile}=await import('/src/importers/hash.ts');
    const blob=await loadDeliveredResult({...saved,isCurrent:()=>true,original:async()=>{throw Error('Original source unavailable');},download:async()=>{throw Error('Result server unavailable');}});
    if(blob.type!=='image/webp'||await hashFile(blob)!==saved.sha256)throw Error('Complete cached image changed after reload');
    const image=document.createElement('img');image.src=URL.createObjectURL(blob);image.style='width:320px;image-rendering:pixelated';document.body.append(image);await image.decode();
    if(image.naturalWidth!==4||image.naturalHeight!==4)throw Error('Cached image does not display at the original page dimensions');
  },cachedOverlay);
  checks.push('page reload displays the identical complete WebP without original source or result server');
  await page.screenshot({path:path.join(out,'cached-reload.png'),fullPage:true});
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,realProviderArtifacts:!!process.env.REAL_TRANSLATION_INPUT},null,2));
  for(const check of checks)console.log('PASS '+check);
}finally{await browser.close();}
