// Reuse actual client normalization/materialization/export on local real-provider artifacts.
// Requires Vite 5176, Playwright and Chromium; never contacts the API or LLM.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,open,readFile,rename,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const run=path.resolve(process.argv[2]||'artifacts/overlay-chapter'),out=path.join(run,'browser'),web=process.env.OVERLAY_TEST_WEB||'http://127.0.0.1:5176';
const report=JSON.parse(await readFile(path.join(run,'report.json'),'utf8'));
const inputs=[],files=new Map(),mimes={'.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
for(const record of report.pages??[{ordinal:1,directory:'',state:'succeeded',source_file:'source.png',artifact_file:'overlay.webp'}]){
  const directory=path.resolve(run,record.directory),sourceName=record.source_file;
  assert(directory===run||directory.startsWith(run+path.sep),'Page directory must remain inside this run');
  assert(sourceName&&path.basename(sourceName)===sourceName,'Missing canonical source file');
  const result=record.state==='succeeded'?JSON.parse(await readFile(path.join(directory,'result.json'),'utf8')):undefined;
  const sourceUrl=web+'/chapter-assets/'+record.ordinal+'/'+sourceName;
  files.set(sourceUrl,{path:path.join(directory,sourceName),mime:mimes[path.extname(sourceName)]});
  let artifactUrl;
  if(result?.artifact){
    const filename=record.artifact_file;assert(filename&&path.basename(filename)===filename);
    artifactUrl=web+'/chapter-assets/'+record.ordinal+'/'+filename;
    files.set(artifactUrl,{path:path.join(directory,filename),mime:result.artifact.mime});
  }
  inputs.push({ordinal:record.ordinal,state:record.state,sourceName,sourceUrl,result,artifactUrl});
}
assert.equal(inputs.length,report.expected_pages??inputs.length,'Live chapter is incomplete; wait for every original UUID');
await mkdir(out,{recursive:true});
const archivePartial=path.join(out,'translated.cbz.partial'),archiveFinal=path.join(out,'translated.cbz'),handle=await open(archivePartial,'w');
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1240,height:900}});
let closed=false;
try{
  await page.exposeFunction('saveRendered',async(ordinal,mime,base64)=>{
    assert(Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=inputs.length);
    const extension={'image/png':'png','image/webp':'webp','image/jpeg':'jpg'}[mime];assert(extension);
    await writeFile(path.join(out,String(ordinal).padStart(5,'0')+'.'+extension),Buffer.from(base64,'base64'));
  });
  await page.exposeFunction('writeArchive',async(base64)=>{const bytes=Buffer.from(base64,'base64');await handle.write(bytes);});
  await page.exposeFunction('chapterProgress',async(value)=>{if(value.phase!=='export'||value.completed===inputs.length)console.log(JSON.stringify(value));});
  await page.route(web+'/chapter-assets/**',async route=>{const file=files.get(route.request().url());assert(file,'Unrecognized local file URL');await route.fulfill({contentType:file.mime,body:await readFile(file.path)});});
  await page.route(web+'/chapter-validation',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Chapter overlay verification</title><style>body{font:14px system-ui;background:#e8e8e8;margin:20px}main{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}figure{margin:0;background:white;padding:8px}img{width:100%;height:255px;object-fit:contain}figcaption{text-align:center;margin:6px}</style><h1>Native chapter composition</h1><main></main>'}));
  await page.goto(web+'/chapter-validation');
  const result=await page.evaluate(async inputs=>{
    const {exportOverlayChapter}=await import('/tests/overlay-chapter-fixture.ts');
    const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);};
    const destination=new WritableStream({async write(chunk){await window.writeArchive(base64(chunk));}});
    return exportOverlayChapter(inputs,{destination,progress:value=>window.chapterProgress(value),rendered:async(value,blob)=>{
      await window.saveRendered(value.ordinal,blob.type,base64(new Uint8Array(await blob.arrayBuffer())));
      const bitmap=await createImageBitmap(blob),scale=Math.min(180/bitmap.width,255/bitmap.height),canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale))),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      const thumbnail=await canvas.convertToBlob({type:'image/png'});canvas.width=canvas.height=1;
      const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');image.src=URL.createObjectURL(thumbnail);caption.textContent=String(value.ordinal).padStart(5,'0')+' · '+value.kind;figure.append(image,caption);document.querySelector('main').append(figure);await image.decode();
    }});
  },inputs);
  await handle.close();closed=true;await rename(archivePartial,archiveFinal);
  const translated=result.pages.filter(page=>page.representation!=='original');
  const sum=(pages,key)=>pages.reduce((value,page)=>value+page[key],0);
  const ratios=translated.map(page=>page.artifactBytes/page.renderedBytes).sort((a,b)=>a-b),percentile=p=>ratios.length?ratios[Math.max(0,Math.ceil(ratios.length*p)-1)]:null;
  const summary={pages:result.pages.length,sourceReads:result.sourceReads,materializations:result.materializations,inputBytes:sum(result.pages,'inputBytes'),artifactBytes:sum(result.pages,'artifactBytes'),renderedBytes:sum(result.pages,'renderedBytes'),translatedRenderedBytes:sum(translated,'renderedBytes'),archiveBytes:result.archiveBytes,artifactToTranslatedRenderedRatio:sum(translated,'renderedBytes')?sum(translated,'artifactBytes')/sum(translated,'renderedBytes'):0,pageArtifactRatioP50:percentile(.5),pageArtifactRatioP95:percentile(.95)};
  await writeFile(path.join(out,'report.json'),JSON.stringify({...result,summary},null,2));
  // Verify the finished CBZ independently, including every fallback/no-text page.
  const verified=spawnSync(process.env.PYTHON||'python',['-c',[
    'import hashlib,json,pathlib,sys,zipfile',
    'root=pathlib.Path(sys.argv[1]); report=json.loads((root/"report.json").read_text(encoding="utf-8"))',
    'with zipfile.ZipFile(root/"translated.cbz") as archive:',
    ' manifest=json.loads(archive.read("export-manifest.json")); assert len(manifest["pages"])==len(report["pages"])',
    ' assert len(archive.namelist())==len(report["pages"])+1',
    ' for page in report["pages"]:',
    '  prefix=str(page["ordinal"]).zfill(5)+"."; name=next(n for n in archive.namelist() if n.startswith(prefix)); data=archive.read(name)',
    '  assert len(data)==page["renderedBytes"] and hashlib.sha256(data).hexdigest()==page["sha256"]',
    ' print(json.dumps({"archive_pages":len(report["pages"]),"all_page_hashes_match":True,"manifest_complete":manifest["complete"]}))',
  ].join('\n'),out],{encoding:'utf8'});
  assert.equal(verified.status,0,verified.stderr);summary.archiveVerification=JSON.parse(verified.stdout.trim());
  await writeFile(path.join(out,'report.json'),JSON.stringify({...result,summary},null,2));
  await page.screenshot({path:path.join(out,'contact-sheet.png'),fullPage:true});
  for(const ordinal of new Set([1,Math.floor(inputs.length/2)+1,inputs.length])){
    const sample=result.pages.find(item=>item.ordinal===ordinal),extension={'image/png':'png','image/webp':'webp','image/jpeg':'jpg'}[sample.mime],name=String(ordinal).padStart(5,'0');
    const bytes=await readFile(path.join(out,name+'.'+extension));
    await page.setContent('<!doctype html><title>Composed page '+name+'</title><body style="margin:20px;background:#ddd;font:18px system-ui"><p>Composed page '+name+'</p><img style="max-width:100%;display:block" src="data:'+sample.mime+';base64,'+bytes.toString('base64')+'">');
    await page.locator('img').evaluate(image=>image.decode());
    await page.screenshot({path:path.join(out,'view-'+name+'.png'),fullPage:true});
  }
  console.log(JSON.stringify({summary},null,2));
}finally{if(!closed)await handle.close();await browser.close();}
