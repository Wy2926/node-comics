/** Isolated MV3 card presentation; synthetic metadata, no real account or network. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),output=path.join(root,'artifacts/shelf-cards');await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'profile-'));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=process.env.TEST_EXTENSION_DIR||path.join(root,'apps/extension/.output/chrome-mv3');
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,
 viewport:{width:1440,height:1100},locale:'zh-CN',reducedMotion:'reduce',
 args:['--disable-extensions-except='+extension,'--load-extension='+extension,...(process.env.SHELF_CARD_CDP_PORT?['--remote-debugging-port='+process.env.SHELF_CARD_CDP_PORT]:[])]});
await context.route(/^https?:\/\//,route=>route.abort());
const errors=[],checks=[];let page;
try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install();
 await page.goto(new URL('reader.html',worker.url()).href);await page.locator('.nc-library').waitFor();
 await page.evaluate(async()=>{
  localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'light',layout:'single'}));
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-reading-v2-catalog');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const now=Date.now(),day=86400000,ages=[10000,5*60000,3*3600000,2*day,2*7*day,2*30*day,2*365*day,null,day,day,day];
  await new Promise((resolve,reject)=>{
   const tx=db.transaction(['comics','entries'],'readwrite');
   for(const [i,age]of ages.entries()){
    const title=i===0?'长标题漫画：穿过星海之后继续向着遥远世界旅行的我们与未完成的故事':i===8?'EPUB 阅读进度':i===9?'未知总页数':i===10?'目录已失效':'漫画 '+i;
    tx.objectStore('comics').put({id:'card-'+i,sourceKey:'card-'+i,title,sourceName:'本地文件',
     source:{connectionId:'local',providerItemId:'card-'+i,locator:{},generation:1,status:'active'},
     createdAt:now-i,updatedAt:now-i,...(age===null?{}:{lastReadAt:now-age,lastEntryId:'entry-'+i,lastPage:i===8?.42:12,lastPageCount:i===8?1:i===9?undefined:40})});
    if(i!==10)tx.objectStore('entries').put({id:'entry-'+i,comicId:'card-'+i,title:i===0?'第十二话：当星光越过漫长的旅途与不可思议的远方，冒险终于再次开始':title,
     order:0,format:i===8?'epub':'cbz',contentId:'content-'+i,generation:1,indexState:'ready',createdAt:now,updatedAt:now});
   }
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
 });
 await page.reload();await page.locator('.nc-card-position').filter({hasText:'第十二话'}).waitFor();
 await page.getByRole('button',{name:'不发送',exact:true}).click();
 const search=page.getByRole('searchbox',{name:'搜索漫画'}),card=id=>page.locator(`[data-comic-id="card-${id}"]`);
 const expected=['刚刚','5分钟前','3小时前','2天前','2周前','2个月前','2年前','还没阅读'];
 for(let i=0;i<expected.length;i++){
  await card(i).scrollIntoViewIfNeeded();assert.equal(await card(i).locator('.nc-card-reading-time').innerText(),expected[i]);
 }
 assert.equal(await page.locator('.nc-card-reading-time svg').count(),0);
 checks.push('分钟、小时、天、周、月、年和未读时间，无时钟图标');
 await search.fill('EPUB');await page.waitForFunction(()=>document.querySelector('.nc-card-position')?.textContent==='阅读进度 42%');
 await search.fill('未知总页数');assert.equal(await card(9).locator('.nc-card-position').innerText(),'第 12 页');
 await search.fill('目录已失效');assert.equal(await card(10).locator('.nc-card-position').innerText(),'第 12 页，共 40 页');
 checks.push('EPUB 显示百分比；未知总页数和失效目录仍显示可用的页码');
 await search.fill('长标题');await page.locator('.nc-card-position').filter({hasText:'第十二话'}).waitFor();
 const inspect=()=>card(0).evaluate(node=>{
  const body=node.querySelector('.nc-library-card-body'),title=node.querySelector('.nc-card-title button'),position=node.querySelector('.nc-card-position');
  const bodyStyle=getComputedStyle(body),titleStyle=getComputedStyle(title),positionStyle=getComputedStyle(position);
  return {padding:parseFloat(bodyStyle.paddingTop),gap:parseFloat(bodyStyle.rowGap),height:body.clientHeight,
   titleEllipsis:titleStyle.textOverflow,positionEllipsis:positionStyle.textOverflow,
   titleClipped:title.scrollWidth>title.clientWidth,positionClipped:position.scrollWidth>position.clientWidth,
   titleTooltip:title.title===title.textContent,positionTooltip:position.title===position.textContent,
   overflow:document.documentElement.scrollWidth>innerWidth+1};
 });
 const desktop=await inspect();assert(desktop.padding<=12&&desktop.gap<=4&&desktop.height<80);assert(desktop.titleClipped&&desktop.positionClipped);
 assert.equal(desktop.titleEllipsis,'ellipsis');assert.equal(desktop.positionEllipsis,'ellipsis');assert(desktop.titleTooltip&&desktop.positionTooltip&&!desktop.overflow);
 await search.fill('');await page.screenshot({path:path.join(output,'desktop-light.png')});
 await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',appearance:'dark',layout:'single'})));await page.reload();
 await page.locator('.nc-card-position').filter({hasText:'第十二话'}).waitFor();await page.screenshot({path:path.join(output,'desktop-dark.png')});
 await page.setViewportSize({width:390,height:844});await search.fill('长标题');
 const narrow=await inspect();assert(narrow.titleClipped&&narrow.positionClipped&&!narrow.overflow);
 await card(0).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'narrow-dark.png')});
 checks.push('桌面与390px窄屏标题/阅读位置单行省略，悬停保留全文；浅色/深色截图');
 await page.setViewportSize({width:1440,height:1100});await search.fill('漫画 1');
 // A single shelf clock updates relative labels without another chapter query.
 await page.clock.fastForward(60000);
 await page.waitForFunction(()=>document.querySelector('[data-comic-id="card-1"] .nc-card-reading-time')?.textContent==='6分钟前');
 checks.push('停留书架一分钟自动刷新相对时间');
 await page.clock.resume();
 await page.locator('input[type=file]').setInputFiles(path.join(root,'artifacts/import-validation/pages.cbz'));
 const jump=page.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('3');await jump.press('Enter');
 await page.waitForFunction(()=>{const image=document.querySelector('[data-page-index="2"] img.nc-page-image');return image?.complete&&image.naturalWidth>0;});
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await search.fill('pages');
 await page.waitForFunction(()=>document.querySelector('.nc-card-position')?.textContent==='第 3 页，共 3 页');
 const title=await page.locator('.nc-card-title button').innerText();await page.reload();
 await search.fill(title);await page.getByRole('button',{name:'打开漫画 '+title,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('input[aria-label="跳转页码"]')?.value==='3');
 await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();await search.fill('');
 checks.push('真实 CBZ 导入后读到第3页，卡片同步位置，刷新后继续阅读恢复第3页');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'results.json'),JSON.stringify({checks,desktop,narrow,errors},null,2));
 console.log(JSON.stringify({url:page.url(),output,checks,errors}));
 if(process.env.SHELF_CARD_INSPECT){await page.clock.resume();await search.fill('');console.log('Ready for isolated browser inspection; press Enter to close.');await new Promise(resolve=>process.stdin.once('data',resolve));process.stdin.pause();}
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await context.close();}
