// npm run dev -- --port 5206; real result-site UI with 20 synthetic successful sites.
import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5206',output=fileURLToPath(new URL('../../../artifacts/search-sites/',import.meta.url));
let browser,page,errors,external;
before(async()=>{await mkdir(output,{recursive:true});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});});
after(async()=>{await browser?.close();});
beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:1560,height:1120},reducedMotion:'reduce',serviceWorkers:'block'});
  errors=[];external=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();external.push(url.origin);return route.abort();});
});
afterEach(async()=>{assert.equal(await page.evaluate(()=>document.body.dataset.fixtureFetches??'0'),'0');await page.close();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);});
const group=key=>page.locator('.nc-search-status-group.is-'+key);
const found=()=>group('found');
const toggleList=()=>found().locator('.nc-search-sites-expand');
async function load(locale='zh-CN'){await page.goto(`${origin}/tests/search-workspace.html?sites=20&locale=${locale}`);await found().locator('.nc-search-status').first().waitFor();}
async function fits(){
  const issues=await page.locator('.nc-search-status-groups').evaluate(root=>{
    const nodes=[root,...root.querySelectorAll('.nc-search-group-sites,.nc-search-status,.nc-search-status b,.nc-search-sites-summary')].filter(node=>node.getClientRects().length);
    return nodes.filter(node=>node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1).map(node=>node.className);
  });
  assert.deepEqual(issues,[],'Site names and controls fit without clipping or an inner horizontal scroller');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const targets=await found().locator('.nc-search-status').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  assert(targets.every(height=>height>=44),'All site buttons remain large enough to operate');
  const nameWidths=await found().locator('.nc-search-status b').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
  assert(nameWidths.every(width=>width>=80),'Narrow or large-text layouts must leave readable space for complete site names');
}
async function snapshot(name){
  await page.evaluate(()=>scrollTo(0,0));
  await page.mouse.move(0,0);
  const bounds=await page.locator('.nc-search-results').boundingBox();
  await page.screenshot({path:output+name+'.png',clip:{x:bounds.x,y:bounds.y,width:bounds.width,height:Math.min(720,page.viewportSize().height-bounds.y)}});
}

test('20 sites stay compact, reveal locally, and retain a selected site when collapsed or revisited',async()=>{
  await load();await fits();
  assert.equal(await found().locator('.nc-search-group-count').innerText(),'20');
  assert.equal(await found().locator('.nc-search-status').count(),10);
  assert.match(await found().locator('.nc-search-sites-summary').innerText(),/显示 10 \/ 20 个网站/);
  for(const key of ['empty','login','failed'])assert.equal(await group(key).locator('.nc-search-status-list').isVisible(),false);
  const collapsed=(await found().boundingBox()).height;
  assert(collapsed<=200,'The default desktop site selector stays within 200px');
  await snapshot('20-sites-default');
  await toggleList().press('Enter');assert.equal(await found().locator('.nc-search-status').count(),20);await fits();
  const expanded=(await found().boundingBox()).height;
  assert(expanded>collapsed&&expanded<=320,'All 20 desktop sites stay compact when expanded');
  const names=await found().locator('.nc-search-status b').allTextContents(),last=found().locator('.nc-search-status').last(),lastLabel=await last.getAttribute('aria-label');
  await last.click();assert.equal(await last.getAttribute('aria-pressed'),'true');
  const candidateCount=await page.locator('.nc-search-result').count();assert(candidateCount>0&&candidateCount<=4);
  await toggleList().press('Space');assert.equal(await found().locator('.nc-search-status').count(),10);
  const retained=found().locator('.nc-search-status[aria-pressed=true]');
  assert.equal(await retained.getAttribute('aria-label'),lastLabel);assert.equal(await page.locator('.nc-search-result').count(),candidateCount);
  assert(await toggleList().evaluate(node=>node===document.activeElement),'Collapsing retains keyboard focus');
  await page.getByRole('button',{name:'暂时离开',exact:true}).click();await page.getByRole('button',{name:'返回搜索',exact:true}).click();
  assert.equal(await retained.getAttribute('aria-label'),lastLabel);assert.equal(await found().locator('.nc-search-status').count(),10);
  await retained.press('Enter');assert.equal(await page.locator('.nc-search-result').count(),50);
  assert(await toggleList().evaluate(node=>node===document.activeElement),'Deselecting the pinned item keeps focus on the expand control');
  await toggleList().click();assert.deepEqual(await found().locator('.nc-search-status b').allTextContents(),names);
  await snapshot('20-sites-expanded');
  await writeFile(output+'layout.json',JSON.stringify({evidence:'Local Vite fixture; 20 successful sites and synthetic candidates; no source or model traffic',viewport:page.viewportSize(),defaultVisible:10,total:20,collapsedHeight:collapsed,expandedHeight:expanded},null,2));
});

test('long names, translated controls, dark mode and narrow widths remain readable',async()=>{
  for(const locale of ['zh-CN','en','de']){
    await load(locale);
    for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:900});await fits();
      await toggleList().click();assert.equal(await found().locator('.nc-search-status').count(),20);await fits();
      const last=found().locator('.nc-search-status').last();await last.press('Enter');assert.equal(await last.getAttribute('aria-pressed'),'true');await last.press('Enter');
      await toggleList().click();
      await page.evaluate(()=>{document.documentElement.dataset.appearance='dark';});
      if(width===320)await page.evaluate(()=>{document.documentElement.style.setProperty('--text-scale','1.2');});
      await fits();await snapshot(`${locale}-${width}-dark`);
      await page.evaluate(()=>{document.documentElement.dataset.appearance='light';document.documentElement.style.removeProperty('--text-scale');});
    }
  }
});
