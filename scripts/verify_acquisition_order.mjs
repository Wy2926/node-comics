/** Isolated Chromium/MV3 acceptance for ordered acquisition and JS image-list decoding.
 * Build the extension first; PLAYWRIGHT_MODULE and TEST_CHROMIUM select installed tools.
 * Source pages and images are synthetic. No provider or account requests are made.
 */
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.join(root,'artifacts/acquisition-order');await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'profile-')),extension=path.join(root,'apps/extension/.output/chrome-mv3');
const context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{channel:'chromium'}),args:['--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:1000}});
context.on('page',page=>page.on('pageerror',error=>console.log('Fixture page error: '+error.message)));
const origin='https://www.mangacopy.com',cdn='https://cdn.copy4000.com';
const entries=[1,2,3].map(n=>({id:'entry-'+n,catalogId:'mangacopy:sequence',remoteId:`724f819b-5306-11ea-b7ea-024352452ce${n}`,title:`第 ${n} 话`,url:`${origin}/comic/sequence/chapter/724f819b-5306-11ea-b7ea-024352452ce${n}`,groupIds:['main'],rawTypes:['話'],order:n-1,related:false}));
const catalog={id:'mangacopy:sequence',sourceId:'mangacopy',url:origin+'/comic/sequence',title:'顺序采集验收',observedAt:1,complete:true,note:'隔离样本',groups:[{id:'main',title:'默认',entryIds:entries.map(e=>e.id),complete:true}],entries:[...entries].reverse(),excludedEntryIds:[],workId:'work'};
const traces=new Map(),opened=[],downloads=[],downloadStates=[];let failSecond=true;
let currentReader;
async function encryptedData(entry){
 const cct='0123456789abcdef',iv='abcdefghijklmnop',encoder=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',encoder.encode(cct),'AES-CBC',false,['encrypt']);
 const ciphertext=await crypto.subtle.encrypt({name:'AES-CBC',iv:encoder.encode(iv)},key,encoder.encode(JSON.stringify([1,2,3].map(n=>({url:`${cdn}/images/${entry.id}/${n}.png`})) )));
 const contentKey=iv+Buffer.from(ciphertext).toString('hex');
 return `var cct="${cct}";var contentKey="${contentKey}";`;
}
await context.exposeBinding('recordScroll',({page},value)=>{const list=traces.get(page.url())??[];list.push(value);traces.set(page.url(),list);});
const pixel=await readFile(path.join(root,'samples/starlight-bookshop.png'));
await context.route(origin+'/**',async route=>{
 const url=route.request().url(),entry=entries.find(e=>e.url===url);
 if(entry){
  opened.push(entry.id);
  const data=await encryptedData(entry);
  return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>${entry.title} · 滚动验收</title>
   <style>body{margin:0;background:#eef3fa;color:#34415b;font:24px system-ui}header{padding:36px}ul{padding:0;margin:0 auto;width:640px;list-style:none}li{height:900px;box-sizing:border-box;border:16px solid white;background:linear-gradient(#c9e2f2,#e3d6ef);padding:40px}img{display:block;width:100%;height:760px;image-rendering:pixelated}footer{padding:60px}</style>
   <header>${entry.title} · <span class="comicCount">3</span> 页 · JS 图片清单验收</header><ul class="comicContent-list"></ul><footer>章节底部</footer>
   ${entry.id==='entry-1'?'':`<script>${data}</script>`}
   <script>
    let count=0;const list=document.querySelector('ul');
    function add(){count++;const li=document.createElement('li');li.innerHTML='<b>原创测试页面 '+count+'</b><img data-src="${cdn}/images/${entry.id}/'+count+'.png">';list.append(li);window.recordScroll({y:scrollY,bottom:document.documentElement.scrollHeight-innerHeight,count});}
    add();addEventListener('scroll',()=>window.recordScroll({y:scrollY,bottom:document.documentElement.scrollHeight-innerHeight,count}));
    ${entry.id==='entry-1'?`setTimeout(()=>{const data=document.createElement('script');data.textContent=${JSON.stringify(data)};document.head.append(data);},2500);`:''}
   </script>`});
 }
 return route.fulfill({status:404,body:'Fixture'});
});
await context.route(cdn+'/**',async route=>{
 const key=new URL(route.request().url()).pathname;downloads.push(key);
 const entry=entries.find(e=>key.includes('/'+e.id+'/'));
 const copy=currentReader?(await state(currentReader)).copies.find(c=>c.id==='copy-'+entry.id):undefined;
 downloadStates.push({key,found:copy?.pages.length,complete:copy?.discoveryComplete});
 if(failSecond&&key==='/images/entry-1/2.png')return route.fulfill({status:503,body:'Fixture temporary failure'});
 await new Promise(resolve=>setTimeout(resolve,100));return route.fulfill({contentType:'image/png',body:pixel});
});
await context.route('http://127.0.0.1:18088/**',route=>route.fulfill({status:503,body:'Isolated test'}));
const state=page=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-library');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['library','copies'],'readonly'),a=tx.objectStore('library').get('library'),b=tx.objectStore('copies').getAll();tx.oncomplete=()=>{resolve({library:a.result,copies:b.result});db.close();};};}));
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 // Chrome extension-created tabs can navigate before Playwright attaches routes.
 // Attach the isolated fixture tab at about:blank before the requested navigation.
 await worker.evaluate(()=>{
  const create=chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create=async options=>{
   if(!options.url?.includes('/comic/sequence/'))return create(options);
   const tab=await create({...options,url:'about:blank'});
   await new Promise(resolve=>setTimeout(resolve,200));
   return chrome.tabs.update(tab.id,{url:options.url});
  };
 });
 const reader=await context.newPage();await reader.goto(new URL('reader.html',worker.url()).href);
 currentReader=reader;
 await reader.addInitScript(()=>{
  const request=chrome.permissions.request.bind(chrome.permissions);window.permissionChecks=[];window.denyNext=false;
  chrome.permissions.request=async options=>{window.permissionChecks.push({origins:options.origins,fromClick:navigator.userActivation.isActive});if(window.denyNext){window.denyNext=false;return false;}return request(options);};
 });
 await reader.getByRole('heading',{name:/我的漫画/}).waitFor();
 await reader.evaluate(async({catalog,entries})=>{
  const evidence={status:'user',source:'隔离验收'};
  const library={id:'library',revision:1,works:[{id:'work',title:'顺序采集验收',aliases:[],creators:[],createdAt:1,updatedAt:1,evidence}],chapters:entries.map((e,n)=>({id:e.id,workId:'work',title:e.title,order:n,role:'main',numbering:'fixture',evidence})),versions:[],series:[],publications:[],inclusions:[],publicationRelations:[],relations:[],catalogs:[catalog],coverage:entries.map(e=>({id:'coverage-'+e.id,copyId:'copy-'+e.id,workId:'work',target:{kind:'chapter',id:e.id},evidence})),tasks:[...entries].reverse().map((e,n)=>({id:'task-'+e.id,copyId:'copy-'+e.id,status:'paused',phase:'discover',completed:0,updatedAt:100+n}))};
  await new Promise((resolve,reject)=>{const r=indexedDB.open('node-comics-library');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['library','copies'],'readwrite');tx.objectStore('library').put(library);for(const [n,e] of entries.entries())tx.objectStore('copies').put({id:'copy-'+e.id,title:e.title,source:'MangaCopy',sourceKey:e.id,sourceEntryId:e.id,sourceUrl:e.url,manifestRevision:1,retention:'offline',createdAt:1,updatedAt:999-n,pages:[],pageId:'',relativeOffset:0,discoveryComplete:false});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
 },{catalog,entries});
 await reader.reload();await reader.getByRole('button',{name:/采集中心/}).click();
 const titles=()=>reader.locator('.nc-capture-card h3').allTextContents();
 assert.deepEqual(await titles(),entries.map(e=>e.title));
 await reader.getByRole('button',{name:'补齐待处理',exact:true}).waitFor({state:'visible'});
 await reader.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='补齐待处理'&&!b.disabled));
 assert.equal(downloads.length,0,'Permission preflight must not download images');
 await reader.screenshot({path:path.join(output,'ordered-pending.png')});
 await reader.evaluate(()=>{window.denyNext=true;});
 await reader.getByRole('button',{name:'补齐待处理',exact:true}).click();
 await reader.getByRole('alert').filter({hasText:'未获授权'}).waitFor();
 assert.equal(downloads.length,0);assert((await state(reader)).library.tasks.every(t=>t.status==='paused'));
 const permissionChecks=await reader.evaluate(()=>window.permissionChecks);assert(permissionChecks[0].fromClick);assert(permissionChecks[0].origins.includes(cdn+'/*'));
 await reader.getByRole('button',{name:'补齐待处理',exact:true}).click();
 // Pause during incremental discovery, then resume from persisted page identities.
 await reader.waitForFunction(()=>document.querySelector('.nc-capture-card')?.textContent.includes('正在下载原图'));
 while(!(await state(reader)).copies.find(c=>c.id==='copy-entry-1').pages.some(p=>p.blobKey))await reader.waitForTimeout(100);
 await reader.getByRole('button',{name:'暂停全部',exact:true}).click();
 await reader.locator('.nc-capture-card').first().getByText('已暂停',{exact:true}).waitFor();
 const paused=await state(reader),savedIds=paused.copies.find(c=>c.id==='copy-entry-1').pages.map(p=>p.id);
 await reader.screenshot({path:path.join(output,'paused-progress.png')});
 // Let the paused source close before restarting the owning reader page.
 await reader.waitForFunction(async()=>!Object.keys(await chrome.storage.session.get(null)).some(key=>key.startsWith('nc-managed:')));
 await reader.reload();await reader.getByRole('button',{name:/采集中心/}).click();
 const resumedAt=opened.length,downloadsBeforeResume=downloads.length;
 await reader.getByRole('button',{name:'补齐待处理',exact:true}).click();
 const deadline=Date.now()+90000;
 let firstPass;
 while(Date.now()<deadline){firstPass=await state(reader);if(firstPass.library.tasks.every(t=>['complete','failed'].includes(t.status)))break;await reader.waitForTimeout(500);}
 console.log(JSON.stringify({phase:'first-pass',tasks:firstPass.library.tasks.map(t=>({status:t.status,error:t.error,completed:t.completed})),scroll:[...traces].map(([url,trace])=>({entry:entries.find(e=>e.url===url)?.id,events:trace.length,last:trace.at(-1)}))}));
 assert.deepEqual(firstPass.library.tasks.map(t=>t.status),['failed','complete','complete']);
 assert.deepEqual(opened.slice(resumedAt),entries.map(e=>e.id));
 assert.deepEqual(firstPass.copies.find(c=>c.id==='copy-entry-1').pages.slice(0,savedIds.length).map(p=>p.id),savedIds);
 assert.deepEqual(downloads,entries.flatMap(e=>[1,2,3].map(n=>`/images/${e.id}/${n}.png`)));
 assert(downloadStates.some(s=>s.key.endsWith('/1.png')&&s.found<3&&!s.complete),'First images must download before the full manifest');
 assert.deepEqual(await titles(),entries.map(e=>e.title));
 await reader.screenshot({path:path.join(output,'ordered-failure.png')});
 failSecond=false;
 await reader.locator('.nc-capture-card').first().getByRole('button',{name:'重试缺失页',exact:true}).click();
 const retryDeadline=Date.now()+45000;let final;
 while(Date.now()<retryDeadline){final=await state(reader);if(final.library.tasks.every(t=>t.status==='complete'))break;await reader.waitForTimeout(500);}
 assert(final.library.tasks.every(t=>t.status==='complete'));
 assert.equal(downloads.length,10);assert.equal(downloads.at(-1),'/images/entry-1/2.png');
 assert.deepEqual(await titles(),entries.map(e=>e.title));
 await reader.screenshot({path:path.join(output,'ordered-complete.png')});
 const scrollChecks=entries.map(e=>{
  const trace=traces.get(e.url);assert(trace?.length);assert(trace.every(p=>p.y===0),'Acquisition must never scroll');
  const last=trace.at(-1);assert.equal(last.count,1);
  return {entry:e.id,domImages:last.count,decodedImages:3,position:last.y};
 });
 const result={checkedAt:new Date().toISOString(),scope:'Isolated Chromium extension; synthetic source and original fixture image. Permission denial mocked; allowed CDN covered by installed source-host permission, native prompt not exercised.',permissionChecks,queueOrder:opened.slice(resumedAt,resumedAt+3),downloads:downloads.length,downloadsBeforeResume,pausedPages:savedIds.length,incrementalDownloads:downloadStates,retryOnlyMissing:true,scrollChecks};
 await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){
 console.log(JSON.stringify({opened,pages:context.pages().map(p=>p.url())}));
 for(const page of context.pages())if(page.url().includes('/comic/'))console.log((await page.locator('body').innerText()).slice(0,400));
 for(const page of context.pages())if(page.url().includes('reader.html')){await page.screenshot({path:path.join(output,'failure.png')});console.log((await page.locator('body').innerText()).slice(-3000));}
 throw error;
}finally{await context.close();}
