// Use Vite on 127.0.0.1:5181 and scripts/reader_streaming_fixture_server.mjs on :5211.
// Generate its synthetic images with scripts/generate_reader_streaming_fixture.py first.
import assert from 'node:assert/strict';
import {after,afterEach,before,beforeEach,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setReaderProgress} from './reader-progress-driver.mjs';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5181',source='http://127.0.0.1:5211';
const artifacts=resolve(process.env.READER_STREAMING_ARTIFACTS||'artifacts/reader-streaming-layout');
let browser,page,errors;
before(async()=>{
 await mkdir(artifacts,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
});
after(async()=>{await browser?.close();});
async function createPage(options={}){
 page=await browser.newPage({viewport:{width:1281,height:901},reducedMotion:'reduce',serviceWorkers:'block',...options});
 page.setDefaultTimeout(20000);errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>[origin,source].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
}
beforeEach(()=>createPage());
afterEach(async()=>{await page?.close();assert.deepEqual(errors,[]);});
const viewport=()=>page.locator('.nc-reading-viewport');
const cell=id=>viewport().locator(`.nc-manga-page[data-page-id="${id}"]`);
const preview=id=>cell(id).locator('.nc-page-preview:visible');
const shown=id=>cell(id).locator('.nc-page-image');
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function start(layout,extra={}){
 const query=new URLSearchParams({layout,pages:'1',kib:'512',unknownSize:'1',...extra});
 await page.goto(`${origin}/tests/reader-streaming-fixture.html?${query}`);
 await page.getByRole('button',{name:'开始慢网加载',exact:true}).click();
 await viewport().waitFor();
}
async function geometry(id){
 return cell(id).evaluate(element=>{
  const pixels=element.querySelector('.nc-page-image')??element.querySelector('.nc-page-preview');
  const bounds=node=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};};
  return {cell:bounds(element),pixels:bounds(pixels),scroll:element.closest('.nc-reading-viewport').scrollTop};
 });
}
function sameGeometry(actual,expected){
 for(const box of ['cell','pixels'])for(const key of ['x','y','width','height'])
  assert.ok(Math.abs(actual[box][key]-expected[box][key])<.05,`${box}.${key}: ${expected[box][key]} -> ${actual[box][key]}`);
 assert.ok(Math.abs(actual.scroll-expected.scroll)<.05,`scroll: ${expected.scroll} -> ${actual.scroll}`);
}
async function watch(id){
 await page.evaluate(id=>{
  window.__streamGeometry=[];
  const sample=()=>{
   const element=document.querySelector(`.nc-manga-page[data-page-id="${id}"]`);
   const image=element?.querySelector('.nc-page-image'),canvas=element?.querySelector('.nc-page-preview');
   const pixels=image??(canvas&&getComputedStyle(canvas).display!=='none'?canvas:undefined);
   const bounds=node=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};};
   const state=element&&pixels?{cell:bounds(element),pixels:bounds(pixels),scroll:element.closest('.nc-reading-viewport').scrollTop}:null;
   if(JSON.stringify(window.__streamGeometry.at(-1))!==JSON.stringify(state))window.__streamGeometry.push(state);
   window.__streamFrame=requestAnimationFrame(sample);
  };sample();
 },id);
}
async function assertStable(expected){
 await settle();
 const frames=await page.evaluate(()=>{cancelAnimationFrame(window.__streamFrame);return window.__streamGeometry;});
 assert.ok(frames.length>0);
 for(const frame of frames){assert.ok(frame,'readable pixels disappeared during replacement');sameGeometry(frame,expected);}
}
async function counts(){
 const run=await viewport().locator('.nc-stream-chapter').first().getAttribute('data-copy-id');
 return page.evaluate(async({run,source})=>await(await fetch(`${source}/metrics?run=${run}`)).json(),{run,source});
}

for(const layout of ['continuous','single','double'])test(`${layout}: native preview and full image keep the first real geometry`,async()=>{
 await start(layout);await preview('1').waitFor();await settle();
 const before=await geometry('1');
 assert.ok(Math.abs(before.cell.width/before.cell.height-2/3)<.0001,'first preview must replace the estimated manifest ratio');
 await watch('1');await page.screenshot({path:resolve(artifacts,`${layout}-preview.png`)});
 await shown('1').waitFor();await assertStable(before);sameGeometry(await geometry('1'),before);
 await page.screenshot({path:resolve(artifacts,`${layout}-loaded.png`)});
 const reads=await counts();assert.equal(reads.length,1);assert.equal(reads[0].complete,true);
});

test('double: a portrait pair stays aligned as each download finishes',async()=>{
 await start('double',{pages:'4',kib:'256'});
 await page.keyboard.press('Escape');
 await setReaderProgress(page.getByRole('slider',{name:'阅读进度',exact:true}),2);
 await preview('2').waitFor();await preview('3').waitFor();await settle();
 const before=[await geometry('2'),await geometry('3')];
 assert.equal(before[0].cell.y,before[1].cell.y);assert.equal(before[0].cell.height,before[1].cell.height);
 await watch('2');await page.screenshot({path:resolve(artifacts,'pair-preview.png')});
 await shown('2').waitFor();await shown('3').waitFor();await assertStable(before[0]);
 sameGeometry(await geometry('2'),before[0]);sameGeometry(await geometry('3'),before[1]);
 await page.screenshot({path:resolve(artifacts,'pair-loaded.png')});
});

test('double: zooming and panning a partial preview survives the complete image',async()=>{
 await start('double',{kib:'256'});await preview('1').waitFor();await settle();
 const box=await viewport().boundingBox();
 await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5);
 await page.mouse.wheel(0,-200);
 await page.waitForFunction(()=>Number(document.querySelector('.nc-reading-viewport')?.dataset.spreadZoom)>100);
 await page.mouse.down();await page.mouse.move(box.x+box.width*.55,box.y+box.height*.6,{steps:8});await page.mouse.up();
 const before=await geometry('1'),zoom=await viewport().getAttribute('data-spread-zoom');await watch('1');
 await shown('1').waitFor();await assertStable(before);
 assert.equal(await viewport().getAttribute('data-spread-zoom'),zoom);
});

test('continuous: completing a page preserves the scrolled anchor and reopening position',async()=>{
 await start('continuous',{pages:'4',kib:'256'});await preview('1').waitFor();await settle();
 await viewport().evaluate(element=>{element.scrollTop=400;});await settle();
 const before=await geometry('1');assert.equal(before.scroll,400);await watch('1');
 await shown('1').waitFor();await assertStable(before);
 await page.getByRole('button',{name:'关闭并保存位置',exact:true}).click();
 await viewport().waitFor({state:'hidden'});
 await page.getByRole('button',{name:'重开阅读器',exact:true}).click();
 await shown('1').waitFor();await settle();sameGeometry(await geometry('1'),before);
});

test('failed streaming clears partial pixels and retries in the same page frame',async()=>{
 await start('single',{fault:'1'});await preview('1').waitFor();await settle();
 const before=await geometry('1');
 await cell('1').locator('.nc-image-failure').waitFor();
 assert.equal(await preview('1').count(),0);assert.equal(await shown('1').count(),0);
 assert.ok((await page.locator('output').first().textContent()).includes('已读 0'));
 await cell('1').getByRole('button',{name:'重试',exact:true}).click();
 await preview('1').waitFor();await settle();sameGeometry(await geometry('1'),before);await watch('1');
 await shown('1').waitFor();await assertStable(before);
 const reads=await counts();assert.equal(reads.length,2);assert.equal(reads[0].cancelled,true);assert.equal(reads[1].complete,true);
});

test('first phone opening resolves fit and keeps 100 percent before the full image',async()=>{
 await page.close();await createPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 await start('single',{newComic:'1'});await preview('1').waitFor();await settle();
 const before=await geometry('1'),view=await page.evaluate(()=>JSON.parse(localStorage.getItem('reader-streaming-fixture')));
 assert.equal(view.zoom,100);assert.equal(view.fit,'window');
 await watch('1');await shown('1').waitFor();await assertStable(before);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('reader-streaming-fixture'))),view);
});
