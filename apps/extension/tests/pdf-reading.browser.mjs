// Vite on 127.0.0.1:5181; real local import, PDF.js, Reader and storage. No external services.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,readFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
const require=createRequire(import.meta.url),{PDFDocument,StandardFonts,PDFName,degrees,setTextRenderingMode}=require('pdf-lib');
const engine=process.env.PDF_BROWSER||'chromium';
const engines=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',out=new URL('../../../artifacts/pdf-reading/',import.meta.url);
const launchOptions={headless:true,...engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}};
let browser,fixture;
before(async()=>{
  await mkdir(out,{recursive:true});
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=0;n<4;n++){
    const page=pdf.addPage([300,500]);
    page.drawText(`Synthetic PDF - page ${n+1}`,{x:15,y:465,size:18,font});
    for(let y=430;y>30;y-=18)page.drawText('Small vector text 0123456789 ABCDEFGHIJKLMNOP',{x:15,y,size:7,font});
  }
  fixture=Buffer.from(await pdf.save());
  browser=await engines[engine].launch(launchOptions);
});
after(async()=>{await browser?.close();});

for(const dpr of [1,2])test(`PDF reading at DPR ${dpr} keeps translation bytes stable through zoom, failure and reopen`,async()=>{
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:dpr,reducedMotion:'reduce',locale:'zh-CN'});
  page.setDefaultTimeout(15000);
  const errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).origin===origin)return route.continue();
    external.push(route.request().url());return route.fulfill({status:503,contentType:'application/json',body:'{}'});
  });
  await page.addInitScript(()=>{
    Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});
    localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single',readerZoom:100,readerImmersive:false}));
    const toBlob=HTMLCanvasElement.prototype.toBlob;
    window.pdfMetrics={rasters:[],failNext:false};
    HTMLCanvasElement.prototype.toBlob=function(done,...args){
      if(this.width>500&&args[0]==='image/png'){
        window.pdfMetrics.rasters.push({width:this.width,height:this.height});
        if(window.pdfMetrics.failNext){window.pdfMetrics.failNext=false;done(null);return;}
      }
      return toBlob.call(this,done,...args);
    };
  });
  const images=()=>page.locator('.nc-page-image');
  const settings=()=>page.getByRole('dialog',{name:'阅读设置',exact:true});
  const openSettings=async()=>{await page.keyboard.press('Escape');await page.getByRole('button',{name:'阅读设置',exact:true}).click();};
  const closeSettings=async()=>settings().getByRole('button',{name:'关闭面板',exact:true}).click();
  const raster=()=>images().first().evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight,css:img.getBoundingClientRect().width,src:img.src}));
  const sharp=async()=>page.waitForFunction(()=>[...document.querySelectorAll('.nc-page-image')].length>0&&[...document.querySelectorAll('.nc-page-image')].every(img=>img.naturalWidth>=Math.min(img.getBoundingClientRect().width*devicePixelRatio,Math.sqrt(16*1024*1024*300/500))-2));
  const stable=()=>page.evaluate(async()=>{
    const {catalog}=await import('/src/comics/repositories/index.ts');
    const {acquirePage}=await import('/src/comics/pages/service.ts');
    const {pageRenderProfile}=await import('/src/comics/pages/identity.ts');
    const {prepareTranslationInput}=await import('/src/translation/input/prepare.ts');
    const [entry]=await catalog.list('entries'),[descriptor]=await catalog.listPages(entry.contentId,{limit:1});
    const lease=await acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:descriptor.pageId,renderProfileId:pageRenderProfile(entry.format),purpose:'translation'});
    try{
      const identity=lease.identity;
      const input=await prepareTranslationInput({id:descriptor.pageId,name:'PDF',width:identity.width,height:identity.height,imageSha256:identity.imageSha256,imageByteSize:identity.byteSize,imageMime:identity.mime},async()=>lease.blob,()=>true);
      return {sha:identity.imageSha256,width:identity.width,height:identity.height,input:input.image,profile:identity.renderProfileId};
    }finally{lease.release();}
  });
  try{
    await page.goto(origin);await page.locator('input[type=file]').setInputFiles({name:'PDF reading fixture.pdf',mimeType:'application/pdf',buffer:fixture});
    await sharp();const initial=await raster(),canonical=await stable();
    assert.equal(canonical.width,600);assert.equal(canonical.height,1000);
    assert(initial.width>canonical.width);
    // Upcoming pages must already use display pixels; turning should consume those same renders.
    await page.waitForFunction(width=>window.pdfMetrics.rasters.filter(r=>r.width===width).length===4,initial.width);
    const prepared=await page.evaluate(()=>window.pdfMetrics.rasters.length);
    await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.nc-manga-page')?.dataset.pageIndex==='1');await sharp();
    assert.equal(await page.evaluate(()=>window.pdfMetrics.rasters.length),prepared);
    await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('.nc-manga-page')?.dataset.pageIndex==='0');await sharp();
    await page.screenshot({path:new URL(`${engine}-${dpr}-initial.png`,out).pathname});
    await openSettings();
    for(let n=0;n<4;n++)await settings().getByRole('button',{name:'放大',exact:true}).click();
    await closeSettings();await sharp();const enlarged=await raster();assert(enlarged.width>initial.width);
    assert.deepEqual(await stable(),canonical);
    await page.screenshot({path:new URL(`${engine}-${dpr}-zoom.png`,out).pathname});
    // A failed higher-resolution replacement must retain the old readable image.
    await page.waitForFunction(width=>window.pdfMetrics.rasters.filter(r=>r.width===width).length>=4,enlarged.width);
    await openSettings();await page.evaluate(()=>{window.pdfMetrics.failNext=true;});
    await settings().getByRole('button',{name:'放大',exact:true}).click();await closeSettings();
    await page.locator('.nc-image-failure.over-image').waitFor();assert.equal((await raster()).src,enlarged.src);
    await page.locator('.nc-image-failure').getByRole('button',{name:'重试',exact:true}).click();await sharp();
    await page.locator('.nc-image-failure').waitFor({state:'hidden'});
    await openSettings();await settings().getByRole('group',{name:'阅读布局',exact:true}).getByRole('button',{name:'双页',exact:true}).click();await closeSettings();
    await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelectorAll('.nc-page-image').length===2);await sharp();
    await openSettings();for(let n=0;n<5;n++)await settings().getByRole('button',{name:'放大',exact:true}).click();await closeSettings();await sharp();
    await page.screenshot({path:new URL(`${engine}-${dpr}-double.png`,out).pathname});
    await openSettings();await settings().getByRole('group',{name:'阅读布局',exact:true}).getByRole('button',{name:'连续',exact:true}).click();await closeSettings();await sharp();
    const neighbor=page.locator('.nc-manga-page').nth(1),neighborId=await neighbor.getAttribute('data-page-id'),neighborSrc=await neighbor.locator('.nc-page-image').getAttribute('src');
    await neighbor.evaluate(element=>{const viewport=document.querySelector('.nc-reading-viewport');viewport.scrollTop+=element.getBoundingClientRect().top-viewport.getBoundingClientRect().top+1;});
    await page.waitForFunction(id=>document.querySelector('.nc-manga-page')?.dataset.pageId===id,neighborId);await sharp();
    assert.equal(await images().first().getAttribute('src'),neighborSrc);
    await page.locator('.nc-reading-viewport').evaluate(element=>{element.scrollTop+=250;});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const anchor=await page.locator('.nc-manga-page').first().getAttribute('data-page-id');
    const offset=await page.locator('.nc-manga-page').first().evaluate(element=>element.getBoundingClientRect().top);
    await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    await page.getByRole('button',{name:'打开漫画 PDF reading fixture',exact:true}).click();await sharp();
    assert.equal(await page.locator('.nc-manga-page').first().getAttribute('data-page-id'),anchor);
    assert(Math.abs(await page.locator('.nc-manga-page').first().evaluate(element=>element.getBoundingClientRect().top)-offset)<2);
    if(engine==='chromium'&&dpr===1){
      const before=await raster(),cdp=await page.context().newCDPSession(page);
      // Chromium's emulated DPR alone emits no resize; change the viewport too, as when moving screens.
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1281,height:900,deviceScaleFactor:2,mobile:false});
      await page.waitForFunction(()=>devicePixelRatio===2);await sharp();assert((await raster()).width>before.width);
    }
    // The ordinary export action for an original PDF saves the source, with no redundant format picker.
    await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    await page.getByRole('button',{name:'打开漫画 PDF reading fixture',exact:true}).click({button:'right'});
    await page.getByRole('menuitem',{name:'导出漫画',exact:true}).click();
    const panel=page.getByRole('dialog',{name:'导出漫画'});
    assert.equal(await panel.getByRole('combobox',{name:'文件格式',exact:true}).count(),0);
    const beforeExport=await page.evaluate(()=>window.pdfMetrics.rasters.length);
    const download=page.waitForEvent('download');await panel.getByRole('button',{name:'保存完整源文件',exact:true}).click();
    const saved=await download;assert.equal(await saved.failure(),null);assert.equal(saved.suggestedFilename(),'PDF reading fixture.pdf');
    assert.deepEqual(await readFile(await saved.path()),fixture);
    assert.equal(await page.evaluate(()=>window.pdfMetrics.rasters.length),beforeExport);
    await page.screenshot({path:new URL(`${engine}-${dpr}-export.png`,out).pathname});
    assert.deepEqual(await stable(),canonical);assert.deepEqual(errors,[]);
    assert(!external.some(url=>/\/v1\/(?:guest\/)?translations(?:\/|\?|$)/.test(url)));
  }catch(error){
    console.error(await page.evaluate(()=>({dpr:devicePixelRatio,layout:document.querySelector('.nc-reading-viewport')?.dataset.layout,
      images:[...document.querySelectorAll('.nc-page-image')].map(img=>({width:img.naturalWidth,css:img.getBoundingClientRect().width,page:img.closest('.nc-manga-page')?.dataset.pageIndex})),metrics:window.pdfMetrics,errors:[...document.querySelectorAll('.nc-image-failure')].map(node=>node.textContent)})));
    await page.screenshot({path:new URL(`${engine}-${dpr}-failure.png`,out).pathname});throw error;
  }
  finally{await page.close();}
});

test('extracts original JPEG bytes, skips composition, and uploads the untouched image for enhancement',async()=>{
  // WebKit's ephemeral data store cannot persist Blob receipts; use an isolated real profile.
  const profileDir=await mkdtemp(new URL(`${engine}-enhancement-profile-`,out).pathname);
  const context=await engines[engine].launchPersistentContext(profileDir,{...launchOptions,viewport:{width:1280,height:900},reducedMotion:'reduce',locale:'zh-CN'});
  const page=await context.newPage(),errors=[],uploads=[];
  let receiver,serviceOrigin;
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single',readerZoom:100,readerImmersive:false}));
  });
  await page.route('**/*',route=>[origin,serviceOrigin].includes(new URL(route.request().url()).origin)?route.continue():route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  try{
    await page.goto(origin);
    const data=await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=4000;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,2400,4000);ctx.fillStyle='black';ctx.font='24px sans-serif';
      for(let y=40;y<4000;y+=40)ctx.fillText('Original embedded image - unchanged pixels 0123456789',30,y);
      return {jpeg:canvas.toDataURL('image/jpeg',.9).split(',')[1],png:canvas.toDataURL('image/png').split(',')[1]};
    });
    const jpeg=Buffer.from(data.jpeg,'base64'),pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    const native=await pdf.embedJpg(jpeg),names=[],expected=[];
    const add=(name,image=native,options={})=>{names.push(name);expected.push(name==='native'||name==='invisible OCR');const page=pdf.addPage([300,500]);page.drawImage(image,{x:0,y:0,width:300,height:500,...options});return page;};
    add('native');add('PNG',await pdf.embedPng(Buffer.from(data.png,'base64')));
    add('visible text').drawText('Visible text must remain',{x:10,y:450,size:15,font});
    add('cropped',native,{x:10});
    add('multiple images').drawImage(native,{x:0,y:0,width:30,height:50});
    add('page rotation').setRotation(degrees(90));
    add('transparency',native,{opacity:.5});
    const masked=await pdf.embedJpg(jpeg);await masked.embed();pdf.context.lookup(masked.ref).dict.set(PDFName.of('Mask'),pdf.context.obj([0,0,0,0,0,0]));add('mask',masked);
    const ocr=add('invisible OCR');ocr.pushOperators(setTextRenderingMode(3));ocr.drawText('Searchable invisible OCR',{x:10,y:450,size:15,font});
    const exif=Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000','hex');
    add('EXIF',await pdf.embedJpg(Buffer.concat([jpeg.subarray(0,2),exif,jpeg.subarray(2)])));
    const embedded=await pdf.embedPage(pdf.getPage(0));const form=pdf.addPage([300,500]);form.drawPage(embedded);names.push('form');expected.push(false);
    const bytes=Buffer.from(await pdf.save()),sha=createHash('sha256').update(jpeg).digest('hex');
    const report=await page.evaluate(async({bytes})=>{
      const {openPdfDocument}=await import('/src/comics/formats/pdf.ts');let encodes=0;
      const toBlob=HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob=function(...args){encodes++;return toBlob.apply(this,args);};
      const data=new Uint8Array(bytes),source={snapshot:{identity:'native-fixture',version:'1',size:data.length,local:true},async readAt(offset,length){return data.slice(offset,offset+length);},async validate(){return 'unchanged';},async close(){}};
      const session=await openPdfDocument(source),results=[];
      try{
        for(const descriptor of await session.index()){
          const blob=await session.originalImage(descriptor);
          results.push(blob?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join(''):null);
        }
        const controller=new AbortController();controller.abort();
        try{await session.originalImage((await session.index())[0],controller.signal);throw Error('Cancellation was ignored');}catch(error){if(error.name!=='AbortError')throw error;}
        return {results,encodes};
      }finally{await session.close();HTMLCanvasElement.prototype.toBlob=toBlob;}
    },{bytes:[...bytes]});
    assert.deepEqual(report.results,expected.map(yes=>yes?sha:null),JSON.stringify(names));assert.equal(report.encodes,0);
    // Inspect the bytes received by HTTP, not the browser debugger's multipart representation.
    receiver=createServer(async(req,res)=>{
      res.setHeader('Access-Control-Allow-Origin',origin);
      if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'POST'});res.end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      const boundary=/boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type']??'');
      const header=body.indexOf('name="file"'),start=body.indexOf('\r\n\r\n',header)+4,end=body.indexOf('\r\n--'+(boundary?.[1]??boundary?.[2]),start);
      uploads.push(createHash('sha256').update(header>=0&&end>=start?body.subarray(start,end):Buffer.alloc(0)).digest('hex'));
      res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(jpeg);
    });
    receiver.listen(0,'127.0.0.1');await once(receiver,'listening');serviceOrigin='http://127.0.0.1:'+receiver.address().port;
    await page.evaluate(async url=>{
      const {saveProcessingProfile,updateProcessingSettings}=await import('/src/image-processing/settings.ts');
      await saveProcessingProfile('nunif','Synthetic enhancement',{url});
      await updateProcessingSettings(value=>({...value,enabled:true}));
    },serviceOrigin);
    await page.locator('input[type=file]').setInputFiles({name:'Embedded image fixture.pdf',mimeType:'application/pdf',buffer:bytes});
    await page.waitForFunction(()=>document.querySelector('.nc-page-image')?.naturalWidth===2400);
    assert.deepEqual(uploads,[sha]);
    await page.screenshot({path:new URL(`${engine}-embedded-enhanced.png`,out).pathname});
    await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.nc-manga-page')?.dataset.pageIndex==='1'&&document.querySelector('.nc-page-image')?.naturalWidth>0&&!document.querySelector('.nc-enhancement-status'));
    assert.deepEqual(uploads,[sha]);assert.deepEqual(errors,[]);
  }catch(error){
    console.error(JSON.stringify({errors,uploads:uploads.length,view:await page.evaluate(()=>({images:[...document.querySelectorAll('.nc-page-image')].map(img=>({width:img.naturalWidth,height:img.naturalHeight})),status:[...document.querySelectorAll('.nc-enhancement-status,.nc-image-failure')].map(node=>node.textContent)}))}));
    await page.screenshot({path:new URL(`${engine}-embedded-failure.png`,out).pathname});throw error;
  }finally{await context.close();receiver?.closeAllConnections();if(receiver)await new Promise(resolve=>receiver.close(resolve));await rm(profileDir,{recursive:true,force:true});}
});
