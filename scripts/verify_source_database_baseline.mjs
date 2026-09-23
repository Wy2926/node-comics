/** Compiled extension startup with pre-existing incomplete databases; isolated profiles only. */
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),out=path.join(root,'artifacts/source-database-baseline');await mkdir(out,{recursive:true});
const extension=path.join(root,'apps/extension/.output/chrome-mv3');
const options={headless:true,executablePath:process.env.TEST_CHROMIUM,locale:'zh-CN',viewport:{width:1440,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension]};
const oldNames=['node-comics-catalog','node-comics-container-bytes',...['source-pages','source-ranges','downloads','thumbnails','translations'].map(name=>'node-comics-'+name),'node-comics-content-operations'];
const results=[];
for(const malformed of [false,true]){
 const profile=await mkdtemp(path.join(out,malformed?'malformed-':'old-'));let context=await chromium.launchPersistentContext(profile,options),page,errors=[];
 async function open(){
  await context.route('https://**.nodelane.net/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return 'chrome-extension://'+new URL(worker.url()).host;
 }
 async function oldState(){return page.evaluate(async names=>{
  return Promise.all(names.map(name=>new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('works'),read=tx.objectStore('works').get('preserve');read.onsuccess=()=>{resolve({name,version:db.version,stores:[...db.objectStoreNames],value:read.result});db.close();};read.onerror=()=>reject(read.error);};})));
 },oldNames);}
 try{
  const origin=await open();await page.goto(origin+'/brand/icon-128.png');
  await page.evaluate(async names=>{
   for(const name of names)await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('works',{keyPath:'id'}).put({id:'preserve',title:'旧库保留'});request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
  },malformed?[...oldNames,'node-comics-sources-v1-catalog']:oldNames);
  const before=await oldState();await page.goto(origin+'/reader.html');await page.locator('input[type=file]').waitFor({state:'attached'});
  if(malformed){
   await page.getByRole('alert').filter({hasText:'本机资料库结构与当前扩展不一致'}).first().waitFor();await page.waitForTimeout(1800);assert.deepEqual(errors,[]);
   assert.deepEqual(await oldState(),before);await page.screenshot({path:path.join(out,'schema-error.png')});results.push('当前基线缺表在打开时明确报错，下载列表无未处理Promise，旧库不变');
  }else{
   await page.waitForTimeout(1800);assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(await oldState(),before);
   await page.locator('input[type=file]').setInputFiles({name:'数据库回归.png',mimeType:'image/png',buffer:await readFile(path.join(root,'artifacts/import-validation/1.png'))});
   const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.getByRole('button',{name:/^开始导入/}).click();await panel.locator('.nc-import-item.created').waitFor({timeout:60000});await panel.getByRole('button',{name:'开始阅读',exact:true}).click();await page.locator('.nc-page-image').first().waitFor();await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
   await page.close();await context.close();context=await chromium.launchPersistentContext(profile,options);const reopened=await open();await page.goto(reopened+'/reader.html');await page.getByRole('button',{name:'继续阅读',exact:true}).click();await page.locator('.nc-page-image').first().waitFor();assert.deepEqual(await oldState(),before);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'old-database-restart.png')});results.push('8个残缺旧v1库存在时可导入阅读并关闭重开，旧库版本/表/记录原样保留');
  }
 }catch(error){await page?.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await context.close();}
}
await writeFile(path.join(out,'results.json'),JSON.stringify({results,liveProvider:false},null,2));console.log(JSON.stringify(results,null,2));
