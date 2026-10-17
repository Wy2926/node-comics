// Built MV3 code, isolated Chromium profile, synthetic old version; no store or user profile.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve('artifacts/extension-upgrade');
await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-')),extension=path.join(run,'extension');
await cp('apps/extension/.output/chrome-mv3',extension,{recursive:true});
const manifestPath=path.join(extension,'manifest.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
assert.equal(manifest.version,'1.0.0');
// Observe actual browser events without replacing any production listeners or tab APIs.
const backgroundPath=path.join(extension,manifest.background.service_worker);
await writeFile(backgroundPath,`chrome.runtime.onInstalled.addListener(event=>{
  void chrome.storage.local.set({upgradeFixtureEvent:event});
});\n`+await readFile(backgroundPath,'utf8'));
await writeFile(manifestPath,JSON.stringify({...manifest,version:'0.12.0'}));
const context=await chromium.launchPersistentContext(path.join(run,'profile'),{
  headless:true,channel:'chromium',executablePath:process.env.TEST_CHROMIUM,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});
context.setDefaultTimeout(30_000);
await context.route('https://**/*',route=>route.abort());
async function until(read,accept){
  const deadline=Date.now()+30_000;
  while(Date.now()<deadline){const value=await read();if(accept(value))return value;await delay(100);}
  throw Error('Timed out waiting for extension lifecycle state.');
}
try{
  let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).hostname;
  const readerUrl=`chrome-extension://${extensionId}/reader.html`;
  const installed=await until(()=>worker.evaluate(()=>chrome.storage.local.get('upgradeFixtureEvent')),
    value=>value.upgradeFixtureEvent?.reason==='install');
  assert.equal(installed.upgradeFixtureEvent.reason,'install');
  await until(async()=>context.pages().filter(page=>page.url()===readerUrl),pages=>pages.length===1);
  // Enable unpacked-extension reloads through Chromium's own settings in this isolated profile.
  const management=await context.newPage();
  await management.goto('chrome://extensions/');
  await management.evaluate(()=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  await management.close();
  const readingPage=await context.newPage();
  await readingPage.goto('about:blank');
  await readingPage.setContent('<title>Uninterrupted reading</title><p>Keep this page open.</p>');
  await readingPage.bringToFront();
  for(const page of context.pages())if(page!==readingPage)await page.close();
  const before=await worker.evaluate(()=>chrome.tabs.query({}));
  const created=[];
  context.on('page',page=>created.push(page));
  await worker.evaluate(()=>chrome.storage.local.remove('upgradeFixtureEvent'));
  await writeFile(manifestPath,JSON.stringify(manifest));
  const restarted=context.waitForEvent('serviceworker',{predicate:next=>new URL(next.url()).hostname===extensionId});
  await worker.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),0);});
  worker=await restarted;
  const updated=await until(()=>worker.evaluate(()=>chrome.storage.local.get('upgradeFixtureEvent')),
    value=>value.upgradeFixtureEvent?.reason==='update');
  assert.equal(updated.upgradeFixtureEvent.previousVersion,'0.12.0');
  assert.equal(await worker.evaluate(()=>chrome.runtime.getManifest().version),'1.0.0');
  // Allow delayed background work to settle; there must be no navigation or focus change.
  await delay(1000);
  assert.equal(created.length,0,'An upgrade must not open any tab.');
  const after=await worker.evaluate(()=>chrome.tabs.query({}));
  const state=tabs=>tabs.map(({id,url,active})=>({id,url,active}));
  assert.deepEqual(state(after),state(before));
  assert.equal(await readingPage.title(),'Uninterrupted reading');
  console.log(JSON.stringify({version:manifest.version,previousVersion:updated.upgradeFixtureEvent.previousVersion,
    checks:['First install opens the library once.','Actual Chromium update event opens no tabs and preserves the active page.'],artifacts:run},null,2));
}finally{await context.close();}
