// Build backend/website, then start manual_website_translation_server.py --port 4323.
// Native Chromium + loopback synthetic API only; never sends paid-provider requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.WEBSITE_TRANSLATION_URL||'http://127.0.0.1:4323';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Only the loopback fixture is allowed');
const out=path.resolve('artifacts/website-translation-tiles');
const sources=path.resolve('artifacts/website-translation');
const python=process.env.PYTHON||path.resolve('backend/.venv/Scripts/python.exe');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH});
const checks=[],errors=[],scenarios=[];
const check=message=>{checks.push(message);console.log('PASS '+message);};
async function control(value){const response=await fetch(origin+'/__state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});assert(response.ok);return response.json();}
async function state(){const response=await fetch(origin+'/__state');assert(response.ok);return response.json();}
async function records(page){return page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('nc-website-translations-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{return await new Promise((resolve,reject)=>{const request=db.transaction('records').objectStore('records').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  finally{db.close();}
});}
async function ready(page){await page.locator('.image-dropzone button').waitFor();await page.waitForFunction(()=>!document.querySelector('.image-dropzone button')?.disabled);}
async function add(page,name){await ready(page);await page.locator('.image-dropzone input[type="file"]').setInputFiles(path.join(sources,name+'-source.png'));await page.locator('.record-copy strong').filter({hasText:name+'-source.png'}).waitFor();}
async function start(page,name){await add(page,name);await page.getByRole('button',{name:'开始翻译',exact:true}).click();}
async function waitState(page,wanted){await page.waitForFunction(value=>document.querySelector('.translation-records li')?.getAttribute('data-state')===value,wanted,{timeout:60000});}
async function oneRecord(page){const rows=await records(page);assert.equal(rows.length,1);return rows[0];}
async function downloadAndCompare(page,row,label){
  const item=page.locator('.translation-records li').filter({has:page.getByText(row.name,{exact:true})});
  const [download]=await Promise.all([page.waitForEvent('download'),item.getByRole('button',{name:'下载完整译图',exact:true}).click()]);
  const downloaded=path.join(out,label+path.extname(download.suggestedFilename()));await download.saveAs(downloaded);
  const expected=path.join(out,label+'-expected.png'),response=await fetch(origin+'/__expected/'+row.requestId);assert(response.ok);await writeFile(expected,Buffer.from(await response.arrayBuffer()));
  const result=JSON.parse(execFileSync(python,['-c',String.raw`
from PIL import Image, ImageChops
import json, sys
with Image.open(sys.argv[1]) as actual, Image.open(sys.argv[2]) as expected:
    assert actual.size == expected.size, (actual.size, expected.size)
    with actual.convert('RGBA') as left, expected.convert('RGBA') as right:
        with ImageChops.difference(left, right) as difference:
            assert difference.getbbox(alpha_only=False) is None, 'Complete-image pixels differ'
    print(json.dumps({'width': actual.width, 'height': actual.height, 'format': actual.format, 'exactPixels': True}))
`,downloaded,expected],{encoding:'utf8'}));
  assert.deepEqual([result.width,result.height],[row.width,row.height]);return result;
}
async function scenario(name,config,run){
  await control({reset:true,...config});
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push({scenario:name,message:error.message}));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  try{
    await page.goto(origin+'/translate/');await ready(page);await run(page);
    scenarios.push({name,state:await state(),records:await records(page)});
  }catch(error){
    await page.screenshot({path:path.join(out,name+'-failure.png')}).catch(()=>{});
    await writeFile(path.join(out,'failure.json'),JSON.stringify({scenario:name,error:error.stack,checks,errors,state:await state(),records:await records(page).catch(()=>[])},null,2));throw error;
  }finally{await context.close();}
}

try{
  await scenario('wide',{},async page=>{
    await start(page,'wide');await waitState(page,'succeeded');
    const row=await oneRecord(page),before=await state();
    assert.equal(row.resultFormat,'overlay-tiles-v1');assert.equal(row.snapshot.result.representation,'overlay-tiles-v1');
    assert.equal(before.admitted_requests[row.requestId].result_format,'overlay-tiles-v1');
    assert.deepEqual([row.width,row.height],[100000,64]);
    assert.equal(await page.locator('.translation-workbench img, .translation-canvas').count(),0);
    const image=await downloadAndCompare(page,row,'wide');assert.equal(image.format,'PNG');
    check('100000x64 classic negotiates tiles and downloads an exact full PNG across the 2048px lettering boundary');
    await page.reload();await ready(page);await waitState(page,'succeeded');
    const restored=await oneRecord(page);assert.equal(restored.requestId,row.requestId);
    await downloadAndCompare(page,restored,'wide-history');const after=await state();
    assert.equal(after.create_calls,before.create_calls);assert.equal(after.result_calls,before.result_calls);assert.equal(after.get_calls,before.get_calls);
    await page.screenshot({path:path.join(out,'wide-history-screen.png')});
    check('hard refresh restores the complete local image and download without create, GET, or result refetch');
  });

  await scenario('long-result-recovery',{result_failure_once:true},async page=>{
    await start(page,'long');await waitState(page,'paused');
    const paused=await oneRecord(page);assert.equal(paused.snapshot.state,'succeeded');assert.equal(paused.resultFormat,'overlay-tiles-v1');
    const before=await state();assert.equal(before.create_calls,1);assert.equal(before.result_calls,1);
    await control({tiles_enabled:false,max_dimension:16000});await page.reload();await ready(page);await waitState(page,'succeeded');
    const row=await oneRecord(page),after=await state();assert.equal(row.requestId,paused.requestId);assert.equal(row.resultFormat,'overlay-tiles-v1');
    assert.equal(after.create_calls,1);assert.equal(after.get_calls,before.get_calls+1);assert.equal(after.result_calls,2);
    await downloadAndCompare(page,row,'long');
    await page.screenshot({path:path.join(out,'long-cross-tile.png')});
    check('64x100000 result-download interruption resumes the same UUID despite missing tiles capability and a smaller limit; all 4096px seam pixels match');
  });

  await scenario('lost-acceptance',{fail_create_response_once:true},async page=>{
    await start(page,'wide');await waitState(page,'paused');
    const frozen=await oneRecord(page),before=await state();assert.equal(frozen.resultFormat,'overlay-tiles-v1');assert.equal(before.accepted,1);
    await control({tiles_enabled:false,max_dimension:16000});await page.reload();await ready(page);await waitState(page,'succeeded');
    const resumed=await oneRecord(page),after=await state();assert.equal(resumed.requestId,frozen.requestId);
    assert.equal(resumed.sha256,frozen.sha256);assert.equal(resumed.resultFormat,frozen.resultFormat);
    assert.equal(after.create_calls,1);assert.equal(after.accepted,1);assert.equal(after.input_calls,1);
    assert.deepEqual(after.request_log.filter(value=>value.id===frozen.requestId).map(value=>value.operation).slice(0,4),['get','create','get','input']);
    await downloadAndCompare(page,resumed,'lost-acceptance');
    check('lost accepted response recovers by GET on the same frozen tile UUID and does not submit or charge twice');
  });

  await scenario('missing-before-acceptance',{fail_before_accept_once:true},async page=>{
    await start(page,'long');await waitState(page,'paused');const frozen=await oneRecord(page);assert.equal((await state()).accepted,0);
    await control({tiles_enabled:false,max_dimension:16000});await page.reload();await ready(page);await waitState(page,'succeeded');
    const row=await oneRecord(page),after=await state();assert.equal(row.requestId,frozen.requestId);assert.equal(row.sha256,frozen.sha256);
    assert.equal(after.create_calls,2);assert.equal(after.accepted,1);assert.equal(after.admitted_requests[row.requestId].result_format,'overlay-tiles-v1');
    assert.deepEqual(after.request_log.filter(value=>value.id===row.requestId).map(value=>value.operation).slice(0,5),['get','create','get','create','input']);
    check('only GET 404 permits replay, with the same UUID, image digest and frozen tiles request after capabilities change');
  });

  await scenario('capability-absent',{tiles_enabled:false},async page=>{
    await start(page,'long');await waitState(page,'failed');const blocked=await oneRecord(page),before=await state();
    assert.equal(blocked.requestId,undefined);assert.equal(before.create_calls,0);assert.equal(before.input_calls,0);assert.equal(before.accepted,0);
    check('a fresh long classic input without advertised tile support creates zero remote tasks');
    await start(page,'ordinary');await waitState(page,'succeeded');
    const row=(await records(page)).find(value=>value.name==='ordinary-source.png'),after=await state();assert(row);
    assert.equal(row.resultFormat,undefined);assert.equal(row.snapshot.result.representation,'overlay-v1');assert.equal(after.admitted_requests[row.requestId].result_format,undefined);
    await downloadAndCompare(page,row,'ordinary');
    await page.screenshot({path:path.join(out,'ordinary-screen.png')});
    check('ordinary classic images still succeed with overlay-v1 when the capabilities representation field is absent');
  });

  await scenario('legacy-ordinary',{tiles_enabled:false,fail_create_response_once:true},async page=>{
    await start(page,'ordinary');await waitState(page,'paused');const frozen=await oneRecord(page);assert.equal(frozen.resultFormat,undefined);
    await control({tiles_enabled:true});await page.reload();await ready(page);await waitState(page,'succeeded');
    const row=await oneRecord(page),after=await state();assert.equal(row.requestId,frozen.requestId);assert.equal(row.resultFormat,undefined);
    assert.equal(after.create_calls,1);assert.equal(after.admitted_requests[row.requestId].result_format,undefined);assert.equal(row.snapshot.result.representation,'overlay-v1');
    check('an existing ordinary UUID without resultFormat remains ordinary after tile capabilities are enabled');
  });

  await scenario('frozen-input-missing',{fail_create_response_once:true},async page=>{
    await start(page,'wide');await waitState(page,'paused');const frozen=await oneRecord(page),before=await state();
    await page.evaluate(async id=>{
      const db=await new Promise(resolve=>{const request=indexedDB.open('nc-website-translations-v1');request.onsuccess=()=>resolve(request.result);});
      try{await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite'),store=tx.objectStore('images'),request=store.get(id);request.onsuccess=()=>{const value=request.result;delete value.input;store.put(value);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
    },frozen.id);
    await page.reload();await ready(page);await page.locator('.translation-alert').waitFor();
    const row=await oneRecord(page),after=await state();assert.equal(row.requestId,frozen.requestId);assert.equal(row.sha256,frozen.sha256);assert.equal(row.inputBytes,frozen.inputBytes);
    assert.equal(after.create_calls,before.create_calls);assert.equal(after.get_calls,before.get_calls);assert.equal(after.input_calls,0);
    check('missing frozen input stops recovery without rebuilding bytes or changing the existing request identity');
  });

  await scenario('batch',{},async page=>{
    await page.locator('.image-dropzone input[type="file"]').setInputFiles(['ordinary','wide'].map(name=>path.join(sources,name+'-source.png')));
    await page.waitForFunction(()=>document.querySelectorAll('.translation-records li').length===2);
    await page.getByRole('button',{name:'开始翻译',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.translation-records li[data-state="succeeded"]').length===2,undefined,{timeout:60000});
    assert.equal(await page.locator('.translation-workbench img, .translation-canvas, input[type="range"]').count(),0);
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'打包下载已完成（ZIP）',exact:true}).click()]);
    const archive=path.join(out,'translations.zip');await download.saveAs(archive);
    const summary=JSON.parse(execFileSync(python,['-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))',archive],{encoding:'utf8'}));
    assert.equal(summary.length,2);assert(summary.every(name=>/\.(png|webp|jpg)$/.test(name)));
    assert.equal((await state()).create_calls,2);
    check('batch uploads two images, completes two distinct tasks and downloads one valid ZIP without previews');
  });
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,scenarios,liveProvider:false,syntheticApi:true},null,2));
  console.log(`PASS ${checks.length} checks; ${out}`);
}finally{await browser.close();}
