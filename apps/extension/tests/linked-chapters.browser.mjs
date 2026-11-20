// Run after the MV3 build. Only synthetic HTTP content, in a disposable browser profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=fileURLToPath(new URL('../.output/chrome-mv3',import.meta.url));
const profile=await mkdtemp(path.join(process.env.TEST_TMPDIR||tmpdir(),'linked-chapters-'));
const pages=Array.from({length:32},(_,i)=>`<div data-reader-page><img data-reader-image data-fallback-index="0" loading="lazy" width="320" height="480" data-src="/image/${i+1}?token=fixture-secret"></div>`).join('');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const requests=[],total=45,series='/series/paper',work='/comics/7';
const slice=(page,size)=>Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>total-(page-1)*size-i);
const rows=ids=>ids.map(id=>`<a data-chapter-id="${id}" href="${work}/chapters/${id}"><span class="truncate">Part ${id}</span></a>`).join('');
const site=createServer((request,response)=>{
  const url=new URL(request.url,'http://'+request.headers.host),p=url.pathname.replace(/\/$/,''),page=Number(url.searchParams.get('page'));
  requests.push({p,page});
  let type='text/html; charset=utf-8',body;
  if(p===work)body=`<h1>Paper library</h1><section id="chapters" data-chapter-sort-scope data-chapters-url="${work}/chapters" data-chapter-page-size="20" data-chapter-next-page="2"><h2>Parts</h2><span>Total: 45</span>${rows(slice(1,20))}</section>`;
  else if(p===work+'/chapters'){
    type='application/json';body=JSON.stringify({html:rows(slice(page,20)),total,current_page:page,last_page:3,next_page:page<3?page+1:null,has_more:page<3});
  }else if(p===series){
    const data=JSON.stringify({series_id:9,series_type:'Comic',series:{id:9,series_slug:'paper',title:'Folded paper',meta:{chapters_count:total}}});
    body=`<h1>Folded paper</h1><div role="tabpanel" id="tab-content-chapters_list"></div><script type="application/json">${data}</script>
      <script>fetch('/chapter/query?page=1&perPage=1&series_id=9').then(r=>r.json()).then(()=>document.querySelector('[role=tabpanel]').innerHTML='<a href="${series}/part-1">Part 1</a>');</script>`;
  }else if(p==='/browse'){
    body=`<a href="${series}">Open paper</a><script type="application/json">{"series_id":8,"series_type":"Comic","series":{"id":8,"series_slug":"other","title":"Other work","meta":{"chapters_count":1}}}</script>
      <script>document.querySelector('a').onclick=async e=>{e.preventDefault();history.pushState(null,'','${series}');
        await (await fetch('/chapter/query?page=1&perPage=1&series_id=9')).json();
        document.body.insertAdjacentHTML('beforeend','<div role="tabpanel" id="tab-content-chapters_list"><a href="${series}/part-1">Part 1</a></div>');};</script>`;
  }else if(p==='/chapter/query'){
    const size=Number(url.searchParams.get('perPage'));type='application/json';
    body=JSON.stringify({meta:{total,current_page:page,last_page:Math.ceil(total/size),per_page:size},data:slice(page,size).map(id=>({series:{id:9,series_slug:'paper'},chapter_name:'Part '+id,chapter_slug:'part-'+id,price:id===total?1:0}))});
  }else if(p.startsWith(work+'/chapters/')||p.startsWith(series+'/part-')){
    body=`<h1>Paper chapter</h1><img src="/advert"><div data-reader-shell data-reader-chapter-id="${p.split('/').pop()}"><div data-reader-canvas>${pages}</div></div>`;
  }else if(p.startsWith('/image/')){body=png;type='image/png';}
  else body='<p>Unrelated page</p>';
  response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});response.end(body);
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin='http://one.example.test:'+site.address().port,other=origin.replace('one.','two.');
let context;
try{
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM||chromium.executablePath(),
    locale:'en-US',viewport:{width:1280,height:960},reducedMotion:'reduce',args:['--disable-extensions-except='+extension,'--load-extension='+extension,
      '--no-proxy-server','--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost']});
  context.setDefaultTimeout(20000);
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),base=new URL('/reader.html',worker.url()).href;
  await context.addInitScript(()=>{if(location.protocol==='chrome-extension:'){
    localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'en',layout:'single',readerImmersive:false}));
    localStorage.setItem('nc-release-notes-version',chrome.runtime.getManifest().version);
  }});
  const shelf=context.pages().find(page=>page.url()===base)??await context.waitForEvent('page',{predicate:page=>page.waitForURL(base).then(()=>true)});
  await shelf.locator('.nc-app-header').waitFor();
  const source=await context.newPage(),errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const readState=p=>p.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('node-comics-reading-v2-catalog');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{
      const names=['comics','catalogs','entries','pageDescriptors','positions','bookmarks','tasks','materializations','metadata'];
      return await new Promise((resolve,reject)=>{const tx=db.transaction(names),queries=names.map(name=>tx.objectStore(name).getAll());
        tx.oncomplete=()=>resolve(Object.fromEntries(names.map((name,i)=>[name,queries[i].result])));tx.onerror=()=>reject(tx.error);});
    }finally{db.close();}
  });
  async function popupAction(url,label){
    if(source.url()!==url)await source.goto(url);await source.bringToFront();
    const opened=context.waitForEvent('page');await worker.evaluate(async url=>{
      const [tab]=await chrome.tabs.query({url});await chrome.tabs.update(tab.id,{active:true});
      await chrome.tabs.create({windowId:tab.windowId,url:chrome.runtime.getURL('popup.html'),active:false});
    },url);
    const popup=await opened,action=popup.getByRole('button',{name:label,exact:true});
    try{await action.waitFor();}catch(error){throw Error(`${error.message}\nPopup: ${await popup.locator('body').innerText()}`);}
    assert.equal(await popup.locator('.nc-popup-adapted').count(),0);
    const created=context.waitForEvent('page');await action.click();const reader=await created;
    await reader.waitForURL(u=>u.href.startsWith(base));
    assert.equal(await source.locator('.nc-reader, [data-reader-back-trigger]').count(),0);
    return reader;
  }
  const direct='Read chapter without saving',add='Add to shelf';
  const rendered=p=>p.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth===1);
  let r=await popupAction(origin+work+'/chapters/1?token=fixture-secret',direct);
  await rendered(r);assert.equal(await r.locator('.nc-reading-viewport').getAttribute('data-page-count'),'32');
  assert(await r.locator('[data-sync=temporary]').isVisible());
  await r.getByRole('button',{name:'Next page',exact:true}).click();
  await r.locator('.nc-reader-position[data-value="2"]').waitFor();
  assert(requests.filter(x=>x.p.startsWith('/image/')).length<32);
  const empty=await readState(r);
  for(const table of ['comics','entries','positions','pageDescriptors','materializations'])assert.deepEqual(empty[table],[]);
  assert.equal((await r.evaluate(()=>chrome.runtime.sendMessage({type:'NC_TAKE_LINK'}))).ok,false);
  assert.equal(await shelf.locator('.nc-book').count(),0);
  await r.close();

  requests.length=0;r=await popupAction(origin+work,add);
  const card=p=>p.locator('article.nc-book').filter({hasText:'Paper library'}).first();
  await card(r).waitFor();let state=await readState(r);
  assert.equal(state.comics.length,1);assert.equal(state.catalogs[0].entries.length,total);assert(state.catalogs[0].complete);
  assert.deepEqual(requests.filter(x=>x.p===work+'/chapters').map(x=>x.page),[2,3]);
  assert(!requests.some(x=>x.p.startsWith('/image/')||x.p.startsWith(work+'/chapters/')));
  await card(r).locator('.nc-book-cover').click();await rendered(r);
  await r.getByRole('button',{name:'Next page',exact:true}).click();await r.locator('.nc-reader-position[data-value="2"]').waitFor();
  await r.locator('[data-reader-back-trigger]').click();await card(r).waitFor();
  const saved=await readState(r);assert.equal(saved.positions.length,1);
  assert(!JSON.stringify(saved).includes('fixture-secret'));
  const durable=await r.evaluate(()=>chrome.storage.local.get(null));assert(!JSON.stringify(durable).includes('fixture-secret'));
  const transient=await popupAction(origin+work+'/chapters/1',direct);await rendered(transient);
  await transient.locator('[data-reader-back-trigger]').click();await card(transient).waitFor();
  assert.deepEqual((await readState(transient)).positions,saved.positions);await transient.close();

  const link=async url=>{await r.goto(base+'#sites');await r.locator('#nc-site-url').fill(url);await r.locator('.nc-site-link-import button').click();};
  await link(other+'/comics/8');await r.locator('.nc-site-link-import [role=alert]').waitFor();
  assert.equal((await readState(r)).comics.length,1);
  await link(other+work);await r.waitForURL(base+'#library');assert.equal((await readState(r)).comics.length,2);
  await link(origin+series+'/part-4');await rendered(r);assert(await r.locator('[data-sync=temporary]').isVisible());await r.locator('[data-reader-back-trigger]').click();
  await source.goto(origin+'/browse');await source.getByRole('link',{name:'Open paper'}).click();
  await source.locator('[role=tabpanel] a').waitFor();assert.equal(source.url(),origin+series);
  const folded=await popupAction(origin+series,add);await folded.locator('.nc-book').filter({hasText:'Folded paper'}).waitFor();
  state=await readState(folded);const snap=state.catalogs.find(s=>s.url===origin+series);
  assert(snap.complete);assert.equal(snap.entries.length,total);assert.equal(snap.entries.filter(e=>!e.readable).length,1);
  assert.deepEqual(state.positions,saved.positions);assert.equal(state.comics.length,3);
  assert.deepEqual(errors,[]);console.log('PASS: popup and link entry points; both complete directories; locked rows; lazy images; invalid catalog; cross-origin and temporary progress isolation.');
}finally{
  await context?.close();await new Promise(resolve=>site.close(resolve));
  await rm(profile,{force:true,recursive:true,maxRetries:5,retryDelay:250});
}
