// Isolated MV3 transport regression, not proof of live Cloudflare clearance.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/source-search-page');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'fixture-')), extension = path.join(out, 'extension');
await mkdir(extension);
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const entry = path.join(out, 'probe.ts');
await writeFile(entry, `export {searchSource,releaseSourceSearchSession} from '${source}/sources/runtime/search';
export {withSearchNetworkContext} from '${source}/sources/runtime/page-network';
export {searchHtml} from '${source}/sources/sites/readcomicsonline/tests/fixtures';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), publicDir: false, logLevel: 'error',
  build: {outDir: extension, emptyOutDir: false, lib: {entry, formats: ['es'], fileName: () => 'probe.js'}}});
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({manifest_version: 3,
  name: 'Source search session fixture', version: '0.0.1', permissions: ['tabs', 'scripting', 'declarativeNetRequest'],
  host_permissions: ['https://*/*', 'http://*/*'], background: {service_worker: 'worker.js'}}));
await writeFile(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(()=>{});');
await writeFile(path.join(extension, 'probe.html'), '<!doctype html><title>Search session fixture</title>');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(10_000);
const origin = 'https://readcomicsonline.ru', requests = [], checks = [];
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
let hold, started, first, second;
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const probe = await context.newPage();
  await probe.goto(new URL('probe.html', worker.url()).href);
  const html = await probe.evaluate(async () => {
    window.probe = await import('./probe.js');
    return [window.probe.searchHtml(61), window.probe.searchHtml(61, 2)];
  });
  await context.route(/https?:\/\//, async route => {
    const request = route.request(), url = new URL(request.url());
    if (![origin, 'https://second-source.test'].includes(url.origin)) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({contentType: 'text/html',
      body: '<!doctype html><title>Verified fixture page</title><body style="height:3000px">Source page</body>'});
    const fromPage = request.frame().url().startsWith(url.origin + '/');
    requests.push({origin: url.origin, fromPage, path: url.pathname});
    if (url.pathname === '/slow') {
      (url.origin === origin ? first : second)?.resolve();
      await hold.promise;
      return route.fulfill({body: 'ok'}).catch(() => {});
    }
    if (url.pathname !== '/advanced-search') return route.abort();
    if (!fromPage) return route.fulfill({status: 403, headers: {'cf-mitigated': 'challenge'}, body: 'verification'});
    if (hold) {started.resolve(); await hold.promise;}
    return route.fulfill({contentType: 'text/html', body: html[url.searchParams.get('page') === '2' ? 1 : 0]}).catch(() => {});
  });
  const search = cursor => probe.evaluate(async cursor => {
    try {
      const result = await window.probe.searchSource('readcomicsonline', {siteId: 'readcomicsonline', query: 'Test', cursor}, {sessionId: 'fixture'});
      return {count: result.items.length, next: result.nextCursor};
    } catch (error) {return {code: error.code, sourceUrl: error.sourceUrl};}
  }, cursor);
  const initialTabs = context.pages().length;
  assert.deepEqual(await search(), {code: 'SOURCE_SEARCH_VERIFICATION_REQUIRED', sourceUrl: origin + '/advanced-search?name=Test'});
  assert.equal(context.pages().length, initialTabs);
  checks.push('No ready source tab: one direct request, explicit challenge, no hidden tab');
  const sourcePage = await context.newPage();
  await sourcePage.goto(origin + '/comic/fixture');
  await sourcePage.evaluate(() => scrollTo(0, 440));
  const initial = await search();
  assert.equal(initial.count, 60); assert(initial.next);
  assert.deepEqual(await search(initial.next), {count: 1, next: undefined});
  assert.equal(requests.filter(r => !r.fromPage).length, 1);
  assert.equal(context.pages().length, initialTabs + 1);
  assert.equal(sourcePage.url(), origin + '/comic/fixture');
  assert.equal(await sourcePage.evaluate(() => scrollY), 440);
  checks.push('Existing verified page: first/next page succeed through MAIN context; no direct retry, navigation or scroll change');

  hold = deferred(); started = deferred();
  await probe.evaluate(() => {window.pending = window.probe.searchSource('readcomicsonline', {siteId: 'readcomicsonline', query: 'Test'}, {sessionId: 'cancel'}).catch(error => ({name: error.name, code: error.code}));});
  await started.promise;
  await probe.evaluate(() => window.probe.releaseSourceSearchSession('cancel'));
  assert.equal((await probe.evaluate(() => window.pending)).name, 'AbortError');
  hold.resolve(); hold = undefined;
  assert.equal((await search()).count, 60);
  checks.push('Cancellation aborts the pinned request, leaves the user tab open and permits a clean retry');

  hold = deferred(); started = deferred();
  const reloaded = search(); await started.promise;
  await sourcePage.reload();
  assert.equal((await reloaded).code, 'SOURCE_SEARCH_HTTP_ERROR');
  hold.resolve(); hold = undefined;
  assert.equal((await search()).count, 60);
  checks.push('Same-URL reload rejects old-document results; the next search binds the new document');

  const otherPage = await context.newPage(); await otherPage.goto('https://second-source.test/');
  hold = deferred(); first = deferred(); second = deferred();
  const parallel = probe.evaluate(async origin => Promise.all([origin, 'https://second-source.test'].map(host =>
    window.probe.withSearchNetworkContext(host + '/slow', AbortSignal.timeout(5000), context => context.request(host + '/slow')))), origin);
  await Promise.race([Promise.all([first.promise, second.promise]), new Promise((_, reject) => setTimeout(() => reject(Error('Independent origins were serialized')), 3000))]);
  hold.resolve(); hold = undefined;
  assert.deepEqual(await parallel, ['ok', 'ok']);
  checks.push('Different source origins start concurrently instead of sharing a slow-source lock');
  const result = {kind: 'isolated-fixture', checks, requests: requests.length};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({out, ...result}, null, 2));
} finally {hold?.resolve(); await context.close();}
