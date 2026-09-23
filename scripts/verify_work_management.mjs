/**
 * Work-management acceptance against the compiled Chrome extension.
 * Run after `npm --prefix apps/extension run build`.
 * PLAYWRIGHT_MODULE may name an installed Playwright module; TEST_CHROMIUM may point
 * to Chrome for Testing. Every run creates a fresh profile under ignored artifacts.
 * Only generated CBZ files are imported. No user's Chrome profile or private files are used.
 */
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {selectOption} from './select_helpers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=createRequire(path.join(root,'apps/extension/package.json'))('@zip.js/zip.js');
const extension=path.resolve(root,'apps/extension/.output/chrome-mv3');
const manifest=await readFile(path.join(extension,'manifest.json'));
const outputRoot=path.join(root,'artifacts/work-management');
await mkdir(outputRoot,{recursive:true});
const output=await mkdtemp(path.join(outputRoot,'run-'));
const profile=await mkdtemp(path.join(output,'profile-'));
const context=await chromium.launchPersistentContext(profile,{
  headless:true,locale:'zh-CN',viewport:{width:1440,height:1000},
  executablePath:process.env.TEST_CHROMIUM,
  args:['--disable-extensions-except='+extension,'--load-extension='+extension],
});
const errors=[],consoleErrors=[],checks=[],metrics={};
let page,stage='boot',failure;
const startedAt=new Date().toISOString();
context.on('page',value=>{
  value.on('pageerror',error=>errors.push({stage,message:error.message}));
  value.on('console',message=>{if(message.type()==='error')consoleErrors.push({stage,message:message.text()});});
});
await context.route(/^https?:\/\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));

async function snapshot(){
  return page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-sources-v1-catalog');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{
      const tables=['works','units','documents','positions','revisions'];
      const transaction=db.transaction(tables,'readonly');
      return Object.fromEntries(await Promise.all(tables.map(table=>new Promise((resolve,reject)=>{const request=transaction.objectStore(table).getAll();request.onsuccess=()=>resolve([table,request.result]);request.onerror=()=>reject(request.error);})))) ;
    }finally{db.close();}
  });
}
async function until(test,label,timeout=15000){
  const end=Date.now()+timeout;
  let last;
  while(Date.now()<end){last=await test();if(last)return last;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Timed out: '+label);
}
async function recordsUntil(test,label){return until(async()=>{const value=await snapshot();return test(value)&&value;},label);}
async function count(locator,expected){await until(async()=>await locator.count()===expected,`expected ${expected} matching elements`);}
async function screenshot(name){
  const toast=page.locator('.toast button');if(!await page.locator('dialog[open]').count()&&!await page.getByRole('menu').count()&&await toast.count())await toast.click();
  const menuVisible=await page.getByRole('menu').count()>0;
  await page.screenshot({path:path.join(output,name+'.png'),fullPage:!menuVisible&&!await page.locator('.nc-shelf-window').count()&&!name.startsWith('import-')&&!name.includes('editor')});
  if(menuVisible)assert(await page.getByRole('menu').isVisible(),'screenshot preserves the open context menu');
}
function dialog(name){return page.getByRole('dialog',{name,exact:true});}
function unitCard(id){return page.locator(`[data-unit-id="${id}"]`);}
function versionRow(id){return page.locator(`[data-document-id="${id}"]`);}
async function clickAction(scope,name){
  if(await scope.evaluate(element=>element.matches('.nc-content-card,.nc-book'))){await scope.click({button:'right'});await page.getByRole('menuitem',{name,exact:true}).click();return;}
  // Some secondary controls have a decorative ::after arrow in their accessible
  // name. Match their actual text while retaining the owning card/row scope.
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const button=scope.locator('button').filter({hasText:new RegExp('^'+escaped+'$')});
  if(!await button.isVisible())await scope.locator('details > summary').click();
  await button.click();
}
async function choose(scope,label,value,optionLabel){
  const control=scope.getByRole('combobox',{name:label,exact:true});
  if(await control.evaluate(element=>element.tagName==='SELECT'))await control.selectOption(value);
  else{await control.click();await scope.getByRole('option',{name:optionLabel,exact:true}).click();}
}
async function sourceFiles(files){
  const picker=dialog('导入漫画');await picker.waitFor();
  assert.equal(await picker.getByRole('button',{name:'网站来源',exact:true}).count(),0);
  const chooserPromise=page.waitForEvent('filechooser');
  await picker.getByRole('button',{name:'本地文件',exact:true}).click();
  await (await chooserPromise).setFiles(files);
  const panel=dialog('导入本地漫画');await panel.waitFor();
  await until(async()=>!(await panel.getByRole('button',{name:/^开始导入/}).isDisabled()),'import review ready');
  return panel;
}
async function finishImport(panel,expected){
  await panel.getByRole('button',{name:/^开始导入/}).click();
  await until(async()=>await panel.locator('.nc-import-item.created').count()===expected,'all generated archives imported',120000);
  assert.equal(await panel.locator('.nc-import-item.failed,.nc-import-item.duplicate').count(),0);
  await panel.getByRole('button',{name:'完成',exact:true}).click();
  await panel.waitFor({state:'hidden'});
}
async function openWork(title){
  if(await page.locator('.nc-work-detail').count())return;
  await page.getByRole('button',{name:'打开作品 '+title,exact:true}).click();
  await page.getByRole('heading',{name:title,exact:true,level:1}).waitFor();
}
async function openVersions(unitId){await clickAction(unitCard(unitId),'版本与来源');await dialog('版本与来源').waitFor();}
async function backFromReader(){
  await page.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await page.locator('.nc-reader').waitFor({state:'hidden'});
  await page.locator('.nc-work-detail').waitFor();
}
async function assertReader(documentId,pageIndex=0){
  const chapter=page.locator(`.nc-stream-chapter[data-copy-id="${documentId}"]`);
  await chapter.locator(`[data-page-index="${pageIndex}"] .nc-page-image`).waitFor({timeout:60000});
  assert.equal(await page.getByRole('spinbutton',{name:'跳转页码'}).inputValue(),String(pageIndex+1));
}
async function makeArchive(fixturePage,name,seed){
  const writer=new ZipWriter(new Uint8ArrayWriter());
  for(let ordinal=0;ordinal<4;ordinal++){
    const data=await fixturePage.evaluate(({seed,ordinal})=>{
      const canvas=document.createElement('canvas');canvas.width=520;canvas.height=740;
      const ctx=canvas.getContext('2d');ctx.fillStyle=`hsl(${seed*61+ordinal*9} 55% 88%)`;ctx.fillRect(0,0,520,740);
      ctx.fillStyle=`hsl(${seed*61} 48% 32%)`;ctx.fillRect(36,36,448,100);ctx.fillRect(36,170,208,310);ctx.fillRect(272,170,212,310);
      ctx.fillStyle='#ffffff';ctx.font='bold 26px sans-serif';ctx.fillText('SYNTHETIC COMIC '+seed,54,80);ctx.fillText('PAGE '+(ordinal+1),54,116);
      ctx.fillStyle='#27344c';ctx.font='20px sans-serif';ctx.fillText('Work management regression',36,540);ctx.fillText('Generated fixture / no private content',36,579);ctx.fillText('Variant '+seed+' - '+ordinal,36,620);
      return canvas.toDataURL('image/png').split(',')[1];
    },{seed,ordinal});
    await writer.add(`${String(ordinal+1).padStart(3,'0')}.png`,new Uint8ArrayReader(Buffer.from(data,'base64')),{level:0});
  }
  const buffer=Buffer.from(await writer.close());
  await writeFile(path.join(output,name),buffer);
  return {name,mimeType:'application/zip',buffer};
}

try{
  const fixturePage=await context.newPage();
  const files=[];
  for(const [index,name] of ['01-第一话.cbz','02-第二卷.cbz','03-第一话修订.cbz','04-新内容.cbz','05-跨页作品.cbz'].entries())files.push(await makeArchive(fixturePage,name,index+1));
  await fixturePage.close();
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  page=await context.newPage();page.setDefaultTimeout(15000);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/reader.html`);
  await page.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));
  await page.reload();await page.getByRole('heading',{name:'我的漫画',exact:true}).waitFor();
  assert.equal((await snapshot()).works.length,0,'fresh profile must begin with an empty catalog');

  stage='unified import and two reading units';
  await page.getByRole('button',{name:'导入漫画',exact:true}).click();
  let panel=await sourceFiles(files.slice(0,2));
  await panel.getByRole('textbox',{name:'作品名称',exact:true}).fill('作品管理验收');
  await panel.getByRole('button',{name:'加入已有作品',exact:true}).click();
  assert(await panel.getByRole('button',{name:/^开始导入/}).isDisabled(),'existing-work mode requires an actual selection');
  await panel.getByRole('button',{name:'新建作品',exact:true}).click();
  assert.equal(await panel.getByRole('textbox',{name:'作品名称',exact:true}).inputValue(),'作品管理验收','switching back preserves draft title');
  await choose(panel,'内容类型','chapter','话／章节');await choose(panel,'内容性质','main','正文');
  await screenshot('import-new-work');await finishImport(panel,2);
  let records=await recordsUntil(value=>value.documents.length===2,'two documents registered');
  assert.equal(records.works.length,1);assert.equal(records.units.length,2);
  const workId=records.works[0].id;
  const first=records.documents.find(value=>value.title.includes('01-第一话'));
  const second=records.documents.find(value=>value.title.includes('02-第二卷'));
  assert(first&&second);assert.notEqual(first.sourceKey,second.sourceKey,'fixtures must have distinct content');
  const firstUnit=first.unitId,secondUnit=second.unitId;
  checks.push('从统一导入弹框选择本地文件，2 个不同 CBZ 归入同一作品的 2 个阅读条目');
  await until(async()=>await page.locator('.nc-book .nc-source-tag').count()===1,'lazy source badge ready');assert.equal(await page.locator('.nc-book .nc-source-tag').innerText(),'本地文件');
  await page.locator('.nc-book').click({button:'right'});await page.getByRole('menu').waitFor();
  assert.equal(await page.getByRole('menuitem').count(),4);
  await screenshot('shelf-context-menu');await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
  await openWork('作品管理验收');
  for(const id of [firstUnit,secondUnit]){
    assert.equal(await unitCard(id).locator('.nc-library-card-actions > button').count(),1,'card keeps one primary reading button');
    assert.equal(await unitCard(id).locator('details[open]').count(),0,'management actions start collapsed');
  }

  stage='context menu and card layout';
  assert.equal(await page.locator('.nc-content-card details').count(),0);
  assert.equal(await page.locator('.nc-content-card .nc-card-meta,.nc-content-card .nc-card-kicker').count(),0);
  assert.equal(await unitCard(firstUnit).locator('.nc-source-tag').innerText(),'本地文件');
  assert.equal(await page.locator('.nc-work-detail select').count(),0,'all detail dropdowns are custom');
  assert.equal(await page.locator('.nc-content-card .nc-version-tag').count(),0,'file type is not a card tag');
  assert.equal(await page.locator('.nc-more-dots i').count(),3);
  assert.equal(await unitCard(firstUnit).locator('.nc-content-read').getAttribute('data-state'),'unread');
  const coverBounds=await unitCard(firstUnit).locator('.nc-content-cover').boundingBox();assert(coverBounds.height>coverBounds.width);
  const identity=await page.locator('.nc-work-identity').boundingBox(),actions=await page.locator('.nc-work-action-panel').boundingBox();assert(actions.x>identity.x+identity.width);
  assert.equal(await page.getByRole('button',{name:'添加内容',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'编辑作品',exact:true}).isVisible(),false);
  const card=unitCard(firstUnit),coverButton=card.locator('.nc-content-cover');
  await coverButton.focus();await page.keyboard.press('Shift+F10');await page.getByRole('menu').waitFor();
  await page.keyboard.press('End');assert.equal(await page.locator(':focus').innerText(),'标记已读');
  await page.keyboard.press('Home');assert.equal(await page.locator(':focus').innerText(),'版本与来源');
  await page.keyboard.press('Escape');assert(await coverButton.evaluate(element=>element===document.activeElement));
  await card.click({button:'right'});await screenshot('detail-context-menu');
  await page.getByRole('heading',{name:'作品管理验收',level:1}).click();await page.getByRole('menu').waitFor({state:'hidden'});
  const view=page.viewportSize();await card.dispatchEvent('contextmenu',{clientX:view.width-2,clientY:view.height-2});
  let bounds=await page.getByRole('menu').boundingBox();assert(bounds.x+bounds.width<=view.width&&bounds.y+bounds.height<=view.height);
  await page.keyboard.press('Escape');
  checks.push('书架和详情右键菜单、键盘方向键与 Escape 焦点恢复、外部点击关闭、边缘定位；纵向封面标签及左右顶部栏');

  stage='edit work and units';
  await clickAction(page.locator('.nc-work-primary-actions'),'编辑作品');
  let editor=dialog('编辑作品');
  await editor.getByRole('textbox',{name:'作品名称',exact:true}).fill('星河漫游 · 管理验收');
  await editor.getByRole('textbox',{name:'作者（每行一位，选填）',exact:true}).fill('合成作者\n测试绘者');
  await editor.getByRole('textbox',{name:'别名（每行一个，选填）',exact:true}).fill('银河旅程\nFixture Odyssey');
  await editor.getByRole('textbox',{name:'作品简介（选填）',exact:true}).fill('用于隔离浏览器验收的合成作品。');
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();await editor.waitFor({state:'hidden'});
  const workTitle='星河漫游 · 管理验收';
  records=await recordsUntil(value=>value.works.find(item=>item.id===workId)?.title===workTitle,'work metadata persisted');
  assert.deepEqual(records.works[0].aliases,['银河旅程','Fixture Odyssey']);assert.deepEqual(records.works[0].creators,['合成作者','测试绘者']);assert.equal(records.works[0].description,'用于隔离浏览器验收的合成作品。');
  for(const [id,title,kind,role] of [[firstUnit,'第一话 · 启程','chapter','main'],[secondUnit,'第二卷 · 番外','volume','extra']]){
    await clickAction(unitCard(id),'编辑条目');editor=dialog('编辑条目');
    await editor.getByRole('textbox',{name:'名称',exact:true}).fill(title);
    await selectOption(editor.getByRole('combobox',{name:'内容类型',exact:true}),kind);
    await selectOption(editor.getByRole('combobox',{name:'内容性质',exact:true}),role);
    await editor.getByRole('button',{name:'保存修改',exact:true}).click();await editor.waitFor({state:'hidden'});
  }
  records=await snapshot();assert.equal(records.units.find(value=>value.id===secondUnit).role,'extra');
  checks.push('编辑作品名称、作者、别名、简介，以及条目名称、章节／卷册与正文／番外，写入持久目录');

  stage='filters search sorting and batch read';
  const categories=page.getByRole('navigation',{name:'内容分类'});
  await categories.getByRole('button',{name:/^章节/}).click();await count(page.locator('.nc-content-card'),1);assert(await unitCard(firstUnit).isVisible());
  await categories.getByRole('button',{name:/^全部内容/}).click();
  await selectOption(page.getByRole('combobox',{name:'内容性质筛选'}),'extra');await count(page.locator('.nc-content-card'),1);assert(await unitCard(secondUnit).isVisible());
  await selectOption(page.getByRole('combobox',{name:'内容性质筛选'}),'all');
  await page.getByRole('searchbox',{name:'搜索章节或卷册',exact:true}).fill('启程');await count(page.locator('.nc-content-card'),1);
  await page.getByRole('searchbox',{name:'搜索章节或卷册',exact:true}).fill('');
  await selectOption(page.getByRole('combobox',{name:'目录排序'}),'title');await count(page.locator('.nc-content-card'),2);
  const titles=await page.locator('.nc-content-card .nc-card-title').allTextContents();assert.deepEqual(titles,[...titles].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})));
  await page.getByRole('button',{name:'批量整理',exact:true}).click();
  const batch=page.locator('.nc-batch-toolbar');await batch.getByRole('button',{name:'全选筛选结果',exact:true}).click();
  await batch.getByRole('button',{name:'标记已读',exact:true}).click();await recordsUntil(value=>value.units.every(unit=>unit.readAt),'batch read persisted');
  await page.getByRole('button',{name:'完成整理',exact:true}).click();
  await selectOption(page.getByRole('combobox',{name:'阅读状态筛选'}),'unread');await count(page.locator('.nc-content-card'),0);
  await selectOption(page.getByRole('combobox',{name:'阅读状态筛选'}),'read');await count(page.locator('.nc-content-card'),2);
  await page.reload();await openWork(workTitle);await selectOption(page.getByRole('combobox',{name:'阅读状态筛选'}),'read');await count(page.locator('.nc-content-card'),2);
  await selectOption(page.getByRole('combobox',{name:'阅读状态筛选'}),'all');
  checks.push('分类、正文／番外、关键词、名称排序和已读筛选有效；批量已读刷新后仍保留');
  await screenshot('work-detail-desktop');

  stage='import another version into existing unit';
  await openVersions(firstUnit);await dialog('版本与来源').getByRole('button',{name:'添加其他版本',exact:true}).click();
  panel=await sourceFiles([files[2]]);
  assert(await panel.locator('.nc-assignment-selected').filter({hasText:workTitle}).count());
  assert(await panel.locator('.nc-assignment-selected').filter({hasText:'第一话 · 启程'}).count());
  assert(await panel.getByRole('combobox',{name:'内容类型',exact:true}).isDisabled());
  assert(await panel.getByRole('combobox',{name:'内容性质',exact:true}).isDisabled());
  await screenshot('import-existing-version');await finishImport(panel,1);
  records=await recordsUntil(value=>value.documents.length===3,'additional version registered');
  const alternate=records.documents.find(value=>value.title.includes('03-第一话修订'));assert(alternate);assert.equal(alternate.unitId,firstUnit);assert.equal(records.units.length,2);
  await openVersions(firstUnit);await clickAction(versionRow(alternate.id),'编辑版本');editor=dialog('编辑版本');
  await editor.getByRole('textbox',{name:'名称',exact:true}).fill('第一话 · 修订版');
  await editor.getByRole('textbox',{name:'版本说明（选填）',exact:true}).fill('合成彩色修订');
  await editor.getByRole('textbox',{name:'语言（选填）',exact:true}).fill('zh-CN');
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();await editor.waitFor({state:'hidden'});
  records=await snapshot();assert.equal(records.documents.find(value=>value.id===alternate.id).versionLabel,'合成彩色修订');
  checks.push('从条目添加其他版本，导入默认既有作品和条目，继承分类；可编辑版本名称、说明和语言');

  stage='preferred version and explicit nonpreferred read';
  await openVersions(firstUnit);
  const preferredButton=versionRow(first.id).getByRole('button',{name:'设为首选',exact:true});
  if(await preferredButton.count())await clickAction(versionRow(first.id),'设为首选');
  await recordsUntil(value=>value.units.find(unit=>unit.id===firstUnit).preferredDocumentId===first.id,'first version preferred');
  await versionRow(alternate.id).getByRole('button',{name:'开始阅读',exact:true}).click();
  await assertReader(alternate.id);
  const jump=page.getByRole('spinbutton',{name:'跳转页码'});await jump.fill('2');await jump.press('Enter');await assertReader(alternate.id,1);
  await screenshot('nonpreferred-reader');await backFromReader();
  records=await recordsUntil(value=>value.positions.some(position=>position.documentId===alternate.id),'explicit version position persisted');
  const position=records.positions.find(value=>value.documentId===alternate.id);assert.equal(position.workId,workId);
  await page.locator('.nc-work-primary-actions').getByRole('button',{name:'继续阅读',exact:true}).click();await assertReader(alternate.id,1);await backFromReader();
  const timestamp=await page.locator('.nc-work-resume time').getAttribute('datetime');assert.equal(Date.parse(timestamp),(await snapshot()).works.find(work=>work.id===workId).lastReadAt);
  checks.push('首选保留原版本时，显式打开修订版仍读取修订版；作品继续阅读恢复修订版第 2 页');

  stage='work cover and same-work reassignment';
  await page.getByRole('button',{name:'更换作品封面',exact:true}).click();
  await dialog('更换作品封面').locator('.nc-cover-choice').filter({hasText:'第一话 · 修订版'}).click();await dialog('更换作品封面').waitFor({state:'hidden'});
  await recordsUntil(value=>value.works.find(work=>work.id===workId).cover?.documentId===alternate.id,'custom work cover persisted');
  await openVersions(firstUnit);await clickAction(versionRow(alternate.id),'纠正归属');
  const move=dialog('纠正归属');await selectOption(move.getByRole('combobox',{name:'目标条目',exact:true}),secondUnit);await move.getByRole('button',{name:'确认调整',exact:true}).click();await move.waitFor({state:'hidden'});
  records=await recordsUntil(value=>value.documents.find(doc=>doc.id===alternate.id).unitId===secondUnit,'version moved within work');
  assert.equal(records.documents.find(doc=>doc.id===alternate.id).revisionId,alternate.revisionId);
  const movedPosition=records.positions.find(value=>value.documentId===alternate.id);
  for(const key of ['documentId','revisionId','pageId','relativeOffset','workId'])assert.equal(movedPosition[key],position[key]);
  assert.equal(records.works.find(value=>value.id===workId).cover.documentId,alternate.id);
  checks.push('更换作品封面、同作品纠正版本归属成功；冻结修订、独立阅读位置及有效作品封面保持');

  stage='add content defaults to current work';
  await clickAction(page.locator('.nc-work-primary-actions'),'添加内容');panel=await sourceFiles([files[3]]);
  assert(await panel.locator('.nc-assignment-selected').filter({hasText:workTitle}).count());
  assert.equal(await panel.getByRole('button',{name:'新建阅读条目',exact:true}).getAttribute('aria-pressed'),'true');
  await finishImport(panel,1);records=await recordsUntil(value=>value.documents.length===4,'new content added');assert.equal(records.works.length,1);assert.equal(records.units.length,3);
  checks.push('作品详情添加内容默认归入当前作品，并创建新阅读条目');
  await clickAction(unitCard(firstUnit),'标记未读');
  await unitCard(firstUnit).getByRole('button',{name:'开始阅读',exact:true}).click();await assertReader(first.id);await backFromReader();
  await until(async()=>await unitCard(firstUnit).locator('.nc-content-read').getAttribute('data-state')==='reading','reading badge follows saved position');
  assert.equal(await unitCard(secondUnit).locator('.nc-content-read').getAttribute('data-state'),'read');
  const newUnit=records.units.find(unit=>unit.id!==firstUnit&&unit.id!==secondUnit);
  assert.equal(await unitCard(newUnit.id).locator('.nc-content-read').getAttribute('data-state'),'unread');
  await screenshot('reading-status-badges');

  stage='narrow screen and refresh';
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>{const header=document.querySelector('.nc-app-header'),nav=header?.querySelector('nav');return !!header&&!!nav&&nav.getBoundingClientRect().bottom<=header.getBoundingClientRect().bottom+1;}),'narrow header must contain its navigation without overlapping content');
  await unitCard(firstUnit).click({button:'right'});bounds=await page.getByRole('menu').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);await screenshot('context-menu-narrow');await page.keyboard.press('Escape');
  const touchCover=unitCard(firstUnit).locator('.nc-content-cover');await touchCover.scrollIntoViewIfNeeded();
  const touchBounds=await touchCover.boundingBox();
  await touchCover.dispatchEvent('pointerdown',{pointerType:'touch',clientX:touchBounds.x+30,clientY:touchBounds.y+30});
  await page.getByRole('menu').waitFor();await touchCover.dispatchEvent('pointerup',{pointerType:'touch'});await touchCover.dispatchEvent('click');
  assert.equal(await dialog('版本与来源').count(),0,'long press must not also activate the cover');await page.keyboard.press('Escape');
  await screenshot('work-detail-narrow');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow work detail must not overflow');
  await clickAction(page.locator('.nc-work-primary-actions'),'编辑作品');await screenshot('work-editor-narrow');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow editor must not overflow');
  await dialog('编辑作品').getByRole('button',{name:'取消',exact:true}).click();
  await page.reload();await openWork(workTitle);records=await snapshot();
  assert.equal(records.works.find(value=>value.id===workId).cover.documentId,alternate.id);assert.equal(records.documents.find(value=>value.id===alternate.id).unitId,secondUnit);
  await screenshot('refreshed-narrow');checks.push('390px 详情和编辑弹框无整页横向溢出；刷新后资料、归属、封面和阅读状态仍保留');
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的漫画',exact:true}).click();
  await page.getByRole('heading',{name:'我的漫画',exact:true}).waitFor();assert.equal(await page.locator('.nc-work-detail').count(),0);
  checks.push('阅读返回保留作品详情；顶部我的漫画明确返回完整书架');

  stage='global existing-work selection beyond shelf page';
  await page.setViewportSize({width:1440,height:1000});
  // The sole catalog write outside product commands: synthetic empty works in this
  // run's fresh profile, specifically to put a selectable work beyond shelf page 1.
  const targetId='fixture-cross-page-target',targetTitle='跨页目标作品 · 合成';
  await page.evaluate(async({targetId,targetTitle})=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-sources-v1-catalog');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{await new Promise((resolve,reject)=>{const transaction=db.transaction('works','readwrite'),store=transaction.objectStore('works');for(let index=0;index<1000;index++)store.put({id:index===0?targetId:'fixture-empty-work-'+index,title:index===0?targetTitle:'分页占位作品 '+String(index).padStart(2,'0'),createdAt:1,updatedAt:index===0?1:Date.now()+index,documentCount:0});transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}finally{db.close();}
  },{targetId,targetTitle});
  await page.reload();await page.getByRole('heading',{name:'我的漫画',exact:true}).waitFor();
  await until(async()=>await page.locator('.nc-shelf-count').innerText()==='1001','full library count');
  assert.equal(await page.getByRole('navigation',{name:'书架分页'}).count(),0);
  assert.equal(await page.locator('.nc-library select').count(),0);
  assert(await page.locator('.nc-book').count()<50,'only nearby shelf cards are mounted');
  metrics.shelfWorks=1001;metrics.cardsAtTop=await page.locator('.nc-book').count();
  const counter=await page.locator('.nc-shelf-count').boundingBox();assert(counter.width>46,'four digit count expands the avatar badge');
  const toolbar=await page.locator('.nc-shelf-tools').boundingBox(),sortControl=await page.getByRole('combobox',{name:'作品排序'}).boundingBox();assert(Math.abs(toolbar.x+toolbar.width-sortControl.x-sortControl.width)<2,'sort is at the far right');
  await screenshot('shelf-lazy-top');
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  await until(async()=>await page.getByRole('button',{name:'打开作品 '+workTitle,exact:true}).count()===1,'lazy work near the end');
  assert(await page.locator('.nc-book').count()<50,'scrolling does not accumulate cards');
  metrics.cardsAtEnd=await page.locator('.nc-book').count();
  await page.getByRole('button',{name:'打开作品 '+workTitle,exact:true}).scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const savedScroll=await page.evaluate(()=>scrollY);
  await openWork(workTitle);await page.getByRole('button',{name:'← 我的漫画',exact:true}).click();
  await until(async()=>Math.abs(await page.evaluate(()=>scrollY)-savedScroll)<3,'shelf restores its scroll position').catch(async error=>{throw Error(error.message+JSON.stringify({savedScroll,current:await page.evaluate(()=>({scroll:scrollY,height:document.documentElement.scrollHeight,grid:document.querySelector('.nc-shelf-grid')?.getAttribute('style')}))}));});
  await screenshot('shelf-lazy-bottom');

  await openWork(workTitle);await clickAction(page.locator('.nc-work-primary-actions'),'编辑作品');editor=dialog('编辑作品');
  await editor.getByRole('textbox',{name:'作品简介（选填）',exact:true}).fill('远端窗口编辑后仍留在作品详情。');
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();await editor.waitFor({state:'hidden'});
  await page.getByRole('heading',{name:workTitle,level:1,exact:true}).waitFor();
  await recordsUntil(value=>value.works.find(work=>work.id===workId).description==='远端窗口编辑后仍留在作品详情。','off-page edit remains in details');
  checks.push('千部作品的虚拟书架只挂载邻近卡片，返回恢复滚动；窗口外作品编辑后详情保持打开');
  await page.getByRole('button',{name:'← 我的漫画',exact:true}).click();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('heading',{name:'我的漫画',exact:true}).waitFor();
  await until(async()=>await page.locator('.nc-book').count()>0&&await page.locator('.nc-book').count()<50,'bounded shelf cards');
  await selectOption(page.getByRole('combobox',{name:'作品排序'}),'title');
  await page.getByRole('searchbox',{name:'搜索书架作品',exact:true}).fill(targetTitle);await count(page.locator('.nc-book'),1);
  assert(await page.getByRole('button',{name:'打开作品 '+targetTitle,exact:true}).isVisible(),'search covers the full library');
  await page.getByRole('searchbox',{name:'搜索书架作品',exact:true}).fill('');await selectOption(page.getByRole('combobox',{name:'作品排序'}),'updated');
  await until(async()=>await page.getByRole('button',{name:'打开作品 '+targetTitle,exact:true}).count()===0,'sort resets the lazy window');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));
  await until(async()=>await page.locator('.nc-book').count()<25,'narrow shelf window');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  metrics.cardsOnNarrowScreen=await page.locator('.nc-book').count();
  await screenshot('shelf-narrow');await page.getByRole('combobox',{name:'作品排序'}).click();
  const sortBounds=await page.getByRole('listbox').filter({visible:true}).evaluate(element=>({right:element.getBoundingClientRect().right,viewport:Math.min(document.documentElement.clientWidth,document.documentElement.getBoundingClientRect().width)}));
  assert(sortBounds.right<=sortBounds.viewport-8,'rightmost dropdown leaves room for the scrollbar gutter');
  await screenshot('shelf-sort-narrow');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.getByRole('button',{name:'打开作品 '+targetTitle,exact:true}).count(),0,'target must be outside first shelf page');
  await page.getByRole('button',{name:'导入漫画',exact:true}).click();panel=await sourceFiles([files[4]]);
  await panel.getByRole('button',{name:'加入已有作品',exact:true}).click();
  await panel.getByRole('searchbox',{name:'搜索书架作品',exact:true}).fill(targetTitle);
  await panel.locator('.nc-assignment-results').getByRole('button',{name:new RegExp(targetTitle)}).click();
  await screenshot('import-cross-page-work');await finishImport(panel,1);
  records=await recordsUntil(value=>value.documents.length===5,'cross-page work import');
  const crossDocument=records.documents.find(value=>value.title.includes('05-跨页作品'));assert(crossDocument);assert.equal(records.units.find(value=>value.id===crossDocument.unitId).workId,targetId);assert.equal(records.works.length,1001);
  checks.push('隔离目录添加 1000 个空作品后，首页和导入全库搜索、排序有效，四位数徽章自适应宽度');

  stage='multiple source badges and failed metadata';
  // Presentation-only source fixture in this run's isolated catalog; no website is accessed.
  await page.evaluate(async({documentId})=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-sources-v1-catalog');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{await new Promise((resolve,reject)=>{
      const tx=db.transaction(['documents','bindings','connections'],'readwrite');
      const request=tx.objectStore('documents').get(documentId);
      request.onsuccess=()=>{const doc=request.result;tx.objectStore('documents').put({...doc,indexState:'failed',error:'合成目录失败',coverPageId:undefined});
        tx.objectStore('connections').put({id:'fixture-website',provider:'website',displayName:'不应显示的作品名称',status:'connected',generation:1,createdAt:1,updatedAt:1});
        tx.objectStore('bindings').put({id:doc.sourceBindingId,connectionId:'fixture-website',providerItemId:doc.id,locator:{url:'https://xkcd.com/1/'},generation:1,createdAt:1,updatedAt:1});};
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  },{documentId:alternate.id});
  await page.reload();
  await page.getByRole('searchbox',{name:'搜索书架作品',exact:true}).fill(workTitle);
  const shelfCard=page.locator('.nc-book').filter({has:page.getByRole('button',{name:'打开作品 '+workTitle,exact:true})});
  await until(async()=>await shelfCard.locator('.nc-source-tag').innerText()==='2 个来源','multiple sources on shelf');
  assert.deepEqual((await shelfCard.locator('.nc-source-tag').getAttribute('title')).split(' · ').sort(),['本地文件','xkcd'].sort());
  await screenshot('shelf-sources');
  await clickAction(shelfCard,'编辑作品');await dialog('编辑作品').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.locator('.nc-work-stats .nc-source-tag').innerText(),'2 个来源');
  assert.equal(await unitCard(secondUnit).locator('.nc-source-tag').innerText(),'2 个来源');
  assert.equal(await unitCard(firstUnit).locator('.nc-source-tag').innerText(),'本地文件');
  await openVersions(secondUnit);assert(await versionRow(alternate.id).getByText('xkcd · 需要恢复目录',{exact:true}).isVisible());
  assert(await versionRow(alternate.id).getByText('合成目录失败',{exact:true}).isVisible());
  await dialog('版本与来源').getByRole('button',{name:'关闭',exact:true}).click();
  await screenshot('detail-sources');
  await page.getByRole('button',{name:'← 我的漫画',exact:true}).click();await clickAction(shelfCard,'移除作品');
  await dialog('移除作品').getByRole('button',{name:'取消',exact:true}).click();
  records=await snapshot();assert(records.works.some(work=>work.id===workId),'cancel removal must preserve the work');
  checks.push('作品与条目按来源去重显示名称或 2 个来源，来源名称取站点定义；失败版本保留原因及恢复入口；书架右键编辑与取消移除可用');
  assert.deepEqual(errors,[],'browser page errors');
}catch(error){
  failure={stage,message:error.message,stack:error.stack};
  if(page)await screenshot('failure').catch(()=>{});
}finally{
  const result={startedAt,finishedAt:new Date().toISOString(),browser:context.browser()?.version(),extension:true,manifestSha256:createHash('sha256').update(manifest).digest('hex'),profile:'fresh isolated profile',fixture:'generated PNG pages in distinct CBZ archives; 1000 synthetic empty works for lazy shelf loading',status:failure?'failed':'passed',checks,metrics,errors,consoleErrors,...(failure?{failure}:{})};
  await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,...result},null,2));
  await context.close();
  if(failure)process.exitCode=1;
}
