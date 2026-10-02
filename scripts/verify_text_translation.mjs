// Real anonymous Google translation through an installed MV3 extension; original sample text only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), output = path.join(root, 'artifacts/discovery/text-live');
await mkdir(output, {recursive: true});
const out = await mkdtemp(path.join(output, 'run-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const probe = path.join(extension, 'probe.js'), source = path.join(root, 'apps/extension/src/text-translation/index.ts').replaceAll('\\', '/');
await writeFile(probe, `export {createTextTranslationAdapters,TextTranslationSession} from '${source}';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'text-probe.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server']});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(), requests = [];
  await context.route(/https?:\/\//, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'translate.googleapis.com') return route.abort();
    assert.equal(request.method(), 'POST');
    assert(!request.headers().authorization && !request.headers().cookie && !url.searchParams.has('q'));
    requests.push(url.searchParams.get('tl')); return route.continue();
  });
  await page.goto(new URL('reader.html', worker.url()).href);
  const result = await page.evaluate(async () => {
    const {createTextTranslationAdapters, TextTranslationSession} = await import(chrome.runtime.getURL('text-probe.js'));
    const session = new TextTranslationSession(createTextTranslationAdapters()[0]), signal = new AbortController().signal;
    const title = 'Starlight Bookshop', description = 'A quiet bookshop connects two worlds. Its owner helps travelers find their way home.';
    const start = performance.now();
    const [name, synopsis] = await Promise.all([session.translate(title, 'zh-CN', signal), session.translate(description, 'zh-CN', signal)]);
    const elapsedMs = Math.round(performance.now() - start);
    const cachedAt = performance.now(), cached = await session.translate(title, 'zh-CN', signal);
    session.dispose();
    return {valid: name.trim().length > 0 && synopsis.trim().length > 0 && name !== title && synopsis !== description,
      chinese: /[\u3400-\u9fff]/u.test(name) && /[\u3400-\u9fff]/u.test(synopsis),
      titleCharacters: name.length, descriptionCharacters: synopsis.length, elapsedMs, cacheMs: performance.now() - cachedAt, same: name === cached};
  });
  assert(result.valid && result.chinese && result.same);
  assert.deepEqual(requests, ['zh-CN', 'zh-CN']);
  const report = {...result, requests: requests.length, boundary: 'Real keyless Google service through Chromium MV3, original public sample text; no comic-title model or image translation.'};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({out, ...report}));
} finally {await context.close();}
