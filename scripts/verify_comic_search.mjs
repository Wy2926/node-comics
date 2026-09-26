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
export {importCatalog} from '${source}/comics/application/import-service.ts';
export {catalogHtml as guaziCatalogHtml,readerHtml as guaziReaderHtml} from '${source}/sources/sites/guazimanhua/tests/fixtures.ts';`);
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry:probe,formats:['es'],fileName:()=> 'verify-search.js'}}});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const context=await chromium.launchPersistentContext(path.join(out,'profile'),{headless:true,executablePath:process.env.TEST_CHROMIUM||process.env.CHROMIUM_PATH,viewport:{width:1560,height:1120},reducedMotion:'reduce',args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(20_000);
const permissionRequests=[];
await context.exposeBinding('__fixturePermissionRequest',(_,request)=>{permissionRequests.push(request);});
await context.addInitScript(()=>{if(location.protocol==='chrome-extension:'){chrome.permissions.request=request=>{void window.__fixturePermissionRequest(request);throw Error('Unexpected permission request with required host access');};if(!localStorage.getItem('nc-settings'))localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single',fit:'window',appearance:'light',language:'en'}));if(!localStorage.getItem('nc-search-language'))localStorage.setItem('nc-search-language','zh');}});
const errors=[],checks=[],requests=[];let titleMode='english',copyFail=true,slow=false,slowImport=false,emptyReader=false,guaziCatalog='',guaziReader='';
const check=message=>{checks.push(message);console.log(message);};
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
function mangaDexSearch(url){
  const rows=url.searchParams.get('title')==='nothing'?[]:[{id:'42f40118-dff5-4f23-acbf-e54e89f026bd',type:'manga',attributes:{title:{ja:'星あかりの本屋'},originalLanguage:'ja',availableTranslatedLanguages:['en','zh-hk']},relationships:[]}];
  return {result:'ok',response:'collection',data:rows,total:rows.length,limit:12,offset:0};
}
function guaziSearch(url){
  const query=url.searchParams.get('keyword'),rows=query==='nothing'?[]:[{id:'123',title:'星光书店'},{id:'456',title:'星光书店 新来源'}];
  return `<script type="application/ld+json">${JSON.stringify({'@type':'CollectionPage',name:'搜索：'+query+'漫画',mainEntity:{'@type':'ItemList',numberOfItems:rows.length,itemListElement:rows.map((row,index)=>({'@type':'ListItem',position:index+1,name:row.title,url:'https://www.guazimanhua.com/comic.php?id='+row.id}))}})}</script>${rows.length?rows.map(row=>`<article class="card"><img class="cover" src="https://img.guazicdn.com/th/comics/cover/${row.id}.png"><h3><a href="/comic.php?id=${row.id}">${row.title}</a></h3><div class="meta">星野葵 · 连载中</div></article>`).join(''):'<div class="empty"></div>'}<nav class="pager"><a class="on" href="/category.php?keyword=${encodeURIComponent(query)}">1</a></nav>`;
}
await context.route(/https?:\/\//,async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/v1/comic-titles/translate'){
    requests.push({kind:'title',body:route.request().postDataJSON()});
    return titleMode==='login'?route.fulfill({status:401,json:{error:{code:'AUTH_REQUIRED',message:'Fixture login required'}}}):route.fulfill({json:titleMode==='null'?{name:null,target_language:null}:{name:'The Starlight Bookshop',target_language:'en'}});
  }
  if(url.hostname==='www.dm5.com'&&url.pathname==='/search'){requests.push({kind:'search',site:'dm5',query:url.searchParams.get('title'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:100);return route.fulfill({contentType:'text/html; charset=utf-8',body:dm5Search(url)}).catch(()=>{});}
  if(url.hostname==='www.guazimanhua.com'&&url.pathname==='/category.php'){requests.push({kind:'search',site:'guazi',query:url.searchParams.get('keyword'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:900);return route.fulfill({contentType:'text/html; charset=utf-8',body:guaziSearch(url)}).catch(()=>{});}
  if(['www.copy4000.com','www.mangacopy.com'].includes(url.hostname)&&url.pathname.startsWith('/api/')){
    requests.push({kind:'search',site:url.hostname,query:url.searchParams.get('q'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:250);
    return copyFail?route.fulfill({status:503,body:'Fixture unavailable'}).catch(()=>{}):route.fulfill({json:{code:200,results:{offset:0,limit:12,total:1,list:[{path_word:'searchfixture',name:'星光書店',author:[{name:'星野葵'}],cover:'https://sg.mangafunb.fun/cover.png'}]}}}).catch(()=>{});
  }
  if(url.hostname==='api.mangadex.org'&&url.pathname==='/manga'){
    requests.push({kind:'search',site:'mangadex',query:url.searchParams.get('title'),parameters:[...url.searchParams.keys()]});await pause(slow?2_500:400);
    return route.fulfill({json:mangaDexSearch(url)}).catch(()=>{});
  }
  if(url.hostname==='comic.naver.com'){
    if(url.pathname.endsWith('/info'))return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',titleName:'星あかりの本屋',posterThumbnailUrl:'https://image-comic.pstatic.net/cover.png'}});
    if(url.pathname==='/api/article/list')return route.fulfill({json:{titleId:123,webtoonLevelCode:'WEBTOON',sort:'ASC',totalCount:1,pageInfo:{page:1,totalPages:1,totalRows:1,pageSize:20},articleList:[{no:1,subtitle:'原作 第 1 话'}]}});
    if(url.pathname==='/webtoon/detail'&&emptyReader)return route.fulfill({status:503,body:'Fixture unavailable chapter'});
    if(url.pathname==='/webtoon/detail')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<a aria-current="true" href="/webtoon/detail?titleId=123&amp;no=1">Current</a><div class="wt_viewer">${[0,1,2].map(n=>`<img id="content_image_${n}" src="https://image-comic.pstatic.net/webtoon/123/1/${n}.png">`).join('')}</div>`});
  }
  if(url.hostname==='www.guazimanhua.com'){
    const fresh=url.searchParams.get('id')==='456'||url.searchParams.get('id')==='21';
    if(fresh&&slowImport&&url.pathname==='/comic.php'){console.log('Fixture slow import requested: '+url.href);await pause(1_500);}
    let body=url.pathname==='/chapter.php'?guaziReader:guaziCatalog;
    if(fresh)body=body.replaceAll('id=123','id=456').replaceAll('id=11','id=21').replaceAll('星光书店','星光书店 新来源');
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  }
  if(['image-comic.pstatic.net','img.guazicdn.com','images.cdndm5.com','sg.mangafunb.fun'].includes(url.hostname))return route.fulfill({contentType:'image/png',body:image});
  if(url.pathname.startsWith('/v1/'))return route.fulfill({status:503,json:{error:{code:'FIXTURE_OFFLINE',message:'Isolated fixture'}}});
  return route.abort();
});

let reader;
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),home=new URL('reader.html',worker.url()).href;
  await worker.evaluate(()=>{globalThis.__fixturePermissionRequests=0;chrome.permissions.request=()=>{globalThis.__fixturePermissionRequests++;throw Error('Unexpected background permission request with required host access');};});
  reader=await context.newPage();await reader.goto(home);await reader.locator('.nc-library').waitFor();
  const fixtures=await reader.evaluate(async()=>{const probe=await import(chrome.runtime.getURL('verify-search.js'));return {catalog:probe.guaziCatalogHtml(['11']).replaceAll('Fixture comic','星光书店').replace('<script>throw Error(\'never execute\')</script>',''),reader:probe.guaziReaderHtml()};});
  guaziCatalog=fixtures.catalog;guaziReader=fixtures.reader;
  const imported=await reader.evaluate(async()=>{const probe=await import(chrome.runtime.getURL('verify-search.js'));const rows=[];for(const url of ['https://comic.naver.com/webtoon/list?titleId=123','https://www.guazimanhua.com/comic.php?id=123']){const comic=await probe.importCatalog(await probe.readSourceCatalog(url));rows.push({id:comic.id,title:comic.title});}return rows;});
  const card=id=>reader.locator(`[data-comic-id="${id}"]`),panel=()=>reader.locator('dialog.nc-comic-search[open]');
  const seed=imported.find(row=>row.title==='星あかりの本屋');assert(seed);
  const openShelf=async()=>{await card(seed.id).getByRole('button',{name:'更多操作 · '+seed.title,exact:true}).click();await reader.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();};
  await card(seed.id).locator('.nc-thumbnail img').waitFor();await openShelf();
  assert.equal(requests.length,0,'Opening must not query sites or the title service');
  await panel().locator('.nc-search-origin-cover img').waitFor();check('Production shelf entry opens with existing cover and performs no title/site search');
  const language=panel().getByRole('combobox',{name:'名称目标语言',exact:true});
  await language.click();assert.equal(await language.getAttribute('aria-expanded'),'true');await language.press('Escape');assert.equal(await language.getAttribute('aria-expanded'),'false');assert.equal(await panel().count(),1);
  await panel().getByRole('button',{name:'关闭查找面板',exact:true}).focus();await reader.keyboard.press('Shift+Tab');assert(await panel().evaluate(element=>element.contains(document.activeElement)));check('Shared Select popover and Escape work inside native dialog; focus remains trapped');
  await panel().locator('.nc-search-sites>summary').click();
  const siteInputs=panel().locator('.nc-search-site-option input');assert((await siteInputs.count())>=5);for(const input of await siteInputs.all()){assert(await input.isChecked());assert(!await input.isDisabled());}assert.equal(await panel().getByText(/已排除|语言待确认|按资源语言筛选/).count(),0);
  const mirrorOption=panel().locator('.nc-search-site-option').filter({hasText:'MangaCopy'});await mirrorOption.locator('input').uncheck();
  await panel().locator('.nc-search-sites>summary').click();
  await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();
  await panel().locator('.nc-search-result').first().waitFor();assert.equal(await panel().locator('.nc-search-result').count(),1);assert.match(await panel().locator('.nc-search-query').innerText(),/名称语言为English/);assert.equal(await language.getAttribute('data-value'),'zh');
  await panel().locator('.nc-search-status.is-error').waitFor();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===4);
  await panel().locator('.nc-search-result-cover img').first().waitFor();check('English title fallback only changes the search name; first site is visible before slower sites and covers load independently');
  const mangaDexResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星あかりの本屋',exact:true})});assert.match(await mangaDexResult.locator('.nc-search-result-languages').innerText(),/English/);assert.match(await mangaDexResult.locator('.nc-search-result-languages').innerText(),/zh-HK|中文/);const noLanguageResults=panel().locator('.nc-search-result').filter({hasNot:reader.getByRole('heading',{name:'星あかりの本屋',exact:true})});assert.equal(await noLanguageResults.locator('.nc-search-result-languages').count(),0);assert.equal(await panel().getByRole('checkbox',{name:'只看语言已确认',exact:true}).count(),0);assert.equal(await panel().getByText('语言待确认',{exact:true}).count(),0);check('Site-supplied MangaDex languages appear; unknown languages have no placeholder or confirmed-language filter');
  await reader.screenshot({path:path.join(out,'search-light.png')});
  const failed=panel().locator('.nc-search-status.is-error').filter({hasText:'拷贝漫画'});await failed.locator('summary').click();copyFail=false;const titleCalls=requests.filter(request=>request.kind==='title').length;await failed.getByRole('button',{name:'重试此网站',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===5);assert.equal(requests.filter(request=>request.kind==='title').length,titleCalls);
  const dm5=panel().locator('.nc-search-status').filter({hasText:'动漫屋 DM5'});await dm5.locator('summary').click();await dm5.getByRole('button',{name:'加载更多',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===6);assert.equal(requests.filter(request=>request.kind==='title').length,titleCalls);check('Single-site retry and cursor pagination append without another name lookup');
  await reader.evaluate(()=>{document.documentElement.dataset.appearance='dark';});await reader.screenshot({path:path.join(out,'search-dark.png')});await reader.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  const beforeClose=requests.length;await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();await openShelf();assert.equal(await panel().locator('.nc-search-result').count(),6);assert.equal(requests.length,beforeClose);assert.match(await panel().locator('.nc-search-progress').innerText(),/上次查找/);check('Closing/reopening retains results and last-search time without new search traffic');
  await language.click();await panel().locator('[role=option][data-value=ja]').click();await panel().locator('.nc-search-sites>summary').click();for(const option of await panel().locator('.nc-search-site-option').all())assert(!await option.locator('input').isDisabled());assert(await panel().locator('.nc-search-site-option').filter({hasText:'MangaDex'}).locator('input').isChecked());await panel().locator('.nc-search-sites>summary').click();const originalNameCalls=requests.filter(request=>request.kind==='title').length;if(await panel().getByRole('button',{name:'已有名称，直接输入搜索',exact:true}).count())await panel().getByRole('button',{name:'已有名称，直接输入搜索',exact:true}).click();await panel().getByRole('button',{name:'使用原名搜索',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length===5);assert.equal(requests.filter(request=>request.kind==='title').length,originalNameCalls);assert(await mangaDexResult.isVisible());assert(requests.some(request=>request.site==='mangadex'&&request.query==='星あかりの本屋'));assert.equal(await noLanguageResults.locator('.nc-search-result-languages').count(),0);for(const request of requests.filter(request=>request.kind==='search'))assert(!(request.parameters??[]).some(key=>/language/i.test(key)),request.site+' must search by name without a language parameter');check('Japanese-name search includes MangaDex English/Traditional-Chinese releases and every selected site without request language filters');await mangaDexResult.scrollIntoViewIfNeeded();await reader.screenshot({path:path.join(out,'name-only-search.png')});
  slow=true;await panel().getByRole('button',{name:'重新搜索',exact:true}).click();await panel().getByRole('button',{name:'停止查找',exact:true}).click();await pause(2_700);assert.equal(await panel().locator('.nc-search-result').count(),0);assert.match(await panel().locator('.nc-search-progress').innerText(),/已停止/);
  await panel().getByRole('button',{name:'重新搜索',exact:true}).click();await language.click();await panel().locator('[role=option][data-value=en]').click();await pause(2_700);assert.equal(await panel().locator('.nc-search-result').count(),0);assert.equal(await panel().locator('.nc-search-progress').count(),0);check('Stopped and language-replaced requests never publish delayed fixture results');slow=false;
  await language.click();await panel().locator('[role=option][data-value=zh]').click();titleMode='null';await panel().getByPlaceholder('请输入漫画作品名称').fill('星あかりの本屋 別題');await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();await panel().getByText('未找到常用中文名称，请手动输入或明确使用原名搜索。',{exact:true}).waitFor();assert.equal(await panel().locator('.nc-search-result').count(),0);
  // Changing the source name bypasses the per-name result cache, as a user correction would.
  await panel().getByPlaceholder('请输入漫画作品名称').fill('星あかりの本屋 修正');titleMode='login';await panel().getByRole('button',{name:'翻译名称并搜索',exact:true}).click();await panel().getByText('登录后可自动查找名称，也可以手动输入。',{exact:true}).waitFor();
  await panel().getByPlaceholder('输入漫画名称或别名').fill('星光书店');await panel().getByRole('button',{name:'搜索网站',exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length>=5);check('Null title requires explicit input; 401 leaves manual site searching fully usable');
  const existingResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星光书店',exact:true})});assert.match(await existingResult.innerText(),/已在书架/);await existingResult.getByRole('button',{name:'继续阅读',exact:true}).click();await reader.locator('.nc-reader').waitFor();await reader.waitForFunction(()=>document.querySelector('img.nc-page-image')?.naturalWidth>0);check('Existing source identity shows the bookshelf badge and continues through the real reader');
  await reader.getByLabel('跳转页码',{exact:true}).fill('2');await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
  await reader.getByRole('button',{name:'打开目录',exact:true}).click();assert.equal(await reader.locator('.nc-reader-drawer').getByRole('button',{name:'寻找其他语言',exact:true}).count(),0);await reader.getByRole('button',{name:'关闭面板',exact:true}).click();await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.screenshot({path:path.join(out,'reader-settings.png')});await reader.locator('.nc-reader-drawer[aria-label="阅读设置"]').getByRole('button',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();assert.equal(await panel().getByPlaceholder('请输入漫画作品名称').inputValue(),'星光书店');await reader.keyboard.press('ArrowRight');await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();assert.equal(await reader.getByLabel('跳转页码',{exact:true}).inputValue(),'2');assert(await reader.getByRole('button',{name:'阅读设置',exact:true}).evaluate(element=>element===document.activeElement));check('Reader settings owns the search entry; directory has none; search preserves work title/page 2 and returns focus to the settings trigger');
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();await openShelf();if(await panel().getByRole('button',{name:'已有名称，直接输入搜索',exact:true}).count())await panel().getByRole('button',{name:'已有名称，直接输入搜索',exact:true}).click();await panel().getByPlaceholder('输入漫画名称或别名').fill('星光书店');await panel().getByRole('button',{name:/^(?:重新搜索|搜索网站)$/,exact:true}).click();await reader.waitForFunction(()=>document.querySelectorAll('.nc-search-result').length>=5);
  const freshResult=panel().locator('.nc-search-result').filter({has:reader.getByRole('heading',{name:'星光书店 新来源',exact:true})});slowImport=true;await freshResult.getByRole('button',{name:'导入并阅读',exact:true}).click();assert(await panel().getByRole('combobox',{name:'名称目标语言',exact:true}).isDisabled());await panel().getByRole('button',{name:'关闭查找面板',exact:true}).click();
  await waitUntil(()=>reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-search.js'));return (await catalog.list('comics')).some(comic=>comic.title==='星光书店 新来源');}));
  const saved=await reader.evaluate(async()=>{const {catalog}=await import(chrome.runtime.getURL('verify-search.js'));const comics=await catalog.list('comics');return {count:comics.length,original:comics.find(comic=>comic.title==='星あかりの本屋')?.id};});assert.equal(saved.count,3);assert.equal(saved.original,seed.id);assert.equal(await reader.locator('.nc-reader').count(),0);assert.equal(await reader.locator('.nc-library').count(),1);check('New-source import preserves the original record; closing during slow import prevents late navigation');
  emptyReader=true;await card(seed.id).getByRole('button',{name:'打开漫画 '+seed.title,exact:true}).click();await reader.locator('.nc-reader .nc-empty').waitFor();assert.equal(await reader.locator('.nc-page-image').count(),0);
  await reader.getByRole('button',{name:'阅读设置',exact:true}).click();await reader.screenshot({path:path.join(out,'reader-empty-settings.png')});await reader.locator('.nc-reader-drawer[aria-label="阅读设置"]').getByRole('button',{name:'寻找其他语言',exact:true}).click();await panel().waitFor();assert.equal(await panel().getByPlaceholder('请输入漫画作品名称').inputValue(),seed.title);await reader.keyboard.press('Escape');await reader.locator('.nc-reader .nc-empty').waitFor();assert(await reader.getByRole('button',{name:'阅读设置',exact:true}).evaluate(element=>element===document.activeElement));check('Unavailable chapter still exposes reading settings and work-title search; Escape returns to the empty reader settings trigger');await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
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
  await replacement.page.locator(`[data-comic-id="${seed.id}"]`).getByRole('button',{name:'更多操作 · '+seed.title,exact:true}).click();await replacement.page.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click();await replacement.page.locator('dialog.nc-comic-search[open]').waitFor();
  await replacement.page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('kept','newer-query');history.replaceState(null,'',url);});
  await reader.evaluate(()=>window.__releaseSearchSeed());await waitUntil(async()=>!new URL(replacement.page.url()).searchParams.has('search'));
  assert.equal(await replacement.page.getByPlaceholder('请输入漫画作品名称').inputValue(),seed.title);assert.equal(new URL(replacement.page.url()).searchParams.get('kept'),'newer-query');await replacement.page.close();check('A delayed website seed cannot replace a newer bookshelf search; consumed-handle cleanup preserves newer query parameters');
  const navigation=await delayedSeedPage(),newHandle='12345678-1234-1234-1234-123456789abc';
  await navigation.page.getByRole('button',{name:'漫画网站',exact:true}).click();await navigation.page.evaluate(id=>{const url=new URL(location.href);url.searchParams.set('search',id);history.replaceState(null,'',url);},newHandle);
  await reader.evaluate(()=>window.__releaseSearchSeed());await navigation.page.evaluate(async id=>{await navigator.locks.request('nc-search-seed:'+id,()=>{});await new Promise(resolve=>setTimeout(resolve,50));},navigation.id);
  assert.equal(await navigation.page.locator('dialog.nc-comic-search[open]').count(),0);assert.equal(new URL(navigation.page.url()).hash,'#sites');assert.equal(new URL(navigation.page.url()).searchParams.get('search'),newHandle);await navigation.page.close();check('Navigation supersedes a delayed seed and its finalizer does not delete a different, newer handle');
  assert.deepEqual(permissionRequests,[]);assert.equal(await worker.evaluate(()=>globalThis.__fixturePermissionRequests),0);check('The unchanged built manifest grants HTTP/HTTPS access; normal searches, website entry and imports never request extra permissions');
  assert.deepEqual(errors,[]);
  const result={evidence:'Production MV3/App with isolated HTTP fixtures; no live model/source traffic; unmodified required HTTP/HTTPS manifest and zero runtime permission requests',out,checks,errors,permissionRequests,requests:requests.map(request=>request.kind==='title'?{kind:request.kind,targetLanguage:request.body.target_language}:{kind:request.kind,site:request.site,...(request.parameters?{parameters:request.parameters}:{})})};
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(reader){await reader.getByRole('button',{name:'更多操作 · 星あかりの本屋',exact:true}).click({timeout:1_000}).then(()=>reader.getByRole('menuitem',{name:'寻找其他语言',exact:true}).click({timeout:1_000})).catch(()=>{});await writeFile(path.join(out,'failure-state.json'),JSON.stringify({errors,requests,text:await reader.locator('body').innerText()},null,2)).catch(()=>{});}await reader?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('Artifacts: '+out);throw error;}
finally{await context.close();}
