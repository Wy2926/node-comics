// Real public-source search through the built MV3 product UI; one explicit site per isolated run.
// No source routes/mocks, direct adapter calls, candidate imports, user profile or UA override.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

const usage = 'Usage: node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs <siteId> <query-with-2-or-more-pages> <no-result-query> [--max-pages=3] [--html-search] [--page-size=10] [--query-param=s] [--page-param=pg]';
const args = process.argv.slice(2);
if (args.includes('--help')) {console.log(usage); process.exit(0);}
const positional = args.filter(value => !value.startsWith('--')), flags = args.filter(value => value.startsWith('--'));
const [siteId, query, emptyQuery] = positional;
assert(positional.length === 3 && /^[a-z0-9-]+$/.test(siteId), usage);
assert(flags.length <= 5 && flags.every(value => /^(?:--max-pages=\d+|--html-search|--page-size=\d+|--(?:query|page)-param=[a-z][a-z0-9_]{0,30})$/.test(value)) &&
  new Set(flags.map(value => value.split('=')[0])).size === flags.length, usage);
const htmlSearch = flags.includes('--html-search');
const queryParam = flags.find(value => value.startsWith('--query-param='))?.split('=')[1] ?? 's';
const pageParam = flags.find(value => value.startsWith('--page-param='))?.split('=')[1];
assert(htmlSearch || queryParam === 's' && !pageParam, 'Query parameter overrides require HTML search');
assert(queryParam !== pageParam, 'Query and page parameters must differ');
const maxPages = Number(flags.find(value => value.startsWith('--max-pages='))?.split('=')[1] ?? 3);
const pageItems = Number(flags.find(value => value.startsWith('--page-size='))?.split('=')[1] ?? 12);
assert(Number.isInteger(pageItems) && pageItems >= 1 && pageItems <= 100, '--page-size must be 1..100; default Madara AJAX uses 12 items');
assert(Number.isInteger(maxPages) && maxPages >= 2 && maxPages <= 10, '--max-pages must be 2..10; use a bounded, verified query');
for (const value of [query, emptyQuery]) assert(typeof value === 'string' && value.trim() === value && value.length > 0 &&
  [...value].length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value), 'Queries must contain 1..256 printable characters');
assert.notEqual(query, emptyQuery, 'The positive and empty queries must differ');

const root = process.cwd(), base = path.join(root, 'artifacts/madara-search-browser', siteId);
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const sourceUrl = value => {try {const url = new URL(value); return url.origin + url.pathname;} catch {return '(unavailable)';}};
const redact = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, sourceUrl).slice(0, 1500);
const sensitiveField = /(?:^|\[|_)(?:nonce|token|password|cookie|authorization|session|secret|api_key)(?:\]|$|_)/i;
function safeValue(key, value, depth = 0) {
  if (sensitiveField.test(key)) return '[redacted]';
  if (depth > 5) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeValue(key, item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, item]) => [name, safeValue(name, item, depth + 1)]));
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try {return safeValue(key, JSON.parse(value), depth + 1);} catch { /* Ordinary form text, not JSON. */ }
  }
  return typeof value === 'string' ? value.slice(0, 2000) : value;
}
const safeParams = value => Object.fromEntries([...new URLSearchParams(value)].map(([key, item]) => [key, safeValue(key, item)]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const limits = {maxPages, pageItems, requests: 90, textResponses: (maxPages + 1) * 2, imageResponses: 18, bytes: 32 * 1024 * 1024, timeoutMs: 180000};
const network = {requests: 0, textResponses: 0, imageResponses: 0, completedBodyBytes: 0, blockedServiceRequests: 0, origins: {}};
const startedAt = Date.now();
const checks = [], pages = [], durations = [], errors = [], httpFailures = [], requestFailures = [], textRequests = [], textTargets = [], rawRequests = [], pendingSizes = new Set();
let context, reader, panel, watchdog, fatal, stage = 'prepare', serviceOrigin, target, origin, knownSourceOrigins = [], searchableSiteCount = 0, manifest, manifestBytes, home;
const stop = message => {if (!fatal) {fatal = Error(message); void context?.close().catch(() => {});}};
const inspect = () => reader.evaluate(async () => (await import(chrome.runtime.getURL('madara-search-inspect.js'))).counts());
function assertNoLibraryWrites(counts) {
  assert.deepEqual(counts, {comics: 0, catalogs: 0, entries: 0}, 'Search must not import or prefetch a candidate catalog');
}
async function selectedSite() {
  assert.equal(await panel.locator('.nc-search-site-option').count(), searchableSiteCount, 'All registered searchable sites must remain rendered before any search');
  const selected = await panel.locator('.nc-search-site-option').evaluateAll(options => options.filter(option => option.querySelector('input').checked).map(option => option.querySelector('b').textContent));
  assert.deepEqual(selected, [target.name], 'Only the explicitly requested site may be searched');
  assert.equal(await panel.locator('.nc-search-scope-heading > [role="status"]').innerText(), '已选 1 个网站');
}
async function settled() {
  await reader.waitForFunction(() => {
    const states = [...document.querySelectorAll('.nc-search-page .nc-search-status')];
    return states.length === 1 && states.every(state => !state.matches('.is-running,.is-queued'));
  }, undefined, {timeout: 30000});
  const status = panel.locator('.nc-search-status');
  assert.equal(await status.locator('b').innerText(), target.name);
  if (await status.getAttribute('aria-pressed') !== 'true') await status.click();
  const detail = panel.locator('.nc-search-status-detail');
  const state = await status.getAttribute('class');
  if (!/\bis-(?:ready|empty)\b/.test(state)) throw Error(`Search did not succeed: ${redact(await detail.innerText())}`);
  return detail;
}
async function operation(label, action, pageIndex = 0, searchQuery = query) {
  stage = label;
  const started = Date.now();
  console.log(`${siteId}: ${label}`);
  await selectedSite();
  const start = textRequests.length;
  await Promise.all([
    context.waitForEvent('response', {timeout: 30000, predicate: response => {
      const url = new URL(response.url());
      return url.origin === origin && /^text\/|^application\/(?:json|xml|xhtml\+xml)/i.test(response.headers()['content-type'] ?? '');
    }}),
    action(),
  ]);
  const detail = await settled(), requests = textRequests.slice(start);
  assert.equal(requests.length, 1, 'Each search page must make exactly one public text request');
  if (htmlSearch) {
    assert.equal(requests[0].method, 'GET', 'HTML search must use a single read-only GET');
    assert.equal(requests[0].bodyBytes, 0, 'HTML search must not submit a request body');
    assert.equal(requests[0].form, undefined);
    const expected = new URL(origin + (pageIndex === 0 || pageParam ? '/' : `/page/${pageIndex + 1}/`));
    expected.searchParams.set(queryParam, searchQuery);
    if (pageIndex > 0 && pageParam) expected.searchParams.set(pageParam, String(pageIndex + 1));
    assert.equal(textTargets[start], expected.href, 'HTML search must preserve the exact same-origin path, page and name query');
  } else {
    assert.equal(requests[0].method, 'POST', 'Verified AJAX pagination must not add a preliminary GET');
    assert.match(requests[0].contentType, /^application\/x-www-form-urlencoded(?:;|$)/i);
    assert.deepEqual(requests[0].form, {
      action: 'madara_load_more', page: String(pageIndex), template: 'madara-core/content/content-search',
      'vars[paged]': '1', 'vars[template]': 'search', 'vars[posts_per_page]': '12',
      'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': searchQuery,
    }, 'The actual request must use the verified nine-field form, correct query and zero-based page');
  }
  assertNoLibraryWrites(await inspect());
  durations.push({stage: label, elapsedMs: Date.now() - started});
  return {detail, requests};
}
async function candidates() {
  const rows = await panel.locator('.nc-search-result').evaluateAll(cards => cards.map(card => ({
    title: card.querySelector('h3')?.textContent,
    url: card.querySelector('.nc-search-result-bottom a')?.href,
    source: card.querySelector('.nc-search-result-source')?.getAttribute('title'),
  })));
  assert(rows.every(row => row.title?.trim() && row.url && row.source === target.name));
  assert.equal(new Set(rows.map(row => row.url)).size, rows.length, 'Pagination must not duplicate candidates');
  const owners = await reader.evaluate(async urls => (await import(chrome.runtime.getURL('madara-search-inspect.js'))).owners(urls), rows.map(row => row.url));
  assert(owners.every(owner => owner.adapter === target.adapterId && owner.kind === 'catalog'), 'Every result must remain in this site namespace');
  return rows.map((row, index) => ({title: row.title, url: sourceUrl(row.url), catalogId: owners[index].catalogId}));
}
async function recordPage(number, previous, requests) {
  const items = await candidates(), hasMore = await panel.getByRole('button', {name: '加载更多', exact: true}).count() === 1;
  assert.deepEqual(items.slice(0, previous.length), previous, 'Load more must retain the existing result order and identity');
  const added = items.slice(previous.length);
  assert(added.length <= limits.pageItems, 'One source page must respect the configured candidate limit');
  if (hasMore) {
    if (htmlSearch) assert(added.length > 0, 'HTML continuation must advance by a nonempty result page');
    else assert.equal(added.length, limits.pageItems, 'Only a full page may offer a continuation');
  }
  pages.push({page: number, count: added.length, cumulativeCount: items.length, hasMore,
    first: added[0] ?? null, last: added.at(-1) ?? null, candidates: added, requests});
  return {items, hasMore};
}

try {
  const built = path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3');
  manifestBytes = await readFile(path.join(built, 'manifest.json')); manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.manifest_version, 3, 'Build the current MV3 extension before running this test');
  assert(manifest.host_permissions?.includes('https://*/*'));
  await cp(built, extension, {recursive: true});
  const probe = path.join(out, 'inspect-entry.ts');
  // Read-only metadata and repository inspection. The copied production UI submits every search.
  await writeFile(probe, `import {catalog} from '${source}/comics/repositories/index.ts';
import {definitions} from '${source}/sources/registry/definitions.ts';
import {resolveSource} from '${source}/sources/core/resolve.ts';
export {API_ORIGIN as serviceOrigin} from '${source}/service.ts';
export function sites(){return definitions.flatMap(definition=>(definition.sites??[]).filter(site=>site.search).map(site=>({id:site.id,key:definition.id+':'+site.id,adapterId:definition.id,name:site.name,url:site.url})));}
export async function counts(){return {comics:(await catalog.list('comics',{limit:1})).length,catalogs:(await catalog.list('catalogs',{limit:1})).length,entries:(await catalog.list('entries',{limit:1})).length};}
export function owners(urls:string[]){return urls.map(url=>{const {definition,location}=resolveSource(url,definitions);return {adapter:definition.id,kind:location.kind,catalogId:location.catalog?.key};});}
export function sourcePages(urls:string[]){return urls.flatMap(url=>{try{const {definition,location}=resolveSource(url,definitions);return definition.id!=='generic'&&['catalog','reader'].includes(location.kind)?[{adapter:definition.id,kind:location.kind,url:location.url}]:[];}catch{return [];}});}
`);
  const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
  await build({configFile: false, publicDir: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
    outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'madara-search-inspect.js'},
  }});
  await writeFile(path.join(extension, 'madara-search-inspect.html'), '<!doctype html><meta charset="utf-8"><title>Read-only search inspection</title>');
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
    executablePath: process.env.TEST_CHROMIUM, locale: 'zh-CN', viewport: {width: 1280, height: 900}, reducedMotion: 'reduce',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  context.setDefaultTimeout(30000);
  watchdog = setTimeout(() => stop('Search verification exceeded its 180-second budget'), limits.timeoutMs);
  context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(redact(error.message));}));
  context.on('request', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    rawRequests.push(request.url()); network.requests++; network.origins[url.origin] = (network.origins[url.origin] ?? 0) + 1;
    if (network.requests > limits.requests) stop('Public HTTP request budget exceeded');
    if (origin && url.origin !== origin && knownSourceOrigins.includes(url.origin)) stop('A site outside the selected search scope was requested');
  });
  context.on('response', response => {
    const url = new URL(response.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    const request = response.request(), mime = response.headers()['content-type'] ?? '', image = /^image\//i.test(mime);
    if (image && ++network.imageResponses > limits.imageResponses) stop('Search-cover response budget exceeded');
    if (Number(response.headers()['content-length'] ?? 0) > limits.bytes) stop('A response exceeds the public-download byte budget');
    if (response.status() >= 400 && httpFailures.length < 20) httpFailures.push({url: sourceUrl(url.href), status: response.status(), image});
    if (response.status() === 429) stop('Source returned HTTP 429; no automatic retry is performed');
    if (/^text\/|^application\/(?:json|xml|xhtml\+xml)/i.test(mime)) {
      if (++network.textResponses > limits.textResponses) stop('Public search-text response budget exceeded');
      if (url.origin !== origin) stop('Unexpected non-source text response during a single-site search');
      const headers = request.headers(), body = request.postData() ?? '', contentType = headers['content-type'] ?? '';
      textTargets.push(request.url()); // Exact URL comparison stays in memory; reports retain only sanitized fields.
      textRequests.push({stage, method: request.method(), url: sourceUrl(url.href), query: safeParams(url.search),
        status: response.status(), contentType, referer: headers.referer ? sourceUrl(headers.referer) : null,
        bodyBytes: Buffer.byteLength(body), ...(contentType.startsWith('application/x-www-form-urlencoded') ? {form: safeParams(body)} : {})});
    }
  });
  context.on('requestfailed', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    if (requestFailures.length < 20) requestFailures.push({url: sourceUrl(url.href), error: redact(request.failure()?.errorText)});
  });
  context.on('requestfinished', request => {
    const url = new URL(request.url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === serviceOrigin) return;
    const pending = request.sizes().then(size => {
      network.completedBodyBytes += size.responseBodySize;
      if (network.completedBodyBytes > limits.bytes) stop('Completed HTTP body bytes exceed the public-download budget');
    }).catch(() => {}).finally(() => pendingSizes.delete(pending));
    pendingSizes.add(pending);
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  home = new URL('reader.html', worker.url()).href;
  reader = await context.newPage(); await reader.goto(new URL('madara-search-inspect.html', home).href);
  const setup = await reader.evaluate(async version => {
    const probe = await import(chrome.runtime.getURL('madara-search-inspect.js'));
    const auth = (await chrome.storage.local.get('nc-auth'))['nc-auth'];
    if (auth?.session) throw Error('Expected a fresh anonymous profile');
    const settings = {uiLanguage:'zh-CN',language:'en',layout:'single',fit:'window',autoTranslateTabs:false,discoveryTextTranslation:false};
    localStorage.setItem('nc-settings',JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings':settings});
    localStorage.setItem('nc-release-notes-version',version);
    return {serviceOrigin:probe.serviceOrigin,sites:probe.sites()};
  }, manifest.version);
  serviceOrigin = setup.serviceOrigin;
  const matches = setup.sites.filter(site => site.id === siteId); assert.equal(matches.length, 1, 'siteId must identify exactly one registered searchable site');
  target = matches[0]; origin = new URL(target.url).origin; knownSourceOrigins = setup.sites.map(site => new URL(site.url).origin);
  searchableSiteCount = setup.sites.length;
  assert.notEqual(origin, serviceOrigin);
  // Block only the product account/model service; source and CDN responses are never routed or fulfilled.
  await context.route(url => url.origin === serviceOrigin, async route => {
    network.blockedServiceRequests++;
    if (/\/v1\/(?:translations|comic-titles\/translate)/.test(new URL(route.request().url()).pathname)) stop('Unexpected model request was blocked');
    await route.abort('blockedbyclient');
  });
  stage = 'select one site in the product UI';
  await reader.goto(home + '#search'); panel = reader.locator('.nc-search-page'); await panel.waitFor();
  await panel.getByRole('button', {name: '直接搜索', exact: true}).click();
  const expand = panel.locator('.nc-search-scope-expand');
  if (await expand.count() && await expand.getAttribute('aria-expanded') === 'false') await expand.click();
  // Collapsed sites are unmounted but remain selected; expose the full scope before changing it.
  await reader.waitForFunction(count => document.querySelectorAll('.nc-search-page .nc-search-site-option').length === count, searchableSiteCount);
  // Use the real bulk controls; toggling every site individually wastes the bounded live-test time.
  const all = panel.getByRole('button', {name: '全选', exact: true});
  if (await all.isEnabled()) await all.click();
  await panel.getByRole('button', {name: '反选', exact: true}).click();
  await panel.getByText(target.name, {exact: true}).locator('..').getByRole('checkbox').check();
  await selectedSite(); assert.equal(network.requests, 0, 'Opening and configuring search must not query any source');
  assertNoLibraryWrites(await inspect());
  const input = panel.getByLabel('搜索名称', {exact: true}); await input.fill(query);
  const first = await operation('positive page 1', () => panel.getByRole('button', {name: '搜索网站', exact: true}).click());
  let result = await recordPage(1, [], first.requests);
  assert(result.items.length > 0, 'The positive query returned no candidates');
  const firstCard = panel.locator('.nc-search-result').first(); await firstCard.scrollIntoViewIfNeeded();
  const cover = firstCard.locator('.nc-search-result-cover img'); await cover.waitFor();
  const coverSize = await cover.evaluate(async image => {await image.decode(); return {width:image.naturalWidth,height:image.naturalHeight};});
  assert(coverSize.width > 0 && coverSize.height > 0, 'A real search cover must decode');
  await reader.screenshot({path: path.join(out, 'search-first.png')});
  for (let number = 2; result.hasMore && number <= maxPages; number++) {
    await wait(1000);
    const next = await operation(`positive page ${number}`, () => panel.getByRole('button', {name: '加载更多', exact: true}).click(), number - 1);
    result = await recordPage(number, result.items, next.requests);
  }
  assert(!result.hasMore, `The query still has more results after ${maxPages} pages; choose a narrower query rather than scanning the site`);
  await panel.locator('.nc-search-status-detail').scrollIntoViewIfNeeded();
  await reader.screenshot({path: path.join(out, 'search-last.png')});
  checks.push(`Only the selected site is queried; ${pages.length > 1 ? 'real UI Load more appends unique owned candidates through the terminal page' : 'the single result page is terminal without a Load more button'} with one ${htmlSearch ? 'query-bound GET' : 'form POST'} per page`);
  await wait(1000); await input.fill(emptyQuery);
  const empty = await operation('no-result query', () => panel.getByRole('button', {name: '重新搜索', exact: true}).click(), 0, emptyQuery);
  assert.equal(await panel.locator('.nc-search-result').count(), 0);
  assert.equal(await panel.locator('.nc-search-status.is-empty').count(), 1);
  assert.equal(await empty.detail.getByRole('button', {name: '加载更多', exact: true}).count(), 0);
  await empty.detail.scrollIntoViewIfNeeded(); await reader.screenshot({path: path.join(out, 'search-empty.png')});
  checks.push('A separate real no-result query clears prior candidates and offers no continuation, without writing comics, catalogs or entries');
  const sourcePages = await reader.evaluate(async urls => (await import(chrome.runtime.getURL('madara-search-inspect.js'))).sourcePages(urls), rawRequests);
  assert.equal(sourcePages.length, 0, 'Searching and cover display must not fetch candidate catalogs or chapters');
  assertNoLibraryWrites(await inspect()); await Promise.all([...pendingSizes]);
  assert.equal(fatal, undefined); assert.deepEqual(errors, []); assert.deepEqual(httpFailures, []);
  const report = {status:'passed',siteId,siteName:target.name,query,emptyQuery,liveSource:true,liveProvider:false,sourceResponsesUnmodified:true,
    build:{version:manifest.version,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex')},
    checks,limits,network,pages,durations,elapsedMs:Date.now()-startedAt,firstPageCount:pages[0].count,lastPageCount:pages.at(-1).count,totalCandidates:result.items.length,
    empty:{count:0,requests:empty.requests},cover:coverSize,httpFailures,requestFailures,errors,
    boundary:'Anonymous isolated headless MV3, ordinary direct-search UI, one explicitly selected site, bounded manual Load more and a separate no-result query. No source response interception, user-profile/cookie import or export, UA changes, direct adapter calls, title/model calls, candidate detail reads or library injection. Only the product account/model service is blocked. Form credentials/nonces are redacted; no raw HTML or request cookies are recorded.'};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({out,status:report.status,siteId,siteName:target.name,query,emptyQuery,liveSource:true,liveProvider:false,
    firstPageCount:report.firstPageCount,lastPageCount:report.lastPageCount,totalCandidates:report.totalCandidates,pages:pages.length,network,checks}, null, 2));
} catch (error) {
  const report = {status:'failed',siteId,siteName:target?.name,query,emptyQuery,stage,liveSource:true,liveProvider:false,sourceResponsesUnmodified:true,
    checks,limits,network,pages,durations,elapsedMs:Date.now()-startedAt,textRequests,httpFailures,requestFailures,errors,error:redact(fatal?.message ?? error.message),
    boundary:'Failure is not source-search acceptance. No retry or authentication/verification bypass; only the named site and explicit queries are in scope. No cookies or raw source HTML are exported.'};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (reader && !reader.isClosed()) await reader.screenshot({path:path.join(out,'failure.png'),timeout:3000}).catch(() => {});
  console.error(JSON.stringify({out,status:report.status,stage,error:report.error}, null, 2)); process.exitCode = 1;
} finally {clearTimeout(watchdog); await context?.close().catch(() => {});}
