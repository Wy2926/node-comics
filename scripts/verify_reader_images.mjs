// Vite :5181. Native PNG loading with controlled decode outcomes and DOM load delivery.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',out=path.resolve('artifacts/reader-images');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1180,height:850}}),errors=[],checks=[],samples=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
await page.addInitScript(()=>{
  const live=new Map(),blobKeys=new WeakMap(),urls=[],decodes=[],events=[],heldDom=new Map(),heldDecodes=new Map();
  let nextDecode='normal',nextDomKey='',sequence=0;
  const get=IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get=function(key){
    const request=get.call(this,key);
    if(this.name==='objects'&&typeof key==='string'&&key.startsWith('inline-original:reader-images-'))request.addEventListener('success',()=>{if(request.result instanceof Blob)blobKeys.set(request.result,key);});
    return request;
  };
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=function(blob){const url=create.call(this,blob),key=blobKeys.get(blob);live.set(url,key);urls.push({type:'create',url,key});return url;};
  URL.revokeObjectURL=function(url){urls.push({type:'revoke',url,key:live.get(url)});live.delete(url);return revoke.call(this,url);};
  for(const type of ['load','error'])document.addEventListener(type,event=>{
    const target=event.target;if(!(target instanceof HTMLImageElement))return;
    events.push({type,url:target.src,key:live.get(target.src),className:target.className,trusted:event.isTrusted});
    if(type==='load'&&target.classList.contains('nc-page-image-pending')&&nextDomKey&&live.get(target.src)===nextDomKey){
      nextDomKey='';heldDom.set(target.src,target);event.stopImmediatePropagation();
    }
  },true);
  const decode=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=function(){
    const image=this,mode=nextDecode;nextDecode='normal';
    const entry={id:++sequence,url:image.src,key:live.get(image.src),mode,status:'pending',ready:false,loadBeforeReject:false};decodes.push(entry);
    if(mode==='reject-after-load')return new Promise((resolve,reject)=>{
      const fail=()=>{entry.status='rejected';reject(new DOMException('Synthetic decode cache pressure','EncodingError'));};
      const loaded=()=>{entry.loadBeforeReject=true;entry.ready=image.naturalWidth>0;queueMicrotask(fail);};
      image.addEventListener('load',loaded,{once:true});image.addEventListener('error',fail,{once:true});
      if(image.complete&&image.naturalWidth)loaded();
    });
    if(mode==='deferred')return new Promise((resolve,reject)=>{
      const held={entry,resolve:()=>{entry.status='resolved';resolve();},reject:()=>{entry.status='rejected';reject(new DOMException('Late decode rejection','EncodingError'));}};
      heldDecodes.set(entry.id,held);
      void decode.call(image).then(()=>{entry.ready=true;},error=>{entry.status='native-rejected';reject(error);});
    });
    return decode.call(image).then(()=>{entry.ready=true;entry.status='resolved';},error=>{entry.status='rejected';entry.error=error.name;throw error;});
  };
  window.readerImageTest={
    armDecode(mode){nextDecode=mode;},
    holdDom(key){nextDomKey=key;},
    releaseDom(url){const target=heldDom.get(url);if(!target)throw Error('No held DOM image');heldDom.delete(url);target.dispatchEvent(new Event('load'));},
    breakDom(url){const target=heldDom.get(url);if(!target)throw Error('No held DOM image');heldDom.delete(url);target.src='data:image/png;base64,AA==';},
    releaseDecode(id,reject=false){const held=heldDecodes.get(id);if(!held)throw Error('No held decode');heldDecodes.delete(id);reject?held.reject():held.resolve();},
    metrics(){return {live:[...live].map(([url,key])=>({url,key})),urls,decodes,events,heldDom:[...heldDom.keys()]};}
  };
});
const key=kind=>`inline-original:reader-images-${kind}`;
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const metrics=()=>page.evaluate(()=>window.readerImageTest.metrics());
const shown=()=>page.getByTestId('shown').textContent().then(JSON.parse);
const history=()=>page.getByTestId('history').textContent().then(JSON.parse);
const actualImage=()=>page.locator('.nc-page-image').evaluate(image=>({url:image.src,width:image.naturalWidth,height:image.naturalHeight,job:image.dataset.resultJob}));
async function displayed(kind,scope='scope-a'){
  await page.waitForFunction(({key,scope})=>{
    const output=document.querySelector('[data-testid="shown"]');if(!output)return false;
    const shown=JSON.parse(output.textContent),image=document.querySelector('.nc-page-image');
    return shown?.key===key&&shown.scope===scope&&image?.complete&&image.naturalWidth===320&&image.naturalHeight===480&&!document.querySelector('.nc-page-image-pending');
  },{key:key(kind),scope});await settle();
}
async function liveCount(count){await page.waitForFunction(count=>window.readerImageTest.metrics().live.length===count,count);}
async function heldDom(){await page.waitForFunction(()=>window.readerImageTest.metrics().heldDom.length===1);return (await metrics()).heldDom[0];}
async function heldDecode(){await page.waitForFunction(()=>window.readerImageTest.metrics().decodes.at(-1)?.mode==='deferred'&&window.readerImageTest.metrics().decodes.at(-1)?.ready);return (await metrics()).decodes.at(-1);}
async function sample(label){const value={label,shown:await shown(),images:await page.locator('.nc-page-image').count(),pendingImages:await page.locator('.nc-page-image-pending').count(),liveUrls:(await metrics()).live.length};samples.push(value);return value;}
async function unchanged(expected,url){assert.deepEqual(await shown(),expected);assert.equal((await actualImage()).url,url);assert((await metrics()).live.some(item=>item.url===url));}
try{
  await page.goto(origin+'/tests/reader-images-fixture.html');await displayed('original');await liveCount(1);
  const original=await actualImage(),originalIdentity=await shown();assert.equal(original.job,'original');
  checks.push('Native PNG predecode and actual DOM load commit the original identity');await sample('normal-original');

  const createdBefore=(await metrics()).urls.filter(item=>item.type==='create').length;
  await page.evaluate(key=>{window.readerImageTest.armDecode('reject-after-load');window.readerImageTest.holdDom(key);},key('translated'));
  await page.getByTestId('translated').click();const translatedUrl=await heldDom();
  const failedDecode=(await metrics()).decodes.at(-1);
  assert.equal(failedDecode.mode,'reject-after-load');assert.equal(failedDecode.status,'rejected');assert.equal(failedDecode.loadBeforeReject,true);assert.equal(failedDecode.url,translatedUrl);
  assert.equal((await metrics()).urls.filter(item=>item.type==='create').length-createdBefore,1);
  await unchanged(originalIdentity,original.url);assert.equal(await page.locator('.nc-image-failure').count(),0);await liveCount(2);await sample('fallback-awaits-dom');
  await page.evaluate(url=>window.readerImageTest.releaseDom(url),translatedUrl);await displayed('translated');await liveCount(1);
  assert.equal((await actualImage()).url,translatedUrl);assert.equal((await actualImage()).job,'reader-images-translated-job');
  checks.push('A native load before EncodingError falls back with the same Blob URL and waits for the actual display element');
  await page.screenshot({path:path.join(out,'fallback-translated.png')});

  const translated=await actualImage(),translatedIdentity=await shown(),historyBefore=(await history()).length;
  await page.evaluate(key=>window.readerImageTest.holdDom(key),key('original'));await page.getByTestId('original').click();const pendingOriginal=await heldDom();
  await unchanged(translatedIdentity,translated.url);await liveCount(2);
  await page.evaluate(url=>window.readerImageTest.breakDom(url),pendingOriginal);
  await page.locator('.nc-image-failure.over-image').waitFor();await liveCount(1);await settle();
  await unchanged(translatedIdentity,translated.url);assert.equal((await history()).length,historyBefore);
  assert((await metrics()).events.some(event=>event.type==='error'&&event.className==='nc-page-image-pending'&&event.trusted));
  checks.push('A real candidate DOM image error retains the prior image, URL and onShown identity');await sample('candidate-dom-error');
  await page.screenshot({path:path.join(out,'candidate-error-keeps-translation.png')});
  await page.locator('.nc-image-failure').getByRole('button',{name:'重试',exact:true}).click();await displayed('original');await liveCount(1);
  checks.push('Retry after a display-element failure replaces the retained image and clears the error');

  const recovered=await actualImage(),recoveredIdentity=await shown();await page.getByTestId('broken').click();
  await page.locator('.nc-image-failure.over-image').waitFor();await liveCount(1);await unchanged(recoveredIdentity,recovered.url);
  assert((await metrics()).decodes.some(entry=>entry.key===key('broken')&&entry.status==='rejected'&&entry.error==='EncodingError'));
  checks.push('A genuinely corrupt PNG remains an error while the previous successful image stays available');await sample('corrupt-with-original');
  await page.getByTestId('mount').click();await liveCount(0);assert.equal(await shown(),null);
  await page.getByTestId('mount').click();await page.locator('.nc-image-failure:not(.over-image)').waitFor();await liveCount(0);assert.equal(await shown(),null);assert.equal(await page.locator('.nc-page-image').count(),0);
  checks.push('A corrupt initial image is never reported as displayed and does not retain a Blob URL');
  await page.getByTestId('original').click();await displayed('original');await liveCount(1);

  await page.evaluate(()=>window.readerImageTest.armDecode('deferred'));await page.getByTestId('translated').click();const staleKey=await heldDecode();
  await page.getByTestId('original').click();await displayed('original');await liveCount(1);const currentOriginal=await actualImage(),currentIdentity=await shown();
  assert(!(await metrics()).live.some(item=>item.url===staleKey.url));
  await page.evaluate(id=>window.readerImageTest.releaseDecode(id),staleKey.id);await settle();await unchanged(currentIdentity,currentOriginal.url);
  assert.equal(await page.locator('.nc-image-failure').count(),0);
  checks.push('Rapid key changes revoke cancelled candidates and ignore a late successful decode');await sample('cancelled-key');

  await page.evaluate(()=>window.readerImageTest.armDecode('deferred'));await page.getByTestId('translated').click();const staleScope=await heldDecode();
  const scopeHistoryStart=(await history()).length;await page.getByTestId('scope-b').click();await displayed('translated','scope-b');await liveCount(1);
  const scopeImage=await actualImage(),scopeIdentity=await shown();assert(!(await metrics()).live.some(item=>item.url===staleScope.url));
  await page.evaluate(id=>window.readerImageTest.releaseDecode(id,true),staleScope.id);await settle();await unchanged(scopeIdentity,scopeImage.url);
  assert(!(await history()).slice(scopeHistoryStart).some(item=>item?.scope==='scope-a'&&item.key===key('translated')));
  assert.equal(await page.locator('.nc-image-failure').count(),0);
  checks.push('A scope change ignores a late rejected decode and only commits the new scope');await sample('cancelled-scope');

  await page.evaluate(key=>window.readerImageTest.holdDom(key),key('original'));await page.getByTestId('original').click();const staleDom=await heldDom();
  await page.getByTestId('scope-a').click();await displayed('original');await liveCount(1);const currentScope=await actualImage(),currentScopeIdentity=await shown();
  await page.evaluate(url=>window.readerImageTest.releaseDom(url),staleDom);await settle();await unchanged(currentScopeIdentity,currentScope.url);
  checks.push('A detached candidate DOM load cannot replace a newer scope');

  await page.locator('.nc-page-image').evaluate(image=>{image.src='data:image/png;base64,AA==';});
  await page.locator('.nc-image-failure:not(.over-image)').waitFor();await liveCount(0);await settle();assert.equal(await shown(),null);
  assert((await metrics()).events.some(event=>event.type==='error'&&event.className==='nc-page-image'&&event.trusted));
  await page.locator('.nc-image-failure').getByRole('button',{name:'重试',exact:true}).click();await displayed('original');await liveCount(1);
  checks.push('A real error on the displayed element clears its identity and URL; retry restores the original');
  await page.screenshot({path:path.join(out,'recovered-original.png')});
  await page.evaluate(()=>window.readerImageTest.armDecode('deferred'));await page.getByTestId('translated').click();const closingDecode=await heldDecode();await liveCount(2);
  await page.getByTestId('mount').click();await liveCount(0);await settle();assert.equal(await shown(),null);assert.equal(await page.locator('section img').count(),0);
  await page.evaluate(id=>window.readerImageTest.releaseDecode(id),closingDecode.id);await settle();await liveCount(0);assert.equal(await shown(),null);assert.equal(await page.locator('section img').count(),0);
  checks.push('Closing during decode clears onShown, releases every Blob URL and ignores a late completion');await sample('closed');assert.deepEqual(errors,[]);
  const report={checks,errors,samples,metrics:await metrics(),browser:await browser.version(),synthetic:true,nativePngLoading:true,controlledDecodeRejection:true,controlledDomLoadDelivery:true,externalServices:false};
  await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,checks,errors,samples}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors,checks,samples,metrics:await metrics()},null,2));throw error;}finally{await browser.close();}
