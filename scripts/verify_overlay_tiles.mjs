// Actual Chromium codecs, result encoding, bounded fallback and frozen inputs; no provider calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(process.argv[2]||'artifacts/overlay-tiles-validation');
const web=process.env.OVERLAY_TEST_WEB||'http://127.0.0.1:5181';
const python=process.env.PYTHON||(process.platform==='win32'?path.resolve('services/classic-engine/.venv-lama/Scripts/python.exe'):'python3');
execFileSync(python,['-c',String.raw`
import hashlib, json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from PIL.ImageCms import ImageCmsProfile, createProfile
sys.path.insert(0, 'services/classic-engine')
from classic_node.protocol import pack_result
root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
for name, size in [('long', (64, 100000)), ('wide', (100000, 64)), ('alpha', (64, 100000)), ('single', (64, 100000)), ('single-wide', (100000, 64))]:
    source = Image.new('RGB', size, (240, 230, 220))
    rendered = source.copy(); draw = ImageDraw.Draw(rendered)
    draw.text((2040, 4) if size[0] > size[1] else (4, 4092), 'Boundary', fill=(40, 80, 120))
    if name == 'single-wide':
        draw.point((0, 0), (0, 0, 0)); draw.point((15999, 63), (120, 80, 40))
    elif name != 'single':
        draw.point((0, 0), (0, 0, 0)); draw.point((size[0]-1, size[1]-1), (120, 80, 40))
    alpha = None
    if name == 'alpha':
        alpha = Image.new('L', size, 255)
        ad = ImageDraw.Draw(alpha); ad.rectangle((0, 0, 15, size[1]-1), fill=0); ad.rectangle((16, 0, 39, size[1]-1), fill=128)
        original = source.convert('RGBA'); original.putalpha(alpha)
        expected = rendered.convert('RGBA'); expected.putalpha(alpha)
    else:
        original, expected = source, rendered
    original.save(root / (name+'-original.png')); expected.save(root / (name+'-expected.png'))
    sha = hashlib.sha256((root / (name+'-original.png')).read_bytes()).hexdigest()
    packed = pack_result(rendered, np.array(source), alpha, 'fixture', {'input_hash': sha},
        {'analysis_hash': 'a'*64, 'revision': 'b'*64}, allow_tiles=True)
    body, result = packed['output_bytes'], packed['result']
    (root / (name+'.tiles')).write_bytes(body)
    public = {key: result[key] for key in ('representation', 'normalization_version', 'width', 'height')}
    public.update(kind='translated', input_sha256=sha, composite='source-atop', artifact={
        'sha256': result['output']['sha256'], 'byte_size': len(body), 'mime': result['output']['mime'],
        'path': '/v1/translations/fixture/result'})
    if result.get('bbox'): public['bbox'] = result['bbox']
    (root / (name+'.json')).write_text(json.dumps(public), encoding='utf-8')
Image.new('RGB', (8000, 6000), (240, 230, 220)).save(root / 'high-pixels.png')
panel = Image.open('apps/extension/public/samples/starlight-bookshop.png').convert('RGB')
panel = panel.resize((800, round(panel.height * 800 / panel.width)), Image.Resampling.LANCZOS)
strip = Image.new('RGB', (800, 30000))
for y in range(0, strip.height, panel.height): strip.paste(panel, (0, y))
strip.save(root / 'representative-long.jpg', quality=90)
Image.open(root / 'long-original.png').save(root / 'icc-long.png', icc_profile=ImageCmsProfile(createProfile('sRGB')).tobytes())
Image.new('RGB', (128, 20000), (240, 230, 220)).save(root / 'optional-long.jpg', quality=90)
with (root / 'optional-long.jpg').open('ab') as handle:
    handle.write(bytes(1024 * 1024))  # Valid JPEG padding triggers optional recompression with a small decoded image.
Image.new('RGB', (800, 1200), (240, 230, 220)).save(root / 'large-bytes.jpg', quality=90)
with (root / 'large-bytes.jpg').open('ab') as handle:
    for _ in range(41): handle.write(bytes(1024 * 1024))
`,root],{stdio:'pipe'});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
try{
  const page=await browser.newPage({viewport:{width:1100,height:850}});
  await page.route(web+'/tiles-validation',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>WebP tile verification</title><body style="font:16px sans-serif;padding:24px;background:#eee"><h1>WebP tiles · native pixels</h1></body>'}));
  const serveFixture=async route=>{
    const name=new URL(route.request().url()).pathname.split('/').pop();
    assert(/^(long|wide|alpha|single|single-wide)(-original\.png|-expected\.png|\.tiles|\.json)$|^(high-pixels|icc-long)\.png$|^(optional-long|large-bytes|representative-long)\.jpg$/.test(name));
    await route.fulfill({body:await readFile(path.join(root,name)),contentType:name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':name.endsWith('.json')?'application/json':name.startsWith('single')?'image/webp':'application/vnd.nodelane.overlay-tiles'});
  };
  await page.route(web+'/tile-fixture/*',serveFixture);
  await page.goto(web+'/tiles-validation');
  const report=await page.evaluate(async shared=>{
    const {materializeResult}=await import('/src/translation/materialize.ts');
    const {prepareComicPage}=await import('/src/comics/pages/normalize.ts');
    const {prepareTranslationInput}=await import('/src/translation/input/prepare.ts');
    const {hashFile}=await import('/src/importers/hash.ts');
    const {resizeInput}=await import('/src/translation/input/resize.ts');
    const {LEGACY_INPUT_PROFILE}=await import('/src/translation/input/limits.ts');
    const {loadDeliveredResult,resultBlobKey}=await import('/src/storage/translations/results.ts');
    const {translationCache}=await import('/src/storage/translations/index.ts');
    const {needsNormalization}=await import('/src/comics/pages/image-metadata.ts');
    const {compositeImage}=await import(shared+'/composite.ts');
    const {bitmapPng}=await import(shared+'/png.ts');
    const checks=[],cases=[];
    for(const name of ['long','wide','alpha','single','single-wide']){
      const original=await(await fetch('/tile-fixture/'+name+'-original.png')).blob();
      const artifact=await(await fetch('/tile-fixture/'+name+'.tiles')).blob();
      const expected=await(await fetch('/tile-fixture/'+name+'-expected.png')).blob();
      const result=await(await fetch('/tile-fixture/'+name+'.json')).json();
      const started=performance.now();
      const normalized=await prepareComicPage({name,blob:original});
      if(normalized.blob!==original)throw Error('Reader changed ordinary source bytes');
      const prepared=await prepareTranslationInput({...normalized,imageByteSize:original.size,imageMime:'image/png'},async()=>original,()=>true);
      if(prepared.width!==result.width||prepared.height!==result.height)throw Error('Long input dimensions changed');
      const decode=globalThis.createImageBitmap;let patchDecodes=0,output;
      if(name==='single-wide')globalThis.createImageBitmap=async(...args)=>{if(args[0]===artifact)patchDecodes++;return decode(...args);};
      try{output=await materializeResult(result,original,artifact);}finally{globalThis.createImageBitmap=decode;}
      const milliseconds=performance.now()-started;
      if(name==='single-wide'){
        if(patchDecodes!==1)throw Error('Ordinary overlay decoded '+patchDecodes+' times instead of reusing its bitmap');
        checks.push('A 16000 × 64 ordinary overlay on a 100000 × 64 source decodes once across all stream bands and columns');
      }
      for(const blob of [original,output]){
        const native=new Image(),url=URL.createObjectURL(blob);native.src=url;
        try{await native.decode();if(native.naturalWidth!==result.width||native.naturalHeight!==result.height)throw Error('Reader image element dimensions changed');}
        finally{native.src='';URL.revokeObjectURL(url);}
      }
      let downloads=0,reads=0;
      const scope={key:'tile-verification:'+name},job={id:name,status:'succeeded',result:{key:result.artifact.sha256,recoverable:true},delivery:result};
      const cached=await loadDeliveredResult({scope,job,isCurrent:()=>true,download:async()=>{downloads++;return artifact;},original:async()=>{reads++;return original;}});
      if(await hashFile(cached)!==await hashFile(output))throw Error('Cached complete pixels changed');
      await loadDeliveredResult({scope,job,isCurrent:()=>true,download:async()=>{throw Error('Cache hit downloaded again');},original:async()=>{throw Error('Cache hit restored original');}});
      await translationCache.delete(resultBlobKey(scope,job));
      await loadDeliveredResult({scope,job,isCurrent:()=>true,download:async()=>{downloads++;return artifact;},original:async()=>{reads++;return original;}});
      if(downloads!==2||reads!==2)throw Error('Eviction recovery did not reuse the same delivered result');
      const actual=await createImageBitmap(output),reference=await createImageBitmap(expected);
      if(actual.width!==result.width||actual.height!==result.height)throw Error('Composed dimensions changed');
      const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d');
      for(let y=0;y<actual.height;y+=512)for(let x=0;x<actual.width;x+=2048){
        const w=Math.min(2048,actual.width-x),h=Math.min(512,actual.height-y);canvas.width=w;canvas.height=h;
        context.clearRect(0,0,w,h);context.drawImage(actual,x,y,w,h,0,0,w,h);const a=context.getImageData(0,0,w,h).data;
        context.clearRect(0,0,w,h);context.drawImage(reference,x,y,w,h,0,0,w,h);const b=context.getImageData(0,0,w,h).data;
        for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error('Pixel changed at tile boundary: '+[name,x,y,i,a[i],b[i],a[i-i%4+3]]);
      }
      const y=name==='long'?4080:0,x=name==='wide'?2020:0;
      canvas.width=name==='long'?64:100;canvas.height=name==='long'?80:64;
      context.drawImage(actual,x,y,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
      const preview=document.createElement('img');preview.src=URL.createObjectURL(await canvas.convertToBlob());preview.style.cssText='display:block;image-rendering:pixelated;width:320px';
      const label=document.createElement('p');label.textContent=name+' · '+actual.width+' × '+actual.height+' · exact glyph pixels across tile seams';document.body.append(label,preview);
      actual.close();reference.close();canvas.width=canvas.height=1;
      let refused=false;try{await materializeResult({...result,artifact:{...result.artifact,sha256:'a'.repeat(64)}},original,artifact);}catch{refused=true;}
      if(!refused)throw Error('Corrupted artifact was accepted');
      checks.push(name+': original and result decode in the reader image element; every composed pixel matches the full rendered page; wrong hash is rejected');
      checks.push(name+': complete cache hits skip downloads and source reads; eviction recovers the same result');
      cases.push({name,width:result.width,height:result.height,artifactBytes:artifact.size,completeBytes:output.size,milliseconds:Math.round(milliseconds),sha256:await hashFile(output),...(name==='single-wide'?{patchDecodes}:{})});
    }
    const source=await(await fetch('/tile-fixture/high-pixels.png')).blob(),normalized=await prepareComicPage({name:'48M pixels',blob:source});
    if(normalized.width!==8000||normalized.height!==6000||normalized.blob!==source)throw Error('Former reader pixel limit remains');
    checks.push('An actual 8000 × 6000 source is readable without changing its bytes');
    const longSource=await(await fetch('/tile-fixture/long-original.png')).blob();
    const first=await resizeInput(longSource,64,100000,LEGACY_INPUT_PROFILE),second=await resizeInput(longSource,64,100000,LEGACY_INPUT_PROFILE);
    if(first.blob.type!=='image/png'||first.sha256!==second.sha256)throw Error('Frozen long input could not be regenerated exactly');
    checks.push('Long input encoding preserves 100000 pixels and reproduces identical frozen PNG bytes');
    const tagged=await(await fetch('/tile-fixture/icc-long.png')).blob(),staticPage=await prepareComicPage({name:'Tagged long source',blob:tagged});
    if(staticPage.width!==64||staticPage.height!==100000||await needsNormalization(staticPage.blob))throw Error('Long source normalization failed');
    checks.push('An actual ICC-tagged 100000-pixel source normalizes at its original resolution');
    const {sourceImage,imageDataUrl}=await import('/src/sources/index.ts');
    const start=performance.now(),large=await sourceImage('/tile-fixture/large-bytes.jpg');
    if(large.size<=40*1024*1024)throw Error('Large-image fixture did not cross the former byte limits');
    const readable=await prepareComicPage({name:'Large original',blob:large});
    if(readable.blob!==large||readable.width!==800||readable.height!==1200)throw Error('Large original was rejected or changed');
    const sourceMs=performance.now()-start,dataUrl=await imageDataUrl(large);
    if(dataUrl.length<large.size*4/3)throw Error('Large original could not cross the page transport');
    const translated=await prepareTranslationInput({...readable,id:'large-original',name:'Large original',jobs:[],outputBlobs:{},imageByteSize:large.size,imageMime:large.type},async()=>large,()=>true,
      {max_bytes:32*1024*1024,max_dimension:100000,max_pixels:100000**2,max_translation_ids:32});
    if(translated.image.byte_size>32*1024*1024||translated.sourceSha256!==readable.imageSha256||readable.blob!==large)throw Error('Upload preflight changed or blocked the original');
    checks.push('An actual JPEG above 40 MiB reads and crosses page transport unchanged; its translation copy respects a separate 32 MiB upload budget');
    const representative=await(await fetch('/tile-fixture/representative-long.jpg')).blob(),base=await createImageBitmap(representative);
    const lettering=new OffscreenCanvas(700,220),letter=lettering.getContext('2d');
    letter.fillStyle='white';letter.fillRect(0,0,700,220);letter.fillStyle='#172943';letter.font='32px sans-serif';
    letter.fillText('清晰的中文译文 / READ EVERY LINE',16,70);letter.font='16px sans-serif';letter.fillText('Small text, thin strokes: 0123456789 ABC xyz',16,120);
    for(let y=145;y<190;y+=5)letter.fillRect(16,y,640,1);
    const patch=await createImageBitmap(lettering),patches=[{x:50,y:1000,width:700,height:220,bitmap:patch}];
    const baselineStart=performance.now(),baseline=await bitmapPng(base,patches),baselineMs=performance.now()-baselineStart;
    const optimizedStart=performance.now(),optimized=await compositeImage(base,patches,'image/jpeg'),optimizedMs=performance.now()-optimizedStart;
    if(optimized.type!=='image/jpeg'||optimized.size>=baseline.size*.5)throw Error('Representative long-page encoding did not reduce PNG size by at least half');
    const reference=await createImageBitmap(baseline),actual=await createImageBitmap(optimized);
    if(actual.width!==800||actual.height!==30000)throw Error('Result encoding resized the long page');
    const compare=new OffscreenCanvas(800,512),paint=compare.getContext('2d',{willReadFrequently:true});let squared=0,count=0,textSquared=0,textCount=0;
    for(let y=0;y<30000;y+=512){
      const h=Math.min(512,30000-y);compare.height=h;paint.drawImage(reference,0,y,800,h,0,0,800,h);const a=paint.getImageData(0,0,800,h).data;
      paint.drawImage(actual,0,y,800,h,0,0,800,h);const b=paint.getImageData(0,0,800,h).data;
      for(let i=0;i<a.length;i+=4){if(a[i+3]!==b[i+3])throw Error('Opaque alpha changed');const x=(i/4)%800,py=y+Math.floor(i/4/800),text=x>=50&&x<750&&py>=1000&&py<1220;
        for(let c=0;c<3;c++){const error=(a[i+c]-b[i+c])**2;squared+=error;count++;if(text){textSquared+=error;textCount++;}}
      }
    }
    const rmse=Math.sqrt(squared/count),textRmse=Math.sqrt(textSquared/textCount);
    if(rmse>6||textRmse>6)throw Error('High-quality result exceeded the measured pixel error budget: '+JSON.stringify({rmse,textRmse}));
    for(const [name,image] of [['PNG baseline',reference],['JPEG result',actual]]){
      compare.width=700;compare.height=220;paint.drawImage(image,50,1000,700,220,0,0,700,220);
      const title=document.createElement('p');title.textContent=name+' · Chinese, small text and single-pixel lines';
      const preview=document.createElement('img');preview.src=URL.createObjectURL(await compare.convertToBlob());document.body.append(title,preview);
    }
    base.close();patch.close();reference.close();actual.close();lettering.width=lettering.height=compare.width=compare.height=1;
    checks.push('800 × 30000 illustrated long JPEG keeps native dimensions, Chinese/small text and alpha; actual encoded size and error measured against the old PNG path');
    return {checks,cases,encoding:{width:800,height:30000,inputBytes:representative.size,baselineBytes:baseline.size,optimizedBytes:optimized.size,mime:optimized.type,baselineMs,optimizedMs,rmse,textRmse},largeOriginal:{sourceBytes:large.size,width:readable.width,height:readable.height,sourceMs,inputBytes:translated.image.byte_size},synthetic:true,realProvider:false};
  },'/@fs/'+path.resolve('backend/shared/translation-images').replaceAll('\\','/'));
  // Lower only translation-input encoding's budget; original normalization and result composition stay unrestricted.
  const limited=await browser.newContext();
  try{
    await limited.route(web+'/tiles-validation',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Bounded PNG input errors</title>'}));
    await limited.route(web+'/tile-fixture/*',serveFixture);
    let injected=0;
    await limited.route(/\/backend\/shared\/translation-images\/resize\.ts(?:\?|$)/,async route=>{
      const response=await route.fetch(),source=await response.text();
      const replacement=source.replace(/bitmapPng\(\s*bitmap\s*,\s*\[\s*\]\s*,\s*TRANSLATION_MAX_BYTES\s*\)/,'bitmapPng(bitmap, [], 1024)');
      assert.notEqual(replacement,source,'Upload PNG test budget injection did not match');injected++;
      await route.fulfill({response,body:replacement});
    });
    const inputPage=await limited.newPage(),errors=[];inputPage.on('pageerror',error=>errors.push(error.message));
    await inputPage.goto(web+'/tiles-validation');
    report.optionalInput=await inputPage.evaluate(async()=>{
      const {prepareComicPage}=await import('/src/comics/pages/normalize.ts');
      const {prepareTranslationInput,restoreTranslationInput}=await import('/src/translation/input/prepare.ts');
      const {resizeInput}=await import('/src/translation/input/resize.ts');
      const {LEGACY_INPUT_PROFILE}=await import('/src/translation/input/limits.ts');
      const source=await(await fetch('/tile-fixture/optional-long.jpg')).blob();
      const normalized=await prepareComicPage({name:'Optional long JPEG',blob:source});
      if(normalized.blob!==source)throw Error('Ordinary JPEG source changed during normalization');
      const terminate=Worker.prototype.terminate;let terminated=0;
      Worker.prototype.terminate=function(){terminated++;return terminate.call(this);};
      try{
        const prepared=await prepareTranslationInput({...normalized,imageByteSize:source.size,imageMime:source.type},async()=>source,()=>true);
        if(prepared.sourceSha256!==normalized.imageSha256||normalized.blob!==source)throw Error('Upload encoding changed the original JPEG bytes');
        if(terminated!==1)throw Error('Optional encoding did not terminate its worker');
        let restoreRejected=false,resizeRejected=false;
        try{await restoreTranslationInput(source,128,20000,normalized.imageSha256,normalized.imageSha256,()=>true,LEGACY_INPUT_PROFILE);}catch(error){restoreRejected=error.code==='IMAGE_OUTPUT_TOO_LARGE';}
        try{await resizeInput(source,128,18000,LEGACY_INPUT_PROFILE);}catch(error){resizeRejected=error.code==='IMAGE_OUTPUT_TOO_LARGE';}
        if(!restoreRejected||!resizeRejected||terminated!==2)throw Error('Required encoding silently reused source bytes or retained a worker');
        return {width:128,height:20000,inputBytes:source.size,simulatedOutputBudget:1024,originalRetained:true,frozenRestoreRejected:restoreRejected,requiredResizeRejected:resizeRejected,terminatedWorkers:terminated};
      }finally{Worker.prototype.terminate=terminate;}
    });
    assert(injected>=1);assert.deepEqual(errors,[]);
    report.checks.push('A real JPEG retains its original bytes independently of upload encoding; a 1 KiB legacy upload PNG budget still rejects frozen restoration and required encoding, and workers terminate');
  }finally{await limited.close();}
  await page.screenshot({path:path.join(root,'browser.png'),fullPage:true});
  await writeFile(path.join(root,'browser.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{await browser.close();}
