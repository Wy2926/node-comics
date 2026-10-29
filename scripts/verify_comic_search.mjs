import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
// Production MV3/App acceptance with isolated HTTP fixtures. No live model or source requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),output=path.join(root,'artifacts/comic-search');
await mkdir(output,{recursive:true});
const out=await mkdtemp(path.join(output,'fixture-')),extension=path.join(out,'extension');
await cp(path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert(manifest.host_permissions?.includes('http://*/*'));
assert(manifest.host_permissions?.includes('https://*/*'));
assert(!Object.hasOwn(manifest,'optional_host_permissions'));
const source=path.join(root,'apps/extension/src').replaceAll('\\','/'),probe=path.join(extension,'probe.js');
await writeFile(probe,`export {catalog} from '${source}/comics/repositories/index.ts';
export {readSourceCatalog} from '${source}/sources/runtime/catalog-reader.ts';
export {listSearchSites,listSupportedSites,searchSource} from '${source}/sources/index.ts';
export {definitions} from '${source}/sources/registry/definitions.ts';
export {importCatalog} from '${source}/comics/application/import-service.ts';
export {catalogHtml as guaziCatalogHtml,readerHtml as guaziReaderHtml} from '${source}/sources/sites/guazimanhua/tests/fixtures.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-search.js'}}});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,viewport:{width:1560,height:1120},reducedMotion:'reduce',args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(20_000);
const permissionRequests=[];
await context.exposeBinding('__fixturePermissionRequest',(_,request)=>{permissionRequests.push(request);});
await context.addInitScript(()=>{if(location.protocol==='chrome-extension:'){chrome.permissions.request=request=>{void window.__fixturePermissionRequest(request);throw Error('Unexpected permission request with required host access');};localStorage.setItem('nc-release-notes-version',chrome.runtime.getManifest().version);if(!localStorage.getItem('nc-settings'))localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single',fit:'window',appearance:'light',language:'en'}));if(!localStorage.getItem('nc-search-language'))localStorage.setItem('nc-search-language','zh-Hans');}});
const errors=[],checks=[],requests=[];let titleMode='english',lagoonFail=true,slow=false,slowImport=false,emptyReader=false,guaziCatalog='',guaziReader='';
let groupedResults=false,verificationStatus=403,dm5PageFail=false;
let releaseImport;
const check=message=>{checks.push(message);console.log(message);};
const filterPopover=root=>root.locator('.nc-search-filter-popover');
const expandScope=async root=>{const button=root.locator('.nc-search-scope-expand');if(await button.count()&&await button.getAttribute('aria-expanded')==='false')await button.click();};
const collapseScope=async root=>{const button=root.locator('.nc-search-scope-expand');if(await button.count()&&await button.getAttribute('aria-expanded')==='true')await button.click();};
const expandGroup=async(root,key)=>{const button=root.locator('.nc-search-status-group.is-'+key+' .nc-search-group-toggle');if(await button.getAttribute('aria-expanded')==='false')await button.click();};
const openFilters=async root=>{await root.locator('.nc-search-scope-trigger').click();await filterPopover(root).waitFor();};
const closeFilters=async root=>{await filterPopover(root).getByRole('button',{name:'关闭面板',exact:true}).click();assert.equal(await root.locator('.nc-search-scope-trigger').getAttribute('aria-expanded'),'false');};
const openReaderMore=async root=>{const more=root.getByRole('dialog',{name:'阅读设置',exact:true}).locator('details.nc-reader-more');if(await more.getAttribute('open')===null)await more.locator(':scope > summary').click();};
context.on('page',page=>page.on('pageerror',error=>{if(page.url().startsWith('chrome-extension:'))errors.push(error.message);}));
const image=await readFile(path.join(root,'samples/starlight-bookshop.png'));
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitUntil(operation){const deadline=Date.now()+20_000;while(Date.now()<deadline){if(await operation())return;await pause(100);}throw new Error('Fixture condition timed out');}
function dm5Search(url){
  const query=url.searchParams.get('title'),page=Number(url.searchParams.get('page')||1),empty=query==='nothing';
  const href=n=>'/search?'+new URLSearchParams({title:query,page:String(n)});
  return `<a id="btnSearch" href="${escape(href(1))}">搜索</a><h1>相近搜索结果（${empty?0:1}）</h1><ul class="mh-list col7">${empty?'':`<li><div class="mh-item"><p class="mh-cover" style="background-image:url(https://images.cdndm5.com/search-cover.png)"></p><h2 class="title"><a href="/manhua-searchfixture${page===1?'':'-extra'}/">星光书店${page===1?' · 同名候选':' · 番外'}</a></h2><p class="subtitle"><a>星野葵</a></p><p class="chapter">更新至第 18 话</p></div></li>`}</ul><div class="page-pagination"><a class="active" href="${escape(href(page))}">${page}</a>${!empty&&page===1?`<a href="${escape(href(2))}">2</a>`:''}</div>`;
}
function webtoonSearch(url){
  return `<a href="${escape(url.href)}" aria-current="page">Originals</a>`+(url.searchParams.get('keyword')==='nothing'?'':`<a class="_card_item" data-title-no="7" href="https://www.webtoons.com/en/fantasy/searchfixture/list?title_no=7"><img src="https://webtoon-phinf.pstatic.net/cover.png"><strong class="title">星あかりの本屋</strong><div class="author">星野葵</div></a>`);
}
function themesiaSearch(url){
  const empty=url.searchParams.get('s')==='nothing',title=url.hostname==='lagoonscans.com'?'星光書店':'星光書店 · 另一来源';
  return `<html><body><div class="postbody"><div class="bixbox"><div class="releases"><h1>Search '${escape(url.searchParams.get('s'))}'</h1></div><div class="listupd">${empty?'<center><h3>Not Found</h3></center>':`<div class="bs"><div class="bsx"><a href="${url.origin}/manga/searchfixture/" title="${title}"><img src="https://images.cdndm5.com/search-cover.png"><div class="tt">${title}</div></a></div></div>`}</div>${empty?'':'<div class="pagination"><span class="page-numbers current" aria-current="page">1</span></div>'}</div></div></body></html>`;
}
function guaziSearch(url){
  const query=url.searchParams.get('keyword'),rows=groupedResults||query==='nothing'?[]:[{id:'123',title:'星光书店'},{id:'456',title:'星光书店 新来源'}];
  return `<script type="application/ld+json">${JSON.stringify({'@type':'CollectionPage',name:'搜索：'+query+'漫画',mainEntity:{'@type':'ItemList',numberOfItems:rows.length,itemListElement:rows.map((row,index)=>({'@type':'ListItem',position:index+1,name:row.title,url:'https://www.guazimanhua.com/comic.php?id='+row.id}))}})}</script>${rows.length?rows.map(row=>`<article class="card"><img class="cover" src="https://img.guazicdn.com/th/comics/cover/${row.id}.png"><h3><a href="/comic.php?id=${row.id}">${row.title}</a></h3><div class="meta">星野葵 · 连载中</div></article>`).join(''):'<div class="empty"></div>'}<nav class="pager"><a class="on" href="/category.php?keyword=${encodeURIComponent(query)}">1</a></nav>`;
}
await context.route(/https?:\/\//,async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/v1/comic-titles/translate'){
    requests.push({kind:'title',body:route.request().postDataJSON()});
    return titleMode==='login'?route.fulfill({status:401,json:{error:{code:'AUTH_REQUIRED',message:'Fixture login required'}}}):route.fulfill({json:titleMode==='null'?{name:null,target_language:null}:{name:'The Starlight Bookshop',target_language:'en'}});
  }
  if(url.hostname==='www.dm5.com'&&url.pathname==='/search'){assert(!url.search.includes('+'),'DM5 must use URI encoding for spaces');requests.push({kind:'search',site:'dm5',query:url.searchParams.get('title'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:100);return (dm5PageFail&&url.searchParams.get('page')==='2'?route.fulfill({status:503,body:'Fixture page unavailable'}):route.fulfill({contentType:'text/html; charset=utf-8',body:dm5Search(url)})).catch(()=>{});}
  if(url.hostname==='www.guazimanhua.com'&&url.pathname==='/category.php'){requests.push({kind:'search',site:'guazi',query:url.searchParams.get('keyword'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:900);return route.fulfill({contentType:'text/html; charset=utf-8',body:guaziSearch(url)}).catch(()=>{});}
  if(['lagoonscans.com','asterscans.com'].includes(url.hostname)&&url.searchParams.has('s')){
    requests.push({kind:'search',site:url.hostname,query:url.searchParams.get('s'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:250);
    if(groupedResults&&url.hostname==='asterscans.com')return route.fulfill({status:verificationStatus,headers:verificationStatus===403?{'cf-mitigated':'challenge'}:{},body:'Fixture login or verification required'}).catch(()=>{});
    return lagoonFail?route.fulfill({status:503,body:'Fixture unavailable'}).catch(()=>{}):route.fulfill({contentType:'text/html',body:themesiaSearch(url)}).catch(()=>{});
  }
  if(url.hostname==='www.webtoons.com'&&url.pathname.startsWith('/en/search/')){
    requests.push({kind:'search',site:'webtoons-en',query:url.searchParams.get('keyword'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:400);
    return route.fulfill({contentType:'text/html',body:webtoonSearch(url)}).catch(()=>{});
  }
  if(url.hostname==='comic.naver.com'){
    if(url.pathname.endsWith('/info'))return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',titleName:'星あかりの本屋',posterThumbnailUrl:'https://image-comic.pstatic.net/cover.png'}});
    if(url.pathname==='/api/article/list')return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',sort:'ASC',totalCount:1,pageInfo:{page:1,totalPages:1,totalRows:1,pageSize:20},articleList:[{no:1,subtitle:'原作 第 1 话'}]}});
    if(url.pathname==='/webtoon/detail'&&emptyReader)return route.fulfill({status:503,body:'Fixture unavailable chapter'});
    if(url.pathname==='/webtoon/detail')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<a aria-current="true" href="/webtoon/detail?titleId=123&amp;no=1">Current</a><div class="wt_viewer">${[0,1,2].map(n=>`<img id="content_image_${n}" src="https://image-comic.pstatic.net/webtoon/123/1/${n}.png">`).join('')}</div>`});
  }
  if(url.hostname==='www.guazimanhua.com'){
    const fresh=url.searchParams.get('id')==='456'||url.searchParams.get('id')==='21';
    if(fresh&&slowImport&&url.pathname==='/comic.php')await new Promise(resolve=>{releaseImport=resolve;});
    let body=url.pathname==='/chapter.php'?guaziReader:guaziCatalog;
    if(fresh)body=body.replaceAll('id=123','id=456').replaceAll('id=11','id=21').replaceAll('星光书店','星光书店 新来源');
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  }
  if(['image-comic.pstatic.net','img.guazicdn.com','images.cdndm5.com','webtoon-phinf.pstatic.net'].includes(url.hostname))return route.fulfill({contentType:'image/png',body:image});
  if(url.pathname.startsWith('/v1/'))return route.fulfill({status:503,json:{error:{code:'FIXTURE_OFFLINE',message:'Isolated fixture'}}});
  return route.abort();
});

let reader;
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),home=new URL('reader.html',worker.url()).href;
  await waitUntil(()=>worker.evaluate(()=>typeof chrome.permissions?.request==='function'));
  await worker.evaluate(()=>{globalThis.__fixturePermissionRequests=0;chrome.permissions.request=()=>{globalThis.__fixturePermissionRequests++;throw Error('Unexpected background permission request with required host access');};});
  reader=await context.newPage();await reader.goto(home);await reader.locator('.nc-library').waitFor();
  const adultAudit=await reader.evaluate(async()=>{
    const probe=await import(chrome.runtime.getURL('verify-search.js'));
    const adult=probe.definitions.flatMap(adapter=>(adapter.sites??[]).filter(site=>site.isAdult).map(site=>({adapterId:adapter.id,...site})));
    const visible=new Set(probe.listSupportedSites().map(site=>site.key));
    localStorage.setItem('nc-site-favorites',JSON.stringify(adult.map(site=>site.adapterId+':'+site.id)));
    localStorage.setItem('nc-search-sites',JSON.stringify(Object.fromEntries(adult.map(site=>[site.adapterId+':'+site.id,true]))));
    return {keys:adult.map(site=>site.adapterId+':'+site.id),count:adult.length,exposed:adult.filter(site=>visible.has(site.adapterId+':'+site.id)).length,
      searchKeys:probe.listSearchSites().map(site=>site.key).sort(),
      capableKeys:probe.definitions.flatMap(adapter=>(adapter.sites??[]).filter(site=>site.search).map(site=>adapter.id+':'+site.id)).sort(),
      publicKeys:probe.listSupportedSites().map(site=>site.key).sort()};
  });
  assert.deepEqual(adultAudit.keys.sort(),['nhentaicom:nhentaicom','nhentaito:nhentaito']);assert.equal(adultAudit.exposed,adultAudit.count);assert.deepEqual(adultAudit.searchKeys,adultAudit.capableKeys);assert.equal(requests.length,0);
  await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'漫画网站',exact:true}).click();
  assert.equal(await reader.locator('[data-site-key="nhentaicom:nhentaicom"] .nc-site-adult').innerText(),'18+ 成人');
  assert.equal(await reader.locator('[data-site-key]').first().getAttribute('data-site-key'),'nhentaito:nhentaito');
  assert.equal(await reader.locator('[data-site-key="mangacopy:copy4000"],[data-site-key="pixiv:pixiv"],[data-site-key="mangadex:mangadex"]').count(),3);
  assert.deepEqual((await reader.locator('[data-site-key]').evaluateAll(cards=>cards.map(card=>card.dataset.siteKey))).sort(),adultAudit.publicKeys);
  await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'我的漫画',exact:true}).click();
  check(`${adultAudit.count} adult entries remain visible, labeled and favoritable; search scope follows implemented capabilities`);
  const fixtures=await reader.evaluate(async()=>{const probe=await import(chrome.runtime.getURL('verify-search.js'));return {catalog:probe.guaziCatalogHtml(['11']).replaceAll('Fixture comic','星光书店').replace('<script>throw Error(\'never execute\')</script>',''),reader:probe.guaziReaderHtml()};});
  guaziCatalog=fixtures.catalog;guaziReader=fixtures.reader;
  const imported=await reader.evaluate(async()=>{const probe=await import(chrome.runtime.getURL('verify-search.js'));const rows=[];for(const url of ['https://comic.naver.com/webtoon/list?titleId=123','https://www.guazimanhua.com/comic.php?id=123']){const comic=await probe.importCatalog(await probe.readSourceCatalog(url));rows.push({id:comic.id,title:comic.title});}return rows;});
  const card=id=>reader.locator(`[data-comic-id="${id}"]`),panel=()=>reader.locator('dialog.nc-comic-search[open]');
  const seed=imported.find(row=>row.title==='星あかりの本屋');assert(seed);
  const openShelf=async()=>{await card(seed.id).getByRole('button',{name:'打开漫画 '+seed.title,exact:true}).click({button:'right'});await reader.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();};
  await card(seed.id).locator('.nc-thumbnail img').waitFor();await openShelf();
  assert.equal(requests.length,0,'Opening must not query sites or the title service');
  await panel().locator('.nc-search-origin-cover img').waitFor();check('Production shelf entry opens with existing cover and performs no title/site search');
  const language=panel().getByRole('combobox',{name:'名称目标语言',exact:true});
  await language.click();assert.equal(await panel().getByRole('option',{name:'中文',exact:true}).count(),0);assert.equal(await panel().getByRole('option',{name:'简体中文',exact:true}).count(),1);assert.equal(await panel().getByRole('option',{name:'繁體中文',exact:true}).count(),1);
  await panel().getByRole('option',{name:'繁體中文',exact:true}).click();assert.equal(await language.getAttribute('data-value'),'zh-Hant');await language.click();await panel().getByRole('option',{name:'简体中文',exact:true}).click();assert.equal(await language.getAttribute('data-value'),'zh-Hans');assert.equal(requests.length,0);
  check('Name language offers only Simplified and Traditional Chinese, and switching options makes no requests');
  await language.click();assert.equal(await language.getAttribute('aria-expanded'),'true');await language.press('Escape');assert.equal(await language.getAttribute('aria-expanded'),'false');assert.equal(await panel().count(),1);
  await panel().getByRole('button',{name:'关闭查找面板',exact:true}).focus();await reader.keyboard.press('Shift+Tab');assert(await panel().evaluate(element=>element.contains(document.activeElement)));check('Shared Select popover and Escape work inside native dialog; focus remains trapped');

  assert.equal(await panel().locator('.nc-search-site-options').isVisible(),true);
  assert.equal(await panel().locator('.nc-search-site-option').count(),10);
  const availableSites=await reader.evaluate(async()=>{const probe=await import(chrome.runtime.getURL('verify-search.js'));return probe.listSearchSites();});
  const scope=panel().locator('.nc-search-scope'),filters=filterPopover(panel());
  assert.equal(await filters.isVisible(),false);
  await scope.getByRole('button',{name:'反选',exact:true}).click();
  assert.match(await scope.locator('.nc-search-scope-heading>span').innerText(),/已选 0 个网站/);
  await scope.getByRole('button',{name:'全选',exact:true}).click();
  assert.match(await scope.locator('.nc-search-scope-heading>span').innerText(),new RegExp('已选 '+availableSites.length+' 个网站'));
  await expandScope(panel());assert.equal(await scope.locator('.nc-search-site-option').count(),availableSites.length);
  assert(await scope.locator('.nc-search-site-option input').evaluateAll(inputs=>inputs.every(input=>input.checked)));
  await collapseScope(panel());assert.equal(await scope.locator('.nc-search-site-option').count(),10);
  await reader.screenshot({path:path.join(out,'search-sites-collapsed.png')});
  await openFilters(panel());assert.equal(await reader.locator('dialog[open]').count(),1,'Filters must not add a modal');
  const filterBounds=await filters.boundingBox(),triggerBounds=await scope.locator('.nc-search-scope-trigger').boundingBox();
  assert(filterBounds.x+filterBounds.width<=triggerBounds.x,'Desktop filters open to the left of their trigger');
  await reader.keyboard.press('Escape');assert.equal(await panel().count(),1);assert.equal(await filters.isVisible(),false);
  assert(await scope.locator('.nc-search-scope-trigger').evaluate(element=>element===document.activeElement));
  await expandScope(panel());await openFilters(panel());
  await filters.getByRole('button',{name:'免费',exact:true}).click();
  const freeSites=availableSites.filter(site=>site.pricing==='free');
  assert.equal(await scope.locator('.nc-search-site-option').count(),freeSites.length);
  await closeFilters(panel());
  assert(await scope.getByRole('button',{name:'全选',exact:true}).isDisabled());
  await scope.getByRole('button',{name:'反选',exact:true}).click();
  assert.equal(await scope.locator('.nc-search-site-option input:checked').count(),0);
  assert(await panel().locator('.nc-search-form .button.primary').isDisabled());
  await openFilters(panel());await filters.getByRole('button',{name:'清空筛选',exact:true}).click();await closeFilters(panel());
  assert.equal(await scope.locator('.nc-search-site-option input:checked').count(),availableSites.length-freeSites.length,'Inverting filtered sites preserves excluded selections');
  await openFilters(panel());await filters.getByRole('button',{name:'免费',exact:true}).click();await closeFilters(panel());
  await scope.locator('.nc-search-site-option input').first().check();
  await scope.getByRole('button',{name:'反选',exact:true}).click();
  assert.equal(await scope.locator('.nc-search-site-option input:checked').count(),freeSites.length-1,'Invert flips every matched choice');
  await scope.getByRole('button',{name:'全选',exact:true}).click();
  assert.equal(await scope.locator('.nc-search-site-option input:checked').count(),freeSites.length);
  check('Ten inline sites show by default; expand/collapse preserves selection; batch actions include collapsed matches but preserve filter-excluded choices');
  await openFilters(panel());
  await filters.getByRole('button',{name:'部分收费',exact:true}).click();await filters.getByRole('button',{name:'同人',exact:true}).click();
  assert.equal(await scope.locator('.nc-search-site-option').count(),availableSites.filter(site=>['free','freemium'].includes(site.pricing)&&site.contentTags.includes('doujin')).length);
  await filters.getByRole('button',{name:'更多筛选',exact:true}).click();await filters.getByRole('button',{name:'生肉为主',exact:true}).click();await filters.getByRole('button',{name:'需要登录',exact:true}).click();
  assert.equal(await scope.locator('.nc-search-site-option').count(),availableSites.filter(site=>['free','freemium'].includes(site.pricing)&&site.contentTags.includes('doujin')&&site.isRaw&&site.accessTags?.includes('login-required')).length);
  assert.equal(requests.length,0);await filters.getByRole('button',{name:'清空筛选',exact:true}).click();await closeFilters(panel());
  await collapseScope(panel());await openFilters(panel());
  check('Anchored nonmodal filters reuse all four directory groups with OR/AND semantics; Escape restores trigger focus without closing the parent sheet');
  await reader.screenshot({path:path.join(out,'search-sites.png')});
  await reader.evaluate(()=>{document.documentElement.dataset.appearance='dark';});await reader.screenshot({path:path.join(out,'search-sites-dark.png')});await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  await reader.setViewportSize({width:390,height:844});
  await waitUntil(async()=>{const bounds=await filters.boundingBox();return bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=390&&bounds.y+bounds.height<=844;});
  const compactFilter=await filters.boundingBox();assert(compactFilter.x>=0&&compactFilter.y>=0&&compactFilter.x+compactFilter.width<=390&&compactFilter.y+compactFilter.height<=844);
  await reader.screenshot({path:path.join(out,'search-sites-mobile.png')});await reader.setViewportSize({width:1560,height:1120});
  await panel().getByRole('textbox',{name:'原作品名称',exact:true}).click();
  assert.equal(await filters.isVisible(),false);assert.equal(await panel().count(),1,'Outside click remains usable without a modal overlay');
  await expandScope(panel());
  const siteInputs=scope.locator('.nc-search-site-option input');assert(await siteInputs.evaluateAll(inputs=>inputs.every(input=>input.checked&&!input.disabled)));
  await reader.waitForFunction(()=>[...document.querySelectorAll('.nc-search-site-option img,.nc-search-language img')].every(image=>image.complete&&image.naturalWidth>0));
  const optionsLayout=await scope.locator('.nc-search-site-options').evaluate(element=>({columns:getComputedStyle(element).gridTemplateColumns.split(' ').length,icons:element.querySelectorAll('img').length}));
  assert.equal(optionsLayout.columns,5);assert.equal(optionsLayout.icons,await siteInputs.count());
  const sheetBounds=await panel().boundingBox();assert(sheetBounds.width>1300);assert.equal(Math.round(sheetBounds.y+sheetBounds.height),1120);
  const languageBounds=await language.boundingBox(),translateBounds=await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).boundingBox();
  assert(languageBounds.width>=120&&languageBounds.x+languageBounds.width<=translateBounds.x);
  assert(Math.abs(languageBounds.y+languageBounds.height-translateBounds.y-translateBounds.height)<1,'Target language and search action share the left-column row');
  // Keep this suite's fixed HTTP fixtures independent of newly discovered search adapters.
  const fixtureSites=new Set(['动漫屋 DM5','瓜子漫画','Lagoon Scans','Aster Scans','WEBTOON · English']);
  await scope.getByRole('button',{name:'反选',exact:true}).click();
  for(const name of fixtureSites)await scope.getByRole('checkbox',{name,exact:true}).check();
  const excludedOption=panel().locator('.nc-search-site-option').filter({hasText:'Aster Scans'});await excludedOption.locator('input').uncheck();
  await collapseScope(panel());

  await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();
  await panel().locator('.nc-search-result').first().waitFor();assert.equal(await panel().locator('.nc-search-result').count(),1);assert.match(await panel().locator('.nc-search-query').innerText(),/名称语言为English/);assert.equal(await language.getAttribute('data-value'),'zh-Hans');
  await expandScope(panel());const guaziOption=panel().locator('.nc-search-site-option').filter({hasText:'瓜子漫画'}).locator('input');await guaziOption.uncheck();
  assert.equal(await panel().locator('.nc-search-status').filter({hasText:'瓜子漫画'}).count(),1);assert(await panel().locator('.nc-search-result').count()>=1);
  await panel().locator('.nc-search-status.is-error').waitFor({state:'attached'});await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===4);
  assert.equal(requests.filter(request=>request.kind==='search'&&request.site==='guazi').length,1);await guaziOption.check();await collapseScope(panel());check('Editing the next search scope during requests keeps this round running and its arrived results visible');
  await panel().locator('.nc-search-result-cover img').first().waitFor();check('English title fallback only changes the search name; first site is visible before slower sites and covers load independently');
  const webtoonResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星あかりの本屋',exact:true})});assert.equal(await webtoonResult.getByRole('img',{name:'English',exact:true}).count(),1);assert.equal(await webtoonResult.locator('.nc-search-result-languages [role=img]').count(),1);const noLanguageResults=panel().locator('.nc-search-result').filter({hasNot:reader.getByRole('heading',{name:'星あかりの本屋',exact:true})});assert.equal(await noLanguageResults.locator('.nc-search-result-languages').count(),0);assert.equal(await panel().getByRole('checkbox',{name:'只看语言已确认',exact:true}).count(),0);assert.equal(await panel().getByText('语言待确认',{exact:true}).count(),0);check('Site-supplied languages use accessible flag icons; unknown languages have no placeholder or confirmed-language filter');
  const webtoonFilter=panel().locator('.nc-search-status').filter({hasText:'WEBTOON · English'}),beforeFilter=requests.length;
  await webtoonFilter.click();assert.equal(await webtoonFilter.getAttribute('aria-pressed'),'true');assert.equal(await panel().locator('.nc-search-result').count(),1);assert(await webtoonResult.isVisible());
  await webtoonFilter.press('Enter');assert.equal(await webtoonFilter.getAttribute('aria-pressed'),'false');assert.equal(await panel().locator('.nc-search-result').count(),4);assert.equal(requests.length,beforeFilter);check('Site click filters immediately; pressing Enter on the same site restores all candidates without network requests');
  const failed=panel().locator('.nc-search-status').filter({hasText:'Lagoon Scans'});await expandGroup(panel(),'failed');await failed.click();assert.equal(await panel().locator('.nc-search-result').count(),0);
  const siteDetails=panel().locator('.nc-search-status-detail'),retry=siteDetails.getByRole('button',{name:'重试此网站',exact:true});
  assert.equal(await panel().getByRole('button',{name:'显示全部网站',exact:true}).count(),0);assert.equal(await panel().locator('.nc-search-empty,.nc-search-match-note').count(),0);
  assert.equal(await siteDetails.getByRole('heading',{name:'Lagoon Scans',exact:true}).count(),1);assert.equal(await siteDetails.getByRole('link',{name:'打开来源',exact:true}).count(),1);
  const summaryBounds=await siteDetails.locator('.nc-search-detail-summary').boundingBox(),actionsBounds=await siteDetails.locator('.nc-search-detail-actions').boundingBox(),retryBounds=await retry.boundingBox();assert(actionsBounds.x>=summaryBounds.x+summaryBounds.width);assert(retryBounds.height>=40);
  await panel().locator('.nc-search-results').screenshot({path:path.join(out,'site-retry-light.png')});await reader.evaluate(()=>{document.documentElement.dataset.appearance='dark';});await panel().locator('.nc-search-results').screenshot({path:path.join(out,'site-retry-dark.png')});await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  lagoonFail=false;slow=true;const titleCalls=requests.filter(request=>request.kind==='title').length;await retry.click();
  const working=siteDetails.getByRole('button',{name:'搜索中',exact:true});await working.waitFor();assert(await working.isDisabled());const workingBounds=await working.boundingBox();assert(Math.abs(workingBounds.x-retryBounds.x)<1);assert.equal(await siteDetails.getByRole('button',{name:'加载更多',exact:true}).count(),0);
  await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===1);slow=false;await failed.click();assert.equal(await panel().locator('.nc-search-result').count(),5);assert.equal(await siteDetails.count(),0);assert.equal(requests.filter(request=>request.kind==='title').length,titleCalls);
  check('Selected-site actions stay grouped at the right, retry shows progress in place, and toggling the site clears the filter without a redundant all-sites button or empty panel');
  const dm5=panel().locator('.nc-search-status').filter({hasText:'动漫屋 DM5'});await dm5.click();assert.equal(await panel().locator('.nc-search-result').count(),1);await panel().getByRole('button',{name:'加载更多',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===2);await dm5.click();assert.equal(await panel().locator('.nc-search-result').count(),6);assert.equal(requests.filter(request=>request.kind==='title').length,titleCalls);check('Filtered single-site retry and cursor pagination append without another name lookup; toggling off retains every result');
  const heading=await panel().locator('.nc-search-result-heading h2').boundingBox(),progress=await panel().locator('.nc-search-progress').boundingBox();assert(progress.x>heading.x+heading.width);assert(Math.abs(progress.y-heading.y)<8);
  await reader.waitForFunction(()=>[...document.querySelectorAll('.nc-search-status img,.nc-search-result-source img,.nc-search-result-languages img')].every(image=>image.complete&&image.naturalWidth>0));
  const resultSize=await panel().locator('.nc-search-result').first().boundingBox(),coverSize=await panel().locator('.nc-search-result-cover').first().boundingBox();assert(resultSize.height<=230);assert(coverSize.width>=112&&coverSize.height>=168);assert.equal(await panel().locator('.nc-search-result-list').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length),2);
  const sourceOrder=await panel().locator('.nc-search-result-source>span:last-child').allTextContents();assert.equal(new Set(sourceOrder.slice(0,4)).size,4);assert.equal(sourceOrder[4],sourceOrder[0]);assert.equal(sourceOrder[5],sourceOrder[2]);
  const siteIconSizes=await panel().locator('.nc-search-status').evaluateAll(elements=>elements.map(element=>{
    const icon=element.querySelector('.nc-search-site-icon').getBoundingClientRect(),name=element.querySelector('b').getBoundingClientRect(),count=element.querySelector('.nc-search-site-count').getBoundingClientRect();
    return {height:element.getBoundingClientRect().height,iconWidth:icon.width,iconHeight:icon.height,nameRight:name.right,countLeft:count.left};
  }));for(const size of siteIconSizes){assert(size.height>=44&&size.height<=56);assert.equal(size.iconWidth,22);assert.equal(size.iconHeight,22);assert(size.countLeft>size.nameRight);}
  const badge=await panel().locator('.nc-search-result-source').first().evaluate(element=>({font:parseFloat(getComputedStyle(element).fontSize),icon:element.querySelector('.nc-search-site-icon').getBoundingClientRect().height}));assert(badge.font>=12&&badge.icon>=20);
  const beforeScopeEdit=requests.length;await dm5.click();const filteredTitles=await panel().locator('.nc-search-result h3').allTextContents();
  await expandScope(panel());const selectedScope=[];for(const input of await panel().locator('.nc-search-site-option input').all())if(await input.isChecked()){selectedScope.push(input);await input.uncheck();}
  assert.deepEqual(await panel().locator('.nc-search-result h3').allTextContents(),filteredTitles);assert.equal(await dm5.getAttribute('aria-pressed'),'true');assert.equal(await panel().locator('.nc-search-status').count(),4);assert.equal(requests.length,beforeScopeEdit);assert(await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).isDisabled());
  for(const input of selectedScope)await input.check();await collapseScope(panel());await dm5.click();assert.equal(await panel().locator('.nc-search-result').count(),6);assert.equal(requests.length,beforeScopeEdit);
  check('Results interleave sites and pagination; scope edits preserve the current filter, site controls and results, including an empty next scope; compact site rows retain readable names, 22px icons, candidate counts and 44px click targets');
  await panel().screenshot({path:path.join(out,'search-light.png')});
  await reader.evaluate(()=>{document.documentElement.dataset.appearance='dark';});await panel().screenshot({path:path.join(out,'search-dark.png')});await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  check('Wide bottom sheet, inline site options, inline progress and two-column results render in both themes');
  const beforeClose=requests.length,savedScroll=await panel().locator('.nc-search-body').evaluate(element=>{element.scrollTop=240;return element.scrollTop;});await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();await openShelf();assert.equal(await panel().locator('.nc-search-result').count(),6);assert.equal(await panel().locator('.nc-search-body').evaluate(element=>element.scrollTop),savedScroll);assert.equal(requests.length,beforeClose);assert.match(await panel().locator('.nc-search-progress>span').first().getAttribute('title'),/上次查找/);check('Closing/reopening retains grouped results, scroll position and last-search time without new search traffic');
  await expandScope(panel());assert(!await excludedOption.locator('input').isChecked());
  await language.click();await panel().locator('[role=option][data-value=ja]').click();for(const option of await panel().locator('.nc-search-site-option').all())assert(!await option.locator('input').isDisabled());assert(await panel().locator('.nc-search-site-option').filter({hasText:'WEBTOON · English'}).locator('input').isChecked());await collapseScope(panel());const originalNameCalls=requests.filter(request=>request.kind==='title').length;await panel().getByRole('button',{name:'使用原名搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===5);assert.equal(requests.filter(request=>request.kind==='title').length,originalNameCalls);assert(await webtoonResult.isVisible());assert(requests.some(request=>request.site==='webtoons-en'&&request.query==='星あかりの本屋'));assert.equal(await noLanguageResults.locator('.nc-search-result-languages').count(),0);for(const request of requests.filter(request=>request.kind==='search'))assert(!(request.parameters??[]).some(key=>/language/i.test(key)),request.site+' must search by name without a language parameter');check('Japanese-name search includes WEBTOON English releases and every selected site without request language filters');await webtoonResult.scrollIntoViewIfNeeded();await reader.screenshot({path:path.join(out,'name-only-search.png')});
  slow=true;await panel().getByRole('button',{name:'重新搜索',exact:true}).click();await panel().getByRole('button',{name:'停止查找',exact:true}).click();await pause(2_700);assert.equal(await panel().locator('.nc-search-result').count(),0);assert.match(await panel().locator('.nc-search-progress').innerText(),/已停止/);
  await panel().getByRole('button',{name:'重新搜索',exact:true}).click();await language.click();await panel().locator('[role=option][data-value=en]').click();await pause(2_700);assert.equal(await panel().locator('.nc-search-result').count(),0);assert.equal(await panel().locator('.nc-search-progress').count(),0);check('Stopped and language-replaced requests never publish delayed fixture results');slow=false;
  await language.click();await panel().locator('[role=option][data-value=zh-Hans]').click();titleMode='null';await panel().getByPlaceholder('请输入漫画作品名称').fill('星あかりの本屋 別題');await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();await panel().getByText('未找到常用简体中文名称，请手动输入或明确使用原名搜索。',{exact:true}).waitFor();assert.equal(await panel().locator('.nc-search-result').count(),0);
  // Changing the source name bypasses the per-name result cache, as a user correction would.
  await panel().getByPlaceholder('请输入漫画作品名称').fill('星あかりの本屋 修正');titleMode='login';await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();await panel().getByText('登录后可自动查找名称，也可以手动输入。',{exact:true}).waitFor();
  await panel().getByPlaceholder('输入漫画名称或别名').fill('星光书店');await panel().getByRole('button',{name:'搜索网站',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length>=5);check('Null title requires explicit input; 401 leaves manual site searching fully usable');
  const existingResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星光书店',exact:true})});assert.match(await existingResult.innerText(),/已在书架/);await existingResult.getByRole('button',{name:'继续阅读',exact:true}).click();await reader.locator('.nc-reader').waitFor();await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth>0);check('Existing source identity shows the bookshelf badge and continues through the real reader');
  await setReaderProgress(reader.getByRole('slider',{name:'阅读进度',exact:true}), '2');await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
  await reader.getByRole('button',{name:'打开目录',exact:true}).click();assert.equal(await reader.locator('.nc-reader-drawer').getByRole('button',{name:'寻找其他语言',exact:true}).count(),0);await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.screenshot({path:path.join(out,'reader-settings.png')});await openReaderMore(reader);await reader.locator('.nc-reader-drawer[aria-label="阅读设置"]').getByRole('button',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();assert.equal(await panel().getByPlaceholder('请输入漫画作品名称').inputValue(),'星光书店');await reader.keyboard.press('ArrowRight');await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();assert.equal(await reader.getByRole('slider',{name:'阅读进度',exact:true}).inputValue(),'2');assert(await reader.getByRole('button',{name:'阅读设置',exact:true}).evaluate(element=>element===document.activeElement));check('Reader settings owns the search entry; directory has none; search preserves work title/page 2 and returns focus to the settings trigger');
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await openShelf();await panel().getByRole('button',{name:'使用原名搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length>=5);await panel().getByPlaceholder('输入漫画名称或别名').fill('星光书店');await panel().getByRole('button',{name:/^(?:重新搜索|搜索网站)$/,exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length>=5);
  const freshResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星光书店 新来源',exact:true})});slowImport=true;await freshResult.getByRole('button',{name:'导入并阅读',exact:true}).click();await waitUntil(()=>!!releaseImport);assert(await panel().getByRole('combobox',{name:'名称目标语言',exact:true}).isDisabled());await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();slowImport=false;releaseImport();
  await waitUntil(()=>reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-search.js'));return (await catalog.list('comics')).some(comic=>comic.title==='星光书店 新来源');}));
  const saved=await reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-search.js'));const comics=await catalog.list('comics');return {count:comics.length,original:comics.find(comic=>comic.title==='星あかりの本屋')?.id};});assert.equal(saved.count,3);assert.equal(saved.original,seed.id);assert.equal(await reader.locator('.nc-reader').count(),0);assert.equal(await reader.locator('.nc-library').count(),1);check('New-source import preserves the original record; closing during slow import prevents late navigation');
  emptyReader=true;await card(seed.id).getByRole('button',{name:'打开漫画 '+seed.title,exact:true}).click();await reader.locator('.nc-reader .nc-empty').waitFor();assert.equal(await reader.locator('.nc-page-image').count(),0);
  await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.screenshot({path:path.join(out,'reader-empty-settings.png')});await openReaderMore(reader);await reader.locator('.nc-reader-drawer[aria-label="阅读设置"]').getByRole('button',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();assert.equal(await panel().getByPlaceholder('请输入漫画作品名称').inputValue(),seed.title);await reader.keyboard.press('Escape');await reader.locator('.nc-reader .nc-empty').waitFor();assert(await reader.getByRole('button',{name:'阅读设置',exact:true}).evaluate(element=>element===document.activeElement));check('Unavailable chapter still exposes reading settings and work-title search; Escape returns to the empty reader settings trigger');await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  // Content script is installed in the same isolated profile; source HTML remains a fixture.
  const website=await context.newPage();await website.goto('https://www.guazimanhua.com/comic.php?id=123');await website.getByRole('button',{name:'寻找其他语言',exact:true}).waitFor();
  const nextPage=context.waitForEvent('page');await website.getByRole('button',{name:'寻找其他语言',exact:true}).click();const target=await nextPage;await target.waitForLoadState();await target.locator('dialog.nc-comic-search[open]').waitFor();assert.equal(await target.getByPlaceholder('请输入漫画作品名称').inputValue(),'星光书店');assert(!target.url().includes(encodeURIComponent('星光书店')));await target.screenshot({path:path.join(out,'website-entry.png')});check('Website content-script entry creates the trusted extension search page with a one-use seed and no title in URL');
  // Hold the real seed lock in a second extension page so user actions can overtake consumption.
  const delayedSeedPage=async()=>{
    const id=await reader.evaluate(async()=>{
      const id=crypto.randomUUID(),key='nc-search-seed:'+id;
      await chrome.storage.session.set({[key]:{createdAt:Date.now(),seed:{title:'迟到的漫画种子',origin:{sourceId:'guazimanhua',catalogId:'guazimanhua:123',url:'https://www.guazimanhua.com/comic.php?id=123'}}}});
      let started;const ready=new Promise(resolve=>{started=resolve;});
      void navigator.locks.request(key,()=>{started();return new Promise(resolve=>{window.__releaseSearchSeed=resolve;});});await ready;return id;
    });
    const page=await context.newPage();await page.goto(home+'?search='+id);await page.locator('.nc-library').waitFor();
    await waitUntil(()=>reader.evaluate(async id=>(await navigator.locks.query()).pending.some(lock=>lock.name==='nc-search-seed:'+id),id));
    return {id,page};
  };
  const replacement=await delayedSeedPage();
  await replacement.page.locator(`[data-comic-id="${seed.id}"]`).getByRole('button',{name:'打开漫画 '+seed.title,exact:true}).click({button:'right'});await replacement.page.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click();await replacement.page.locator('dialog.nc-comic-search[open]').waitFor();
  await replacement.page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('kept','newer-query');history.replaceState(null,'',url);});
  await reader.evaluate(()=>window.__releaseSearchSeed());await waitUntil(async()=>!new URL(replacement.page.url()).searchParams.has('search'));
  assert.equal(await replacement.page.getByPlaceholder('请输入漫画作品名称').inputValue(),seed.title);assert.equal(new URL(replacement.page.url()).searchParams.get('kept'),'newer-query');await replacement.page.close();check('A delayed website seed cannot replace a newer bookshelf search; consumed-handle cleanup preserves newer query parameters');
  const navigation=await delayedSeedPage(),newHandle='12345678-1234-1234-1234-123456789abc';
  await navigation.page.getByRole('button',{name:'漫画网站',exact:true}).click();await navigation.page.evaluate(id=>{const url=new URL(location.href);url.searchParams.set('search',id);history.replaceState(null,'',url);},newHandle);
  await reader.evaluate(()=>window.__releaseSearchSeed());await navigation.page.evaluate(async id=>{await navigator.locks.request('nc-search-seed:'+id,()=>{});await new Promise(resolve=>setTimeout(resolve,50));},navigation.id);
  assert.equal(await navigation.page.locator('dialog.nc-comic-search[open]').count(),0);assert.equal(new URL(navigation.page.url()).hash,'#sites');assert.equal(new URL(navigation.page.url()).searchParams.get('search'),newHandle);await navigation.page.close();check('Navigation supersedes a delayed seed and its finalizer does not delete a different, newer handle');
  const searchPage=()=>reader.locator('.nc-search-page'),beforePage=requests.length;
  await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'搜索漫画',exact:true}).click();await searchPage().waitFor();
  assert.equal(new URL(reader.url()).hash,'#search');assert.equal(await panel().count(),0);assert.equal(requests.length,beforePage);assert.equal(await searchPage().getByPlaceholder('输入漫画名称或别名').inputValue(),'');
  assert.equal(await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'搜索漫画',exact:true}).getAttribute('aria-current'),'page');
  assert.equal(await searchPage().locator('.nc-search-header,.nc-page-heading').count(),0);
  const nameInput=searchPage().getByRole('textbox',{name:'搜索名称',exact:true});
  for(const width of [1560,1280,1024,768,390]){
    await reader.setViewportSize({width,height:1120});
    const nameBounds=await nameInput.boundingBox(),submitBounds=await searchPage().getByRole('button',{name:'搜索网站',exact:true}).boundingBox();
    assert(nameBounds.width>120&&nameBounds.width<=481,'Name input stays usable and bounded: '+JSON.stringify({width,nameBounds}));
    assert(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow at '+width);
    const controlsBounds=await searchPage().locator('.nc-search-controls').boundingBox(),scopeBounds=await searchPage().locator('.nc-search-scope').boundingBox();
    if(width>=1024){
      assert(Math.abs(nameBounds.y-submitBounds.y)<1);
      assert(controlsBounds.x+controlsBounds.width<scopeBounds.x,'Desktop search controls sit to the left of the scope');
      assert(Math.abs(controlsBounds.y-scopeBounds.y)<1,'Both desktop columns start on the same row');
    }else assert(scopeBounds.y>=controlsBounds.y+controlsBounds.height,'Narrow containers stack the scope below the controls');
    await searchPage().getByRole('button',{name:'翻译名称搜索',exact:true}).click();
    const sourceBounds=await searchPage().getByRole('textbox',{name:'原作品名称',exact:true}).boundingBox();
    assert(sourceBounds.width>120&&sourceBounds.width<=481);
    if(width>=1024)assert((await searchPage().locator('.nc-search-language .nc-select').boundingBox()).width>=156,'Desktop language selector keeps readable text');
    assert(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Translated search fits at '+width);
    if(width===390)await reader.screenshot({path:path.join(out,'search-page-mobile.png')});
    await searchPage().getByRole('button',{name:'直接搜索',exact:true}).click();
  }
  await reader.setViewportSize({width:1560,height:1120});
  check('Search page removes its banner; desktop controls and scope share two columns, narrow screens stack them and both name modes stay within 480px across five viewport sizes');
  await expandScope(searchPage());const pageExcluded=searchPage().locator('.nc-search-site-option').filter({hasText:'Aster Scans'}).locator('input');assert(!await pageExcluded.isChecked());await pageExcluded.check();await collapseScope(searchPage());assert.equal(requests.length,beforePage);check('The standalone page restores the scope saved by the other-language sheet without making requests');
  await reader.screenshot({path:path.join(out,'search-page-empty.png')});
  const pageTitleCalls=requests.filter(request=>request.kind==='title').length;
  await searchPage().getByPlaceholder('输入漫画名称或别名').fill('星光书店');await searchPage().getByPlaceholder('输入漫画名称或别名').press('Enter');
  await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===5);assert.equal(await searchPage().locator('.nc-search-result').count(),6);assert.equal(requests.filter(request=>request.kind==='title').length,pageTitleCalls);
  await reader.waitForFunction(()=>[...document.querySelectorAll('.nc-search-page .nc-search-result-cover img')].some(image=>image.naturalWidth>0));
  const beforeScopeFilter=requests.length;
  await openFilters(searchPage());await filterPopover(searchPage()).getByRole('button',{name:'部分收费',exact:true}).click();await filterPopover(searchPage()).getByRole('button',{name:'条漫',exact:true}).click();
  await filterPopover(searchPage()).getByRole('button',{name:'更多筛选',exact:true}).click();await filterPopover(searchPage()).getByRole('button',{name:'网页只开放部分',exact:true}).click();
  assert.match(await searchPage().locator('.nc-search-scope-heading>span').innerText(),/已选 1 个网站/);assert.equal(requests.length,beforeScopeFilter);assert.equal(await searchPage().locator('.nc-search-result').count(),6);
  await closeFilters(searchPage());await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();
  await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===1);
  assert.equal(await searchPage().locator('.nc-search-status').count(),1);assert.equal(await searchPage().locator('.nc-search-result').count(),1);
  assert.deepEqual(requests.slice(beforeScopeFilter).filter(request=>request.kind==='search').map(request=>request.site),['webtoons-en']);
  await openFilters(searchPage());await filterPopover(searchPage()).getByRole('button',{name:'清空筛选',exact:true}).click();await closeFilters(searchPage());await expandScope(searchPage());
  assert.equal(await searchPage().locator('.nc-search-site-option input:checked').count(),5);assert.equal(await searchPage().locator('.nc-search-result').count(),1);
  await collapseScope(searchPage());await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===5);
  check('Pricing/content/access filters constrain real fixture requests to the checked matching sites; clearing filters restores selections without replacing results until resubmission');
  for(const appearance of ['light','dark']){
    await reader.evaluate(value=>{document.documentElement.dataset.appearance=value;},appearance);
    const styles=await reader.evaluate(()=>{
      const read=selector=>{const style=getComputedStyle(document.querySelector(selector));return {border:style.borderTop,shadow:style.boxShadow,radius:style.borderRadius};};
      return {navigation:read('.nc-app-header nav [aria-current=page]'),card:read('.nc-search-page .nc-search-result'),action:read('.nc-search-page .nc-search-submit-row .button'),composer:read('.nc-search-page .nc-search-composer')};
    });
    assert.equal(styles.card.border,styles.navigation.border,'Result cards and navigation share the theme stroke');
    assert.equal(styles.card.shadow,styles.navigation.shadow,'Result cards and navigation share the small hard shadow');
    assert.equal(styles.action.border,styles.navigation.border,'Search action must keep the shared button border');
    assert.equal(styles.composer.border,styles.navigation.border,'Search controls keep the shared panel border');
    assert.notEqual(styles.action.shadow,'none','Search action must not suppress the shared hard shadow');
    await reader.screenshot({path:path.join(out,appearance==='light'?'search-page-results.png':'search-page-dark.png')});
  }
  await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  check('Compact search controls, result cards and action buttons share navigation stroke and shadow tokens in light and dark themes');
  const beforePageReturn=requests.length;
  await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'漫画网站',exact:true}).click();await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'搜索漫画',exact:true}).click();assert.equal(await searchPage().locator('.nc-search-result').count(),6);assert.equal(requests.length,beforePageReturn);check('Navigation opens a full search page; direct Enter search skips translation; leaving and returning retains its independent results');
  await searchPage().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星光书店',exact:true})}).getByRole('button',{name:'继续阅读',exact:true}).click();await reader.locator('.nc-reader').waitFor();await reader.getByRole('button',{name:'返回搜索',exact:true}).click();await searchPage().waitFor();assert.equal(await searchPage().locator('.nc-search-result').count(),6);check('Full-page search opens the real reader and returns to its retained result grid');
  const group=key=>searchPage().locator('.nc-search-status-group.is-'+key);
  groupedResults=true;lagoonFail=true;slow=true;
  await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();
  assert.equal(await group('pending').locator('.nc-search-status').count(),5);assert.equal(await searchPage().locator('.nc-search-status-group').count(),1);
  await searchPage().getByRole('button',{name:'停止查找',exact:true}).click();
  assert.equal(await group('stopped').locator('.nc-search-status').count(),5);assert.equal(await group('empty').count(),0);assert.equal(await group('failed').count(),0);
  await pause(2_700);assert.equal(await searchPage().locator('.nc-search-result').count(),0);slow=false;
  await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();
  await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-error').length===2&&document.querySelectorAll('.nc-search-page .nc-search-status.is-empty').length===1);
  assert.deepEqual(await searchPage().locator('.nc-search-group-name').allTextContents(),['已找到','未找到','需登录或验证','搜索失败']);
  for(const [key,count] of [['found',2],['empty',1],['login',1],['failed',1]]){
    assert.equal(await group(key).locator('.nc-search-status').count(),count);assert.equal(await group(key).locator('.nc-search-group-count').innerText(),String(count));
    assert.equal(await group(key).locator('.nc-search-status-list').isVisible(),key==='found');assert.equal(await group(key).locator('.nc-search-group-toggle').getAttribute('aria-expanded'),String(key==='found'));
  }
  assert.equal(await searchPage().locator('.nc-search-status').count(),5);assert.match(await searchPage().locator('.nc-search-progress').innerText(),/5\/5 个网站已返回/);assert.equal(await searchPage().locator('.nc-search-failed-count').innerText(),'1 个网站失败');
  for(const appearance of ['light','dark']){
    await reader.evaluate(value=>{document.documentElement.dataset.appearance=value;},appearance);
    await searchPage().locator('.nc-search-results').screenshot({path:path.join(out,'search-groups-'+appearance+'.png')});
  }
  await reader.setViewportSize({width:390,height:844});assert(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await searchPage().locator('.nc-search-status-groups').scrollIntoViewIfNeeded();await reader.screenshot({path:path.join(out,'search-groups-mobile.png')});
  await reader.setViewportSize({width:1560,height:1120});await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  check('Result sites form four counted groups; only found sites expand by default, pending/stopped stay separate, login is not a failed/empty search, and desktop/mobile themes fit');
  const groupedDetails=searchPage().locator('.nc-search-status-detail'),loginSite=searchPage().locator('.nc-search-status').filter({hasText:'Aster Scans'}),beforeGroupFilter=requests.length;
  const loginToggle=group('login').locator('.nc-search-group-toggle');await loginToggle.press('Enter');assert.equal(await loginToggle.getAttribute('aria-expanded'),'true');
  await loginSite.click();assert.match(await groupedDetails.innerText(),/保持网页打开后重试/);assert.equal(await searchPage().locator('.nc-search-result').count(),0);assert.equal(await searchPage().locator('.nc-search-empty').count(),0);
  await loginToggle.press('Space');assert.equal(await group('login').locator('.nc-search-status-list').isVisible(),false);assert.equal(await groupedDetails.count(),0);assert.equal(await searchPage().locator('.nc-search-result').count(),2);assert.equal(requests.length,beforeGroupFilter);
  await expandGroup(searchPage(),'login');
  verificationStatus=401;await loginSite.click();await groupedDetails.getByRole('button',{name:'重试此网站',exact:true}).click();await group('login').locator('.nc-search-status').waitFor();assert.equal(await loginSite.getAttribute('aria-pressed'),'true');await loginSite.click();
  const recoverable=searchPage().locator('.nc-search-status').filter({hasText:'Lagoon Scans'});await expandGroup(searchPage(),'failed');await recoverable.click();lagoonFail=false;slow=true;
  await groupedDetails.getByRole('button',{name:'重试此网站',exact:true}).click();assert.equal(await group('pending').locator('.nc-search-status[aria-pressed=true]').count(),1);
  await group('found').locator('.nc-search-status[aria-pressed=true]').waitFor();slow=false;
  assert.equal(await group('failed').count(),0);assert.equal(await searchPage().locator('.nc-search-result').count(),1);await recoverable.click();
  const groupedDm5=searchPage().locator('.nc-search-status').filter({hasText:'动漫屋 DM5'});await groupedDm5.click();dm5PageFail=true;slow=true;
  await groupedDetails.getByRole('button',{name:'加载更多',exact:true}).click();assert.equal(await group('found').locator('.nc-search-status.is-running').count(),1);assert.equal(await searchPage().locator('.nc-search-result').count(),1);
  await group('found').locator('.nc-search-status.is-error').waitFor();assert.equal(await group('found').locator('.nc-search-status').count(),3);assert.equal(await searchPage().locator('.nc-search-result').count(),1);
  dm5PageFail=false;slow=false;await groupedDetails.getByRole('button',{name:'重试此网站',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-result').length===2);await groupedDm5.click();
  assert.equal(await searchPage().locator('.nc-search-result').count(),4);assert.equal(requests.filter(request=>request.kind==='title').length,pageTitleCalls);
  check('Group headers support Enter/Space; collapsing the filtered group restores candidates without requests; 401/403, retry migration and failed pagination retain their state and usable candidates');
  await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===3&&document.querySelectorAll('.nc-search-page .nc-search-status.is-error').length===1&&document.querySelectorAll('.nc-search-page .nc-search-status.is-empty').length===1);
  assert.equal(await group('login').locator('.nc-search-group-toggle').getAttribute('aria-expanded'),'false');assert.equal(await group('found').locator('.nc-search-status-list').isVisible(),true);check('A fresh search resets previously expanded groups to found-only while retry preserves the current choices');
  groupedResults=false;await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===5);
  slow=true;await searchPage().getByRole('button',{name:'重新搜索',exact:true}).click();await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'漫画网站',exact:true}).click();await pause(2_700);await reader.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'搜索漫画',exact:true}).click();assert.equal(await searchPage().locator('.nc-search-result').count(),0);assert.match(await searchPage().locator('.nc-search-progress').innerText(),/已停止/);slow=false;
  titleMode='english';await searchPage().getByRole('button',{name:'翻译名称搜索',exact:true}).click();assert.equal(await searchPage().getByPlaceholder('请输入漫画作品名称').inputValue(),'星光书店');await searchPage().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-status.is-ready').length===5);assert.equal(requests.filter(request=>request.kind==='title').length,pageTitleCalls+1);check('Page navigation cancels late search results; switching to translation mode carries the name and searches the translated title');
  const deepLink=await context.newPage();await deepLink.goto(home+'#search');await deepLink.locator('.nc-search-page').waitFor();assert.equal(new URL(deepLink.url()).hash,'#search');assert.equal(await deepLink.locator('dialog[open]').count(),0);
  await expandScope(deepLink);const freshDm5=deepLink.locator('.nc-search-site-option').filter({hasText:'动漫屋 DM5'}).locator('input');await freshDm5.uncheck();await deepLink.reload();await deepLink.locator('.nc-search-page').waitFor();await expandScope(deepLink);assert(!await freshDm5.isChecked());assert.equal(await deepLink.locator('.nc-search-result').count(),0);
  await expandScope(deepLink);for(const input of await deepLink.locator('.nc-search-site-option input').all())if(await input.isChecked())await input.uncheck();await deepLink.reload();await deepLink.locator('.nc-search-page').waitFor();assert.equal(await deepLink.locator('.nc-search-site-option input:checked').count(),0);
  await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-page .nc-search-site-option input:checked').length===0);assert.equal(await searchPage().locator('.nc-search-result').count(),6);assert.equal(await searchPage().locator('.nc-search-status').count(),5);
  await deepLink.locator('.nc-search-scope').getByRole('button',{name:'全选',exact:true}).click();await deepLink.close();check('Fresh tabs and reloads restore saved and entirely deselected scopes; cross-tab preference updates leave existing results intact');
  assert.deepEqual(permissionRequests,[]);assert.equal(await worker.evaluate(()=>globalThis.__fixturePermissionRequests),0);check('The unchanged built manifest grants HTTP/HTTPS access; normal searches, website entry and imports never request extra permissions');
  assert.deepEqual(errors,[]);
  const result={evidence:'Production MV3/App with isolated HTTP fixtures; no live model/source traffic; unmodified required HTTP/HTTPS manifest and zero runtime permission requests',out,checks,errors,permissionRequests,requests:requests.map(request=>request.kind==='title'?{kind:request.kind,targetLanguage:request.body.target_language}:{kind:request.kind,site:request.site,...(request.parameters?{parameters:request.parameters}:{})})};
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(reader){await reader.getByRole('button',{name:'打开漫画 星あかりの本屋',exact:true}).click({button:'right',timeout:1_000}).then(()=>reader.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click({timeout:1_000})).catch(()=>{});await writeFile(path.join(out,'failure-state.json'),JSON.stringify({errors,requests,text:await reader.locator('body').innerText()},null,2)).catch(()=>{});}await reader?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('Artifacts: '+out);throw error;}
finally{releaseImport?.();await context.close();}
