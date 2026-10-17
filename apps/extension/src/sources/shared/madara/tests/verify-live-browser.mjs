// Real public-source HTTP/CDN + built MV3, in a new profile. No source routes, mocks or model calls.
// Run from repository root: node <this-file> <siteId> <work-or-chapter-url> [second-chapter-url] [--max-pages=40]
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2), usage = 'Usage: node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs <siteId> <work-or-chapter-url> [second-chapter-url] [--max-pages=40]';
if (args.includes('--help')) {console.log(usage); process.exit(0);}
const positional = args.filter(value => !value.startsWith('--')), [siteId, inputUrl, secondUrl] = positional;
const flags = args.filter(value => value.startsWith('--'));
assert(positional.length >= 2 && positional.length <= 3 && /^[a-z0-9-]+$/.test(siteId), usage);
assert(flags.length <= 1 && flags.every(value => /^--max-pages=\d+$/.test(value)), usage);
const maxPages = Number(flags[0]?.split('=')[1] ?? 40);
assert(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 100, '--max-pages must be between 1 and 100');
for (const input of [inputUrl, secondUrl].filter(Boolean)) {
  const url = new URL(input);
  assert(url.protocol === 'https:' && !url.username && !url.password, 'Only public HTTPS work/chapter URLs are accepted');
}

const root = process.cwd(), base = path.join(root, 'artifacts/madara-live-browser', siteId);
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const sourceUrl = value => {try {const url = new URL(value); return url.origin + url.pathname;} catch {return '(unavailable)';}};
const redact = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, sourceUrl).slice(0, 1500);
const checks = [], selected = [], pageErrors = [], httpFailures = [];
const pendingSizes = new Set();
const network = {requests: 0, imageResponses: 0, completedBodyBytes: 0, blockedServiceRequests: 0, origins: {}};
const limits = {chapters: secondUrl ? 2 : 1, maxChapterPages: maxPages, imageResponses: 24, requests: 180, bytes: 64 * 1024 * 1024, timeoutMs: 240000};
let browser, reader, watchdog, stage = 'prepare', fatal, serviceOrigin, manifest, home, activeEntry, catalogUrl, identity;
const stop = message => {if (!fatal) {fatal = new Error(message); void browser?.close().catch(() => {});}};
const inspect = () => reader.evaluate(async () => (await import(chrome.runtime.getURL('madara-inspect.js'))).snapshot());
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertState(state) {
  assert.equal(state.comicCount, 1, 'Import must keep exactly one comic in the isolated profile');
  assert.equal(state.comic.connectionId, 'website:' + identity.adapter);
  assert.equal(state.comic.providerItemId, identity.location.catalog.key);
  assert(state.catalog.complete && state.catalog.groupsComplete && state.catalog.entries > 0, 'Catalog must be complete');
  assert.equal(state.entries.length, state.catalog.entries, 'Every source chapter must be retained');
  assert.equal(new Set(state.entries.map(entry => entry.sourceEntryId)).size, state.entries.length);
  assert(state.comic.hasDedicatedCover, 'The work must have a dedicated source cover');
}
async function currentEntry() {
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  await reader.waitForFunction(() => Number(document.querySelector('.nc-reading-viewport')?.getAttribute('data-page-count')) > 0);
  const id = await reader.locator('.nc-stream-chapter').first().getAttribute('data-copy-id'), state = await inspect();
  assertState(state);
  const entry = state.entries.find(item => item.id === id);
  assert(entry?.discoveryComplete && entry.pageCount > 0, 'Selected chapter must have a complete page list');
  assert(entry.pageCount <= maxPages, `Selected chapter has ${entry.pageCount} pages; select a short chapter or set --max-pages (maximum 100)`);
  activeEntry = entry.id;
  return {entry, state};
}
async function decoded(pageNumber) {
  await reader.waitForFunction(({entry, number}) => {
    const image = document.querySelector(`[data-copy-id="${entry}"] [data-page-index="${number - 1}"] img.nc-page-image`);
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
    const rect = image.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
  }, {entry: activeEntry, number: pageNumber}, {timeout: 60000});
  const image = reader.locator(`[data-copy-id="${activeEntry}"] [data-page-index="${pageNumber - 1}"] img.nc-page-image`);
  const size = await image.evaluate(async element => {await element.decode(); return {width: element.naturalWidth, height: element.naturalHeight};});
  assert.equal(Number(await reader.locator('.nc-reading-viewport').getAttribute('data-decoded-pages')), 1, 'Single-page test must not mount a whole chapter');
  return size;
}
async function jump(pageNumber) {
  const control = reader.getByLabel('跳转页码', {exact: true});
  await control.fill(String(pageNumber)); await control.press('Enter');
  const size = await decoded(pageNumber);
  await reader.waitForFunction(async ({entry, number}) => {
    const probe = await import(chrome.runtime.getURL('madara-inspect.js'));
    const position = await probe.position(entry, number);
    return position.matches;
  }, {entry: activeEntry, number: pageNumber});
  return size;
}
async function navigate(section) {
  // A hash-only goto can leave the current reader mounted when the hash is already the destination.
  // Use the actual reader Back button first, then the normal product navigation.
  const back = reader.locator('button[data-reader-back-trigger="true"]');
  if (await back.count()) {
    if (await reader.locator('.nc-reader').evaluate(element => element.classList.contains('controls-hidden'))) await reader.keyboard.press('Escape');
    await back.click();
    await reader.locator('.nc-reader').waitFor({state: 'detached'});
  }
  const navigation = reader.getByRole('navigation', {name: '主导航', exact: true});
  if (await navigation.count()) {
    await navigation.getByRole('button', {name: section === 'library' ? '我的漫画' : '漫画网站', exact: true}).click();
  } else {
    await reader.goto(home + '#' + section);
  }
}
async function importLink(url) {
  // Normal product entry; no catalog, page, reading-position or account records are injected.
  await navigate('sites');
  await reader.getByLabel('通过链接添加漫画', {exact: true}).fill(url);
  await reader.getByRole('button', {name: '添加到书架', exact: true}).click();
  return currentEntry();
}
const stablePositions = state => state.positions.map(({entryId, contentId, pageId}) => ({entryId, contentId, pageId})).sort((a, b) => a.entryId.localeCompare(b.entryId));

try {
  const built = path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3');
  const manifestBytes = await readFile(path.join(built, 'manifest.json'));
  manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.manifest_version, 3, 'Build the MV3 extension before running this test');
  assert(manifest.host_permissions?.includes('https://*/*'), 'The build must retain the normal source host permission');
  await cp(built, extension, {recursive: true});
  const probe = path.join(out, 'inspect-entry.ts');
  // This extra bundle exports read-only inspection only; the copied production app performs all imports/refreshes.
  await writeFile(probe, `import {catalog} from '${source}/comics/repositories/index.ts';
import {definitions} from '${source}/sources/registry/definitions.ts';
import {resolveSource} from '${source}/sources/core/resolve.ts';
export {API_ORIGIN as serviceOrigin} from '${source}/service.ts';
export function identify(url:string) {const {definition,location}=resolveSource(url,definitions);return {adapter:definition.id,name:definition.name,siteIds:definition.sites?.map(site=>site.id),importable:!!definition.capabilities.importable,location};}
export async function snapshot() {
  const comics=await catalog.list('comics',{limit:2}),comic=comics[0];if(!comic)return {comicCount:comics.length};
  const entries=await catalog.listEntries(comic.id,{limit:10000}),stored=await catalog.get('catalogs',comic.source.providerItemId);
  const positions=await catalog.list('positions',{index:'comicId',range:comic.id,limit:3});
  const canonical=JSON.stringify({id:stored?.id,entries:stored?.entries,groups:stored?.groups,defaultEntryId:stored?.defaultEntryId});
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return {comicCount:comics.length,comic:{id:comic.id,title:comic.title,connectionId:comic.source.connectionId,providerItemId:comic.source.providerItemId,sourceUrl:comic.sourceUrl,lastEntryId:comic.lastEntryId,hasDedicatedCover:!!comic.sourceCover,updates:comic.catalogUpdates?.count??0},
    catalog:{id:stored?.id,complete:stored?.complete,groupsComplete:stored?.groups?.every(group=>group.complete),entries:stored?.entries?.length,observedAt:stored?.observedAt,fingerprint:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')},
    entries:entries.map(entry=>({id:entry.id,sourceEntryId:entry.sourceEntryId,contentId:entry.contentId,order:entry.order,sequenceId:entry.sequenceId,discoveryComplete:entry.discoveryComplete,pageCount:entry.pageCount,sourceRemoved:entry.sourceRemoved})),
    positions:positions.map(({entryId,contentId,pageId,relativeOffset})=>({entryId,contentId,pageId,relativeOffset}))};
}
export async function position(entryId:string,number:number) {const entry=await catalog.get('entries',entryId),position=await catalog.get('positions',entryId);if(!entry)return {matches:false};const pages=await catalog.listPages(entry.contentId);return {matches:position?.pageId===pages[number-1]?.pageId,pageId:position?.pageId};}
`);
  const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
  await build({configFile: false, publicDir: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
    outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'madara-inspect.js'},
  }});
  await writeFile(path.join(extension, 'madara-inspect.html'), '<!doctype html><meta charset="utf-8"><title>Read-only source inspection</title>');
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
    executablePath: process.env.TEST_CHROMIUM, locale: 'zh-CN', viewport: {width: 1280, height: 900}, reducedMotion: 'reduce',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  browser.setDefaultTimeout(30000);
  watchdog = setTimeout(() => stop('Live verification exceeded its 240-second budget'), limits.timeoutMs);
  browser.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) pageErrors.push(redact(error.message));}));
  browser.on('request', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    network.requests++; network.origins[url.origin] = (network.origins[url.origin] ?? 0) + 1;
    if (network.requests > limits.requests) stop('Public HTTP request budget exceeded');
  });
  browser.on('response', response => {
    const url = new URL(response.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    const image = /^image\//i.test(response.headers()['content-type'] ?? '');
    if (image && ++network.imageResponses > limits.imageResponses) stop('Image response budget exceeded');
    const length = Number(response.headers()['content-length'] ?? 0);
    if (length > limits.bytes) stop('A response exceeds the public-download byte budget');
    if (response.status() >= 400 && httpFailures.length < 20) httpFailures.push({origin: url.origin, status: response.status(), image});
    if (response.status() === 429) stop('Source returned HTTP 429; no automatic retry is performed');
  });
  browser.on('requestfinished', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    const pending = request.sizes().then(size => {
      network.completedBodyBytes += size.responseBodySize;
      if (network.completedBodyBytes > limits.bytes) stop('Completed HTTP response bytes exceed the public-download budget');
    }).catch(() => {}).finally(() => pendingSizes.delete(pending));
    pendingSizes.add(pending);
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  home = new URL('reader.html', worker.url()).href;
  reader = await browser.newPage(); await reader.goto(new URL('madara-inspect.html', home).href);
  const setup = await reader.evaluate(async ({inputs, version}) => {
    const probe = await import(chrome.runtime.getURL('madara-inspect.js'));
    const auth = (await chrome.storage.local.get('nc-auth'))['nc-auth'];
    if (auth?.session) throw Error('Expected a fresh anonymous test profile');
    const settings = {uiLanguage:'zh-CN',language:'en',layout:'single',fit:'window',cacheLimitMb:128,autoTranslateTabs:false,discoveryTextTranslation:false};
    localStorage.setItem('nc-settings',JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings':settings});
    // Isolated UI preference only: keep first-run release notes from racing the import button.
    localStorage.setItem('nc-release-notes-version',version);
    return {serviceOrigin:probe.serviceOrigin,identities:inputs.map(probe.identify)};
  }, {inputs:[inputUrl, secondUrl].filter(Boolean),version:manifest.version});
  serviceOrigin = setup.serviceOrigin; identity = setup.identities[0];
  for (const current of setup.identities) {
    assert(current.importable && ['catalog', 'reader'].includes(current.location.kind));
    assert(current.adapter === siteId || current.siteIds?.includes(siteId), 'siteId must match the registered source');
    assert.equal(current.adapter, identity.adapter); assert.equal(current.location.catalog?.key, identity.location.catalog?.key, 'Both inputs must belong to the same registered work');
  }
  if (secondUrl) assert.equal(setup.identities[1].location.kind, 'reader', 'The optional second URL must identify a chapter');
  catalogUrl = identity.location.catalog.url;
  assert.notEqual(new URL(catalogUrl).origin, serviceOrigin, 'A product-service URL is not a public source fixture');
  // Only the product account/model service is blocked. Source pages/CDNs are never routed or fulfilled.
  await browser.route(url => url.origin === serviceOrigin, async route => {
    network.blockedServiceRequests++;
    if (/\/v1\/(?:translations|comic-titles\/translate)/.test(new URL(route.request().url()).pathname)) fatal ??= Error('Unexpected model request was blocked');
    await route.abort('blockedbyclient');
  });
  stage = 'initial product import';
  const first = await importLink(inputUrl);
  if (identity.location.kind === 'reader') assert.equal(first.entry.sourceEntryId, identity.location.pageKey);
  const firstPage = Math.min(3, first.entry.pageCount), firstSize = await jump(firstPage);
  selected.push({sourceEntryId: first.entry.sourceEntryId, entryId: first.entry.id, pages: first.entry.pageCount, testedPage: firstPage, decoded: firstSize});
  await reader.screenshot({path: path.join(out, 'reader-first.png')});
  checks.push('Registered product link import, complete owned catalog and actual source-image decoding');
  if (secondUrl) {
    stage = 'second explicit chapter'; await wait(750);
    const second = await importLink(secondUrl); assert.equal(second.entry.sourceEntryId, setup.identities[1].location.pageKey);
    assert.notEqual(second.entry.id, first.entry.id, 'Choose a different second chapter');
    const number = Math.min(2, second.entry.pageCount), size = await jump(number);
    selected.push({sourceEntryId: second.entry.sourceEntryId, entryId: second.entry.id, pages: second.entry.pageCount, testedPage: number, decoded: size});
    checks.push('A second explicit chapter belongs to the same comic and keeps its own saved page');
  }
  stage = 'small-window reading';
  await reader.setViewportSize({width: 430, height: 740});
  await decoded(selected.at(-1).testedPage); await reader.screenshot({path: path.join(out, 'reader-small.png')});
  await reader.setViewportSize({width: 1280, height: 900});
  const saved = await inspect(); assertState(saved);
  stage = 'cover and close/reopen';
  await navigate('library');
  const cover = reader.locator('.nc-book .nc-thumbnail img'); await cover.waitFor();
  const coverSize = await cover.evaluate(async image => {await image.decode(); return {width:image.naturalWidth,height:image.naturalHeight};});
  assert(coverSize.width > 0 && coverSize.height > 0);
  await reader.screenshot({path: path.join(out, 'cover.png')});
  await reader.close(); reader = await browser.newPage(); await reader.goto(home + '#library');
  await reader.getByRole('navigation', {name: '主导航', exact: true}).waitFor();
  await navigate('library');
  await reader.getByRole('button', {name: '打开漫画 ' + saved.comic.title, exact: true}).click();
  const reopened = await currentEntry(); assert.equal(reopened.entry.id, selected.at(-1).entryId);
  assert.equal(await reader.getByLabel('跳转页码', {exact:true}).inputValue(), String(selected.at(-1).testedPage));
  await decoded(selected.at(-1).testedPage);
  assert.deepEqual(stablePositions(reopened.state), stablePositions(saved));
  await reader.screenshot({path: path.join(out, 'reopened.png')});
  checks.push('Dedicated cover decodes; close/reopen retains the selected chapter and saved page');
  stage = 'two idempotent public catalog refreshes';
  for (let round = 0; round < 2; round++) {
    await wait(750);
    const previous = await inspect(), refreshed = await importLink(catalogUrl);
    assert(refreshed.state.catalog.observedAt > previous.catalog.observedAt, 'Reimport must fetch a fresh public catalog observation');
    assert.equal(refreshed.state.catalog.fingerprint, previous.catalog.fingerprint, 'Live catalog changed during the test; idempotence cannot be established');
    assert.deepEqual(refreshed.state.entries, previous.entries, 'Refresh must retain entry and content identities');
    assert.deepEqual(stablePositions(refreshed.state), stablePositions(previous));
    assert.equal(refreshed.state.comic.updates, previous.comic.updates);
    assert.equal(refreshed.entry.id, selected.at(-1).entryId);
    assert.equal(await reader.getByLabel('跳转页码', {exact:true}).inputValue(), String(selected.at(-1).testedPage));
    await decoded(selected.at(-1).testedPage);
  }
  checks.push('Two ordinary catalog-link reimports refresh without duplicate comics/chapters, false updates or lost reading positions');
  await Promise.all([...pendingSizes]);
  assert.equal(fatal, undefined); assert.deepEqual(pageErrors, []);
  assert(network.requests > 0 && network.imageResponses > 0, 'Real public HTML/image HTTP must have been observed');
  const report = {status:'passed',siteId,liveSource:true,liveProvider:false,sourceResponsesUnmodified:true,
    inputs:[inputUrl,secondUrl].filter(Boolean).map(sourceUrl),build:{version:manifest.version,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex')},
    checks,limits,network,httpFailures,selected,cover:coverSize,
    boundary:'Anonymous isolated MV3 with real public HTML/CDN and ordinary product imports. Only the product account/model service is blocked. No source response mocking, cookie import/export, model calls, bulk-download operation or injected catalog/image/position records. Selected pages use single-page layout; small viewport is desktop emulation, not a physical mobile device. Search, inline translation and native permission revocation are separate checks.'};
  await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({out,status:report.status,siteId,liveSource:true,liveProvider:false,checks,network},null,2));
} catch (error) {
  const report = {status:'failed',siteId,stage,liveSource:true,liveProvider:false,sourceResponsesUnmodified:true,
    inputs:[inputUrl,secondUrl].filter(Boolean).map(sourceUrl),checks,limits,network,httpFailures,selected,pageErrors,error:redact(fatal?.message ?? error.message),
    boundary:'Failure is not live-source acceptance. No bypass of authentication/verification or automatic retry; no source responses or user cookies are exported.'};
  await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
  if (reader && !reader.isClosed()) await reader.screenshot({path:path.join(out,'failure.png'),timeout:3000}).catch(()=>{});
  console.error(JSON.stringify({out,status:report.status,stage,error:report.error},null,2)); process.exitCode=1;
} finally {clearTimeout(watchdog); await browser?.close().catch(()=>{});}
