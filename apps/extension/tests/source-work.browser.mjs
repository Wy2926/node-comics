// Run from the repository root after npm --prefix apps/extension run build.
// Isolated MV3 + synthetic source DOM: no live source/model traffic and no mocked Chrome APIs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), extension = path.resolve(process.env.SOURCE_WORK_EXTENSION || 'apps/extension/.output/chrome-mv3');
const base = path.join(root, 'artifacts/source-work'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert(manifest.host_permissions.includes('https://*/*'));
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, locale: 'zh-CN',
  viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', args: ['--disable-extensions-except=' + extension,
    '--load-extension=' + extension, '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
context.setDefaultTimeout(15000);
await context.addInitScript(() => {if (location.protocol === 'chrome-extension:') {
  localStorage.setItem('nc-settings', JSON.stringify({uiLanguage: 'zh-CN', language: 'en', appearance: 'light'}));
  localStorage.setItem('nc-release-notes-version', chrome.runtime.getManifest().version);
}});
const fixtures = new Map(), cases = [], errors = [], requests = [], checks = [];
const title = 'Fixture 作品名 & Original', chapterTitle = 'Chapter 12 — not a work name';
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const link = (url, label) => `<a href="${escape(url)}">${escape(label)}</a>`;
const searchButton = page => page.getByRole('button', {name: /^(寻找其他语言|Find in another language)$/});
function add(id, kind, url, body, expected = title, head = '') {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${chapterTitle}</title><link rel="icon" href="data:,">${head}</head><body>${body}</body></html>`;
  fixtures.set(url, html); cases.push({id, kind, url, expected});
}
for (const host of ['mangaeclipse.com', 'bunmanga.com', 'lhtranslation.net']) {
  const work = `https://${host}/manga/fixture-work/`, chapter = work + 'chapter-12/', name = host + ' · ' + title;
  const body = `<div class="c-breadcrumb"><ol class="breadcrumb"><li>${link(work, name)}</li></ol></div><h1>${chapterTitle}</h1>`;
  add(host, 'catalog', work, body, name, `<link rel="canonical" href="${work}">`);
  add(host, 'reader', chapter, body, name, `<link rel="canonical" href="${host === 'mangaeclipse.com' ? work : chapter}">`);
}
for (const [host, suffix] of [['lagoonscans.com', 'chapter-12'], ['arenascan.com', '12'], ['undertranslations.com', 'capitulo-12']]) {
  const work = `https://${host}/manga/fixture-work/`, chapter = `https://${host}/different-reader-${suffix}/`, name = host + ' · ' + title;
  add(host, 'catalog', work, `<div class="postbody"><h1 class="entry-title">${escape(name)}</h1></div>`, name, `<link rel="canonical" href="${work}">`);
  add(host, 'reader', chapter, `<div class="chapterbody"><h1>${chapterTitle}</h1><div class="allc">${link(work, name)}</div></div>`, name, `<link rel="canonical" href="${chapter}">`);
}
const welomaWork = 'https://weloma.net/m/Work1', welomaReader = 'https://weloma.net/c/Chap1';
const welomaName = 'WeLoMa · ' + title, encoded = Buffer.from(welomaName).toString('base64');
add('weloma.net', 'catalog', welomaWork, `<div id="login"></div><script type="application/json">window.location.href='${welomaWork}';</script><div class="manga-info"><h3 data-enc="${encoded}"></h3></div>`, welomaName);
add('weloma.net', 'reader', welomaReader, `<ol class="breadcrumb"><li>${link(welomaWork, welomaName)}</li><li>${link(welomaReader, chapterTitle)}</li></ol>`, welomaName);
const atsuWork = 'https://atsu.moe/manga/Work1', atsuReader = 'https://atsu.moe/read/Work1/Chap1';
add('atsu.moe', 'catalog', atsuWork, `<h1>${escape(title)}</h1><h1>${escape(title)}</h1>${link(atsuReader, 'Start readingStart')}`,
  title, `<meta property="og:url" content="https://atsu.moe/"><meta property="og:title" content="${escape(title)}">`);
add('atsu.moe', 'reader', atsuReader, `${link(atsuWork, '')}${link(atsuWork, title)}<a type="button" href="${atsuWork}"><div><div><span class="text-sm">Manhua Info</span><span class="text-xs text-ellipsis overflow-hidden">${escape(title)}</span></div></div></a><h1>${chapterTitle}</h1>`, title,
  `<meta property="og:title" content="${chapterTitle}">`);
add('atsu.moe', 'missing-name', 'https://atsu.moe/read/Work2/Chap2', `<h1>${chapterTitle}</h1>`, '');
add('bunmanga.com', 'wrong-owner', 'https://bunmanga.com/manga/fixture-other/chapter-12/',
  `<div class="c-breadcrumb"><ol class="breadcrumb"><li>${link('https://bunmanga.com/manga/fixture-work/', title)}</li></ol></div>`, '',
  '<link rel="canonical" href="https://bunmanga.com/manga/fixture-other/chapter-12/">');
const hosts = [...new Set(cases.map(item => new URL(item.url).hostname))];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route(/^https?:/, route => {
  const request = route.request(), url = request.url();
  if (request.isNavigationRequest() && request.resourceType() === 'document' && fixtures.has(url))
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: fixtures.get(url)});
  requests.push(url); return route.fulfill({status: 503, contentType: 'application/json', body: '{}'});
});
let source, latest;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Route interception does not cover all extension service-worker fetches; block those at the fixture transport too.
  await worker.evaluate(async () => {
    globalThis.__sourceWorkRequests = []; const original = fetch;
    globalThis.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (!/^https?:/.test(url)) return original(input, options);
      globalThis.__sourceWorkRequests.push(url);
      return Promise.resolve(new Response('{}', {status: 503, headers: {'Content-Type': 'application/json'}}));
    };
    await chrome.storage.local.set({'nc-reader-settings': {uiLanguage: 'zh-CN', language: 'en', appearance: 'light'}});
  });
  const registration = Date.now() + 15000;
  while (!(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === 'nc-source-entry-weloma')))) {
    assert(Date.now() < registration, 'Source content scripts were not registered'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  source = await context.newPage();
  async function verify(trigger, item, label) {
    const opened = context.waitForEvent('page'); await trigger(); latest = await opened;
    await latest.waitForURL(/^chrome-extension:.*\/reader\.html/);
    const input = latest.locator('dialog.nc-comic-search[open] .nc-search-name input'); await input.waitFor();
    assert.equal(await input.inputValue(), item.expected, label);
    assert.equal(source.url(), item.url, 'Search leaves the source tab unchanged');
    assert(!latest.url().includes(encodeURIComponent(item.expected || title)), 'Work names do not enter the URL');
    assert(!latest.url().includes(item.url) && !latest.url().includes(encodeURIComponent(item.url)), 'Source URLs do not enter the address bar');
    if (!item.expected) {await input.fill('手动作品名'); assert.equal(await input.inputValue(), '手动作品名');}
    await latest.screenshot({path: path.join(out, label + '.png')});
    await latest.close(); latest = undefined; checks.push(label); console.log('PASS ' + label);
  }
  for (const item of cases) {
    await source.goto(item.url); await searchButton(source).waitFor();
    await verify(() => searchButton(source).click(), item, item.id + '-' + item.kind);
  }
  const item = cases.find(item => item.id === 'lagoonscans.com' && item.kind === 'reader'); await source.goto(item.url);
  const opened = context.waitForEvent('page');
  await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({url}); await chrome.tabs.update(tab.id, {active: true});
    await chrome.tabs.create({url: chrome.runtime.getURL('/popup.html'), windowId: tab.windowId, active: false});
  }, item.url);
  const popup = await opened; await searchButton(popup).waitFor();
  await verify(() => searchButton(popup).click(), item, 'lagoonscans-popup');
  if (!popup.isClosed()) await popup.close();
  requests.push(...await worker.evaluate(() => globalThis.__sourceWorkRequests));
  const forbidden = requests.filter(value => hosts.includes(new URL(value).hostname) || new URL(value).pathname === '/v1/comic-titles/translate');
  assert.deepEqual(forbidden, [], 'Opening or typing must not fetch catalogs, chapters, searches or translated names');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({checks, forbidden, boundary: 'Synthetic DOM with production MV3/content scripts, popup and search seed; no live source or model verification.'}, null, 2));
  console.log('Artifacts: ' + out);
} catch (error) {
  await (latest || source)?.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({checks, errors, requests, message: error.message}, null, 2));
  console.error('Artifacts: ' + out); throw error;
} finally {await context.close();}
