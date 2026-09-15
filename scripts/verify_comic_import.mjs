/** Requires generated fixtures, a Vite reader, and tests/manual_ui_server.py.
 * Uses only its isolated localhost:18089 account and synthetic supplier.
 * PLAYWRIGHT_MODULE optionally points to a bundled Playwright installation.
 * TEST_CHROMIUM optionally points to Chromium supporting unpacked extensions.
 */
import {completeLocalImport} from './local_import_helpers.mjs';
import {submitImages} from './submission_helpers.mjs';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts/import-validation');
const api='http://127.0.0.1:18089';
const web=process.env.TEST_READER_URL||'http://127.0.0.1:5174';
const checks=[];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function json(url,options={}) {
  const response=await fetch(api+url,options);
  assert(response.ok,`${url}: ${response.status}`);
  return response.json();
}
const login=await json('/v1/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'import-'+randomUUID().slice(0,8)})});
const auth={Authorization:`Bearer ${login.access_token}`};
const admin=await json('/v1/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin'})});
await json(`/v1/admin/users/${login.user.id}/membership`,{method:'POST',headers:{Authorization:`Bearer ${admin.access_token}`,
  'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({months:1,note:'Isolated import acceptance'})});
const hashes=[];const jobs=[];
for(const name of ['1.png','2.png','10.png']) {
  const bytes=await readFile(path.join(output,name));const hash=sha(bytes);hashes.push(hash);
  const receipt=await submitImages({api,token:login.access_token,images:[{name,bytes,fileHash:hash,pageIndex:0}]});
  jobs.push(receipt.items[0].job);
}
const deadline=Date.now()+60000;
while(true) {
  const result=await json('/v1/jobs/status',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({ids:jobs.map(j=>j.id)})});
  if(result.items.every(j=>j.status==='succeeded'))break;
  assert(Date.now()<deadline,'Synthetic fixture jobs did not finish');
  await new Promise(r=>setTimeout(r,500));
}
const before=await json('/v1/me/usage',{headers:auth});
async function configure(context,loggedIn=true) {
  await context.addInitScript(({session,api,loggedIn})=>{
    if(!localStorage.getItem('nc-settings'))localStorage.setItem('nc-settings',JSON.stringify({apiBase:api,translationMode:'redraw',layout:'single',fit:'window'}));
    if(loggedIn)localStorage.setItem('nc-session',JSON.stringify(session));
  },{session:{token:login.access_token,user:login.user,apiOrigin:api},api,loggedIn});
}
async function copyRecords(page) {
  return page.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('node-comics-library',1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result;const tx=db.transaction(['copies','blobs'],'readonly');
      const copies=tx.objectStore('copies').getAll();const blobs=tx.objectStore('blobs').getAllKeys();
      tx.oncomplete=()=>{resolve({copies:copies.result,blobCount:blobs.result.length});db.close();};
    };
  }));
}
async function importAndRead(context,name,url,{cache=false,label=name}={}) {
  const page=await context.newPage();const errors=[];const requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith(api))requests.push({url:request.url().slice(api.length),method:request.method()});});
  await page.goto(url);
  await page.locator('input[type=file]').setInputFiles(path.join(output,name));
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:name.replace(/\.[^.]+$/,''),exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.getByLabel('跳转页码').waitFor({timeout:30000});
  await page.locator('.nc-page-image').first().waitFor();
  if(cache)await page.waitForFunction(()=>!!document.querySelector('.nc-page-image[data-result-job]:not([data-result-job="original"])'),null,{timeout:30000});
  let records=await copyRecords(page);const bookCount=records.copies.length;const copy=records.copies.sort((a,b)=>b.createdAt-a.createdAt).find(c=>c.title===name.replace(/\.[^.]+$/,''));
  assert(copy,`${label} copy persisted`);assert.equal(copy.pages.length,3);
  assert.deepEqual(copy.pages.map(p=>p.pageIndex),[0,1,2]);
  if(!name.endsWith('.pdf'))assert.deepEqual(copy.pages.map(p=>p.imageSha256),hashes);
  else assert(copy.pages.every(p=>p.width===640&&p.height===960&&p.imageSha256));
  if(cache) {
    for(const p of copy.pages)assert(p.jobs.some(j=>jobs.some(old=>old.id===j.id)),`${label} restored job`);
    assert(!requests.some(r=>(r.method==='POST'&&r.url==='/v1/translation-submissions')||(r.method==='PUT'&&r.url.startsWith('/v1/uploads/'))),'Recovery must not upload or submit');
  }
  const jump=page.getByLabel('跳转页码');await jump.fill('2');await jump.press('Enter');await jump.blur();
  await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='2');
  await page.waitForFunction(id=>JSON.parse(localStorage.getItem('nc-copy-position:'+id+':1')??'{}').pageId!=null,copy.id);
  await page.getByLabel('返回我的漫画').click();
  await page.locator('input[type=file]').setInputFiles(path.join(output,name));
  await completeLocalImport(page);
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('.nc-book').filter({has:page.getByRole('heading',{name:name.replace(/\.[^.]+$/,''),exact:true})}).getByRole('button',{name:/^(继续阅读|开始阅读)$/}).click();
  await page.getByLabel('跳转页码').waitFor();
  assert.equal(await page.getByLabel('跳转页码').inputValue(),'2');
  records=await copyRecords(page);
  assert.equal(records.copies.length,bookCount,'Reimport should restore existing book');
  assert.equal(records.copies.find(c=>c.id===copy.id).pages[1].id,copy.pages[1].id);
  await page.locator('.nc-page-image').first().waitFor();
  await page.screenshot({path:path.join(output,label+'.png')});
  assert.deepEqual(errors,[],`${label} browser errors`);
  checks.push({label,pages:3,cache,positionRestored:true,errors});
  console.log(`${label}: 3 pages, content/order/position${cache?'/cache':''} passed`);
  await page.close();
}
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const name of ['pages.cbz','pages.zip','repacked.cbz','rar4.cbr','rar5.rar','pages.pdf']) {
    const context=await browser.newContext({viewport:{width:1400,height:1000}});await configure(context);
    try {await importAndRead(context,name,web,{cache:!name.endsWith('.pdf'),label:'web-'+name});}
    finally {await context.close();}
  }
  for(const name of ['broken-image.cbz','locked.pdf','corrupt.pdf']) {
    const context=await browser.newContext();await configure(context,false);const page=await context.newPage();
    await page.goto(web);await page.locator('input[type=file]').setInputFiles(path.join(output,name));
  await completeLocalImport(page,{close:false});
    await page.locator('.nc-import-item.failed [role=alert]').waitFor();
    await page.waitForFunction(()=>!document.body.innerText.includes('正在保存漫画页'));
    assert.deepEqual(await copyRecords(page),{copies:[],blobCount:0});
    await page.screenshot({path:path.join(output,'error-'+name+'.png')});
    checks.push({label:name,errorHandled:true,noOrphanBlobs:true});await context.close();
  }
} finally {await browser.close();}
if(process.env.TEST_CHROMIUM) {
  const extension=path.join(root,'apps/extension/.output/chrome-mv3');
  const profile=await mkdtemp(path.join(output,'chromium-profile-'));
  const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.TEST_CHROMIUM,headless:true,viewport:{width:1400,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    await configure(context,false);
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    const url=new URL('reader.html',worker.url()).href;
    for(const name of ['pages.cbz','rar4.cbr','rar5.rar','pages.pdf'])await importAndRead(context,name,url,{label:'extension-'+name});
  } finally {await context.close();}
}
const after=await json('/v1/me/usage',{headers:auth});assert.deepEqual(after.items,before.items,'Imports and recovery must not change the ledger');for(const mode of ['classic','redraw'])assert.deepEqual(after.entitlements.modes[mode].quota,before.entitlements.modes[mode].quota,'Imports and recovery must not change quota');
await writeFile(path.join(output,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),syntheticProvider:true,checks,quotaUnchanged:true},null,2));
console.log(`All ${checks.length} import checks passed; quota unchanged.`);
