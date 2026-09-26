// Isolated MV3 shelf acceptance. RUN_LIVE_COVERS=1 reads five public catalogs and their artwork.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {catalogKeyScript,catalogResponse} from '../apps/extension/src/sources/sites/mangacopy/tests/http-fixture.mjs';
const root=process.cwd(),live=process.env.RUN_LIVE_COVERS==='1',output=path.join(root,'artifacts/source-covers');
await mkdir(output,{recursive:true});const out=await mkdtemp(path.join(output,live?'live-':'fixture-')),extension=path.join(out,'extension');
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(manifest.host_permissions?.includes('http://*/*'));
assert(manifest.host_permissions?.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
const source=path.join(root,'apps/extension/src').replaceAll('\\','/'),probe=path.join(extension,'probe.js');
await writeFile(probe,`export {catalog} from '${source}/comics/repositories/index.ts';
export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';
export {importCatalog} from '${source}/comics/application/import-service.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {thumbnailCache} from '${source}/storage/thumbnails/index.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-covers.js'}}});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,
  viewport:{width:1600,height:1100},args:['--disable-extensions-except='+extension,'--load-extension='+extension,
    ...(!live?['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']:[])]});
context.setDefaultTimeout(30000);
const permissionRequests=[];
await context.exposeBinding('__fixturePermissionRequest',(_,request)=>{permissionRequests.push(request);});
await context.addInitScript(()=>{
  if(location.protocol!=='chrome-extension:')return;
  chrome.permissions.request=request=>{void window.__fixturePermissionRequest(request);throw Error('Unexpected permission request with required host access');};
});
const errors=[],checks=[];let coverRequests=0,failCover=false,artwork,bodyImage,changedArtwork;
context.on('page',page=>page.on('pageerror',error=>{if(page.url().startsWith('chrome-extension:'))errors.push(error.message);}));
const chapter='724f819b-5306-11ea-b7ea-024352452ce0';
const fixtures={
  mangacopy:{url:'https://www.copy4000.com/comic/coverfixture',cover:'https://sg.mangafunb.fun/cover.jpg'},
  comix:{url:'https://comix.to/title/rrzm-coverfixture',cover:'https://static.comix.to/cover.jpg'},
  dm5:{url:'https://www.dm5.com/manhua-coverfixture/',cover:'https://mhfm5tel.cdndm5.com/1/98761/cover.jpg'},
  naver:{url:'https://comic.naver.com/webtoon/list?titleId=123',cover:'https://image-comic.pstatic.net/cover.jpg'},
  comicpash:{url:'https://comicpash.jp/series/coverfixture',cover:'https://cdn-public.comici.jp/series/cover.jpg'},
};
const mangaHtml=`${catalogKeyScript}<div class="comicParticulars-title-left"><img data-src="${fixtures.mangacopy.cover}"></div><div class="comicParticulars-title-right"><h6>MangaCopy cover</h6></div>`;
const liveUrls={mangacopy:'https://www.copy4000.com/comic/grandblue',comix:'https://comix.to/title/rrzm-the-regressed-genius-players-mythical-rank-weapon-creation',
  dm5:'https://www.dm5.com/manhua-yaoshenji/',naver:'https://comic.naver.com/webtoon/list?titleId=758037',comicpash:'https://comicpash.jp/series/1fafeeae328df'};
await context.route('https://*.nodelane.net/**',route=>route.fulfill({status:503,body:'Isolated cover acceptance'}));
if(!live)await context.route('http://**/*',route=>route.abort());
if(!live)await context.route('https://**/*',route=>{
  const url=new URL(route.request().url());
  if(Object.values(fixtures).some(item=>url.href===item.cover)||url.pathname==='/changed-cover.jpg'){
    coverRequests++;
    return route.fulfill({status:failCover?503:200,contentType:'image/png',body:failCover?'Offline':url.pathname==='/changed-cover.jpg'?changedArtwork:artwork});
  }
  if(url.hostname==='image-comic.pstatic.net')return route.fulfill({contentType:'image/png',body:bodyImage});
  if(url.hostname==='www.copy4000.com')return url.pathname.startsWith('/comicdetail/')
    ?route.fulfill({contentType:'application/json',body:catalogResponse('coverfixture',[{id:'default',title:'默认',chapters:[{id:chapter,title:'Chapter'}]}])})
    :route.fulfill({contentType:'text/html; charset=utf-8',body:mangaHtml});
  if(url.hostname==='comix.to')return url.pathname.startsWith('/api/')?route.fulfill({json:{status:'ok',result:{items:[{id:20,number:1,mangaId:2188,language:'en',isOfficial:true,url:'/title/rrzm-coverfixture/20-chapter-1'}],meta:{total:1,lastPage:1,page:1,hasNext:false}}}})
    :route.fulfill({contentType:'text/html; charset=utf-8',body:`<script id="initial-data">${JSON.stringify({queries:{'["manga","detail","rrzm"]':{id:2188,hid:'rrzm',url:fixtures.comix.url,title:'Comix cover',poster:{large:fixtures.comix.cover}}}})}</script>`});
  if(url.hostname==='www.dm5.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<script>var DM5_COMIC_MID=98761;var DM5_COMIC_URL='/manhua-coverfixture/';var DM5_COMIC_MNAME='DM5 cover';var DM5_COMIC_SORT=1;</script><div class="banner_detail_form"><div class="cover"><img src="${fixtures.dm5.cover}"></div></div><div class="detail-list-title"><a onclick="titleSelect(this,'detail-list-select','detail-list-select-1')">连载（1）</a></div><ul id="detail-list-select-1"><a href="/m1836194/">Chapter</a></ul>`});
  if(url.hostname==='comic.naver.com'){
    if(url.pathname.endsWith('/info'))return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',titleName:'NAVER cover',posterThumbnailUrl:fixtures.naver.cover}});
    if(url.pathname==='/api/article/list')return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',sort:'ASC',totalCount:1,pageInfo:{page:1,totalPages:1,totalRows:1,pageSize:20},articleList:[{no:1,subtitle:'Chapter'}]}});
    if(url.pathname==='/webtoon/detail')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<a aria-current="true" href="/webtoon/detail?titleId=123&amp;no=1">Current</a><div class="wt_viewer">${[0,1,2].map(n=>`<img id="content_image_${n}" src="https://image-comic.pstatic.net/webtoon/123/1/${n}.png">`).join('')}</div>`});
  }
  if(url.hostname==='comicpash.jp')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<link rel="canonical" href="${fixtures.comicpash.url}"><meta property="og:title" content="Comic PASH cover"><img class="series-h-img" src="${fixtures.comicpash.cover}"><a class="series-sort-link" href="${fixtures.comicpash.url}/1">1-1</a><a class="series-eplist-item-link" href="/episodes/first"><span class="series-eplist-item-h-text">Chapter</span></a>`});
  return route.abort();
});
let reader;
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),home=new URL('reader.html',worker.url()).href;
  await worker.evaluate(()=>{globalThis.__fixturePermissionRequests=0;chrome.permissions.request=()=>{globalThis.__fixturePermissionRequests++;throw Error('Unexpected background permission request with required host access');};});
  reader=await context.newPage();await reader.goto(home);await reader.locator('.nc-library').waitFor();
  await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));
  if(!live){
    const images=await reader.evaluate(()=>['#dd3377','#3366dd','#33bb77'].map((color,i)=>{
      const canvas=document.createElement('canvas');canvas.width=600;canvas.height=900;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,600,900);
      ctx.fillStyle='#fff';ctx.font='bold 50px sans-serif';ctx.fillText(i===1?'BODY PAGE':'SITE COVER',90,440);return canvas.toDataURL().split(',')[1];
    }));[artwork,bodyImage,changedArtwork]=images.map(value=>Buffer.from(value,'base64'));
  }
  const imported=[];
  for(const [site,item] of Object.entries(fixtures)){
    console.log('Checking '+site+' cover');
    const value=await reader.evaluate(async url=>{
      const api=await import(chrome.runtime.getURL('verify-covers.js'));
      const snapshot=await api.readSourceCatalog(url);if(!snapshot.cover)throw Error('Adapter did not supply a cover');
      const comic=await api.importCatalog(snapshot);return{id:comic.id,title:comic.title,site:snapshot.sourceId};
    },live?liveUrls[site]:item.url);
    imported.push(value);
    const image=reader.locator(`[data-comic-id="${value.id}"] .nc-thumbnail img`);await image.waitFor({timeout:60000});
    assert(await image.evaluate(element=>element.naturalWidth===240));
  }
  const card=id=>reader.locator(`[data-comic-id="${id}"]`);
  assert.equal(await reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-covers.js'));return catalog.count('pageDescriptors');}),0);
  checks.push('All five adapters display dedicated artwork before any chapter is indexed');
  await reader.screenshot({path:path.join(out,'dedicated-covers.png')});
  if(!live){
    const naver=imported.find(item=>item.site==='naver');await card(naver.id).getByRole('button',{name:'打开漫画 '+naver.title,exact:true}).click();
    await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth===600);
    await reader.getByLabel('跳转页码').fill('2');
    await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth===600);
    await reader.waitForFunction(async id=>{const {catalog}=await import(chrome.runtime.getURL('verify-covers.js'));const comic=await catalog.get('comics',id);return comic.lastPage===2;},naver.id);
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    await card(naver.id).locator('.nc-thumbnail img').waitFor();
    const color=await card(naver.id).locator('.nc-thumbnail img').evaluate(img=>{const c=document.createElement('canvas');c.width=240;c.height=360;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(5,5,1,1).data];});
    assert(color[0]>200&&color[2]<150,'Shelf must show pink artwork rather than the blue body');
    await reader.reload();await card(naver.id).getByRole('button',{name:'继续阅读',exact:true}).click();
    await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth===600);
    assert.equal(await reader.getByLabel('跳转页码').inputValue(),'2');
    await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
    checks.push('Chapter indexing never replaces the dedicated cover; reopening restores page 2');
    const before=coverRequests;
    await reader.reload();await card(naver.id).locator('.nc-thumbnail img').waitFor();
    assert.equal(coverRequests,before);checks.push('Shelf reload reuses bounded thumbnail cache');
    failCover=true;await reader.evaluate(async()=>{const {thumbnailCache}=await import(chrome.runtime.getURL('verify-covers.js'));await thumbnailCache.clear();});
    await reader.reload();await card(naver.id).getByRole('button',{name:naver.title+'封面 · 重试',exact:true}).waitFor();
    await reader.screenshot({path:path.join(out,'cover-failure.png')});
    failCover=false;await card(naver.id).getByRole('button',{name:naver.title+'封面 · 重试',exact:true}).click();await card(naver.id).locator('.nc-thumbnail img').waitFor();
    assert.equal(await card(naver.id).locator('.nc-cover-retry').count(),0);checks.push('Cover failure remains independent of reading and explicit retry recovers');
    await reader.evaluate(async id=>{
      const {catalog,applyCatalogRefresh}=await import(chrome.runtime.getURL('verify-covers.js')),comic=await catalog.get('comics',id),source=await catalog.get('catalogs',comic.source.providerItemId);
      await applyCatalogRefresh(id,comic.source.generation,{...source,observedAt:source.observedAt+1,cover:{url:'https://image-comic.pstatic.net/changed-cover.jpg'}});
    },naver.id);
    await reader.waitForFunction(id=>{
      const img=document.querySelector(`[data-comic-id="${id}"] .nc-thumbnail img`);if(!img?.naturalWidth)return false;
      const c=document.createElement('canvas');c.width=240;c.height=360;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(5,5,1,1).data[1]>150;
    },naver.id);
    assert.equal(await card(naver.id).locator('.nc-card-update').count(),0);checks.push('Catalog artwork changes refresh the shelf without a false new-chapter badge');
    const beforeRestrictedCover=coverRequests;
    await reader.evaluate(async id=>{
      // Model browser site-access restrictions without revoking installation-required permissions.
      const contains=chrome.permissions.contains.bind(chrome.permissions);window.__fixtureCoverAccessAllowed=false;
      chrome.permissions.contains=async query=>query.origins?.includes('https://image-comic.pstatic.net/*')&&!window.__fixtureCoverAccessAllowed?false:contains(query);
      const {catalog,applyCatalogRefresh}=await import(chrome.runtime.getURL('verify-covers.js')),comic=await catalog.get('comics',id),source=await catalog.get('catalogs',comic.source.providerItemId);
      await applyCatalogRefresh(id,comic.source.generation,{...source,observedAt:source.observedAt+1,cover:{url:'https://image-comic.pstatic.net/changed-cover.jpg?permission=1'}});
    },naver.id);
    const restrictedRetry=card(naver.id).getByRole('button',{name:naver.title+'封面 · 重试',exact:true});
    await restrictedRetry.waitFor();
    assert.match(await restrictedRetry.getAttribute('title'),/网站访问权限已被浏览器关闭/);
    assert.equal(coverRequests,beforeRestrictedCover,'Restricted cover access must fail before an HTTP request');
    assert.equal(await reader.getByRole('button',{name:/授权并继续/}).count(),0);
    await reader.evaluate(()=>{window.__fixtureCoverAccessAllowed=true;});
    await restrictedRetry.click();
    await card(naver.id).locator('.nc-thumbnail img').waitFor();
    assert.equal(await card(naver.id).locator('.nc-cover-retry').count(),0);
    checks.push('Simulated restricted site access shows retry only; restoring access recovers without requesting permission');
    await reader.screenshot({path:path.join(out,'recovered-cover.png')});
  }
  const backgroundPermissionRequests=await worker.evaluate(()=>globalThis.__fixturePermissionRequests);
  assert.deepEqual(permissionRequests,[]);assert.equal(backgroundPermissionRequests,0);
  checks.push('The unchanged manifest requires HTTP/HTTPS access; cover reads and retries never request permissions');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'results.json'),JSON.stringify({live,checks,errors,permissionRequests,backgroundPermissionRequests,sites:imported.map(({site})=>site)},null,2));
  console.log(JSON.stringify({out,live,checks,errors}));
}catch(error){await reader?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await context.close();}
