/** Isolated Chrome acceptance with original generated pages and mocked image downloads.
 * Start Vite on 5176; PLAYWRIGHT_MODULE / TEST_CHROMIUM select installed runtimes.
 */
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {selectOption} from './select_helpers.mjs';
import {createHash} from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {ZipReader, BlobReader, BlobWriter, TextWriter} = await import(pathToFileURL(path.join(root, 'apps/extension/node_modules/@zip.js/zip.js/index-native.js')).href);
const {PDFDocument} = createRequire(path.join(root, 'apps/extension/package.json'))('pdf-lib');
const output = path.join(root, 'artifacts/export-validation'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({headless: true, ...(process.env.TEST_CHROMIUM ? {executablePath: process.env.TEST_CHROMIUM} : {channel: 'chrome'})});
const checks = [], errors = [], requests = [];
async function unzip(blob) {
  const reader = new ZipReader(new BlobReader(blob), {useWebWorkers: false, checkSignature: true});
  const result = new Map();
  try { for (const entry of await reader.getEntries()) if (!entry.directory) result.set(entry.filename, await entry.getData(new BlobWriter())); }
  finally { await reader.close(); }
  return result;
}
const digest = async blob => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, acceptDownloads: true});
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  let remote = 'fail', remoteBody;
  await page.route('http://127.0.0.1:18098/**', async route => {
    requests.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    if (remote === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
    if (remote === 'success') {
      const access = route.request().url().endsWith('/access');
      await route.fulfill({status: 200, contentType: access ? 'application/json' : 'image/png', body: access ? JSON.stringify({url: 'http://127.0.0.1:18098/fixture-result.png', expires_at: new Date(Date.now() + 60000).toISOString(), authorization_required: true}) : remoteBody});
      return;
    }
    await route.fulfill({status: 410, contentType: 'application/json', body: JSON.stringify({error: {code: 'ASSET_EXPIRED', message: '验收译图已过期'}})}).catch(() => {});
  });
  await page.goto('http://127.0.0.1:5176/tests/export-fixture.html');
  await page.getByRole('button', {name: '打开作品 导出验收 · 星光书店', exact: true}).click();
  const capture = await page.getByRole('button', {name: '采集中心', exact: true}).boundingBox();
  const button = page.getByRole('button', {name: '导出漫画', exact: true}), position = await button.boundingBox();
  assert(position.x >= capture.x + capture.width); assert(Math.abs(position.y - capture.y) < 2);
  await page.screenshot({path: path.join(output, 'detail-desktop.png'), fullPage: true});
  const initial = await page.evaluate(async () => { const {readCopies} = await import('/src/library/store.ts'); return (await readCopies()).map(c => ({id: c.id, pageId: c.pageId, relativeOffset: c.relativeOffset, pages: c.pages.map(p => p.id)})); });
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', {name: '清空选择', exact: true}).click();
  await dialog.locator('.nc-export-copy').filter({hasText: '第 01 话'}).getByRole('checkbox').check();
  const originalHashes = await page.evaluate(async () => {
    const {getBlob} = await import('/src/library/store.ts');
    return Promise.all([0, 1, 2, 3].map(async n => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await (await getBlob('export-fixture-' + n)).arrayBuffer()))).map(v => v.toString(16).padStart(2, '0')).join('')));
  });
  remoteBody = Buffer.from(await page.evaluate(async () => {const {getBlob} = await import('/src/library/store.ts'); return Array.from(new Uint8Array(await (await getBlob('export-fixture-3')).arrayBuffer()));}));
  async function inspect() { await dialog.getByRole('button', {name: /^(检查导出清单|重新检查清单)$/}).click(); await dialog.getByRole('button', {name: '开始导出', exact: true}).waitFor(); }
  async function generate(name) {
    await dialog.getByRole('button', {name: '开始导出', exact: true}).click();
    await dialog.getByRole('link', {name: '下载文件', exact: true}).waitFor({timeout: 30000});
    const download = page.waitForEvent('download'); await dialog.getByRole('link', {name: '下载文件', exact: true}).click();
    const file = await download; await file.saveAs(path.join(output, name));
    return new Blob([await readFile(path.join(output, name))]);
  }
  await page.screenshot({path: path.join(output, 'export-selection.png'), fullPage: true});
  await inspect();
  assert.equal(await dialog.locator('.nc-export-book').count(), 2);
  await dialog.locator('.nc-export-book').nth(1).locator('summary').click();
  assert.match(await dialog.getByRole('region', {name: '导出清单'}).innerText(), /1 页补原图/);
  await page.screenshot({path: path.join(output, 'export-desktop.png'), fullPage: true});
  const bundle = await unzip(await generate('original-and-translation.zip'));
  const cbzNames = [...bundle.keys()].filter(name => name.endsWith('.cbz')); assert.equal(cbzNames.length, 2);
  for (const name of cbzNames) {
    const book = await unzip(bundle.get(name)), images = [...book.keys()].filter(n => /\.(png|webp)$/.test(n));
    assert.deepEqual(images, ['00001.png', '00002.png', '00003.webp']);
    const translated = !name.startsWith('原图/');
    for (let i = 0; i < images.length; i++) assert.equal(await digest(book.get(images[i])), originalHashes[translated && i === 0 ? 3 : i]);
    const manifest = JSON.parse(await book.get('导出说明.json').text());
    assert.equal(manifest.books[0].complete, true);
    assert.deepEqual(manifest.books[0].pages.map(p => p.kind), translated ? ['translation', 'no_text', 'fallback'] : ['original', 'original', 'original']);
  }
  checks.push({cbz: true, separateEditions: true, originalBytesPreserved: true, fallbackAndNoText: true, orderedPages: 3});
  await dialog.getByRole('button', {name: '返回选择', exact: true}).click();
  await selectOption(dialog.getByLabel('导出格式', {exact: true}),'zip'); await inspect();
  const imagesZip = await unzip(await generate('images.zip'));
  assert.equal([...imagesZip.keys()].filter(n => /\.(png|webp)$/.test(n)).length, 6);
  assert(![...imagesZip.keys()].some(n => n.endsWith('.cbz'))); checks.push({imageZip: true});
  await dialog.getByRole('button', {name: '返回选择', exact: true}).click();
  await selectOption(dialog.getByLabel('导出格式', {exact: true}),'pdf');
  await selectOption(dialog.getByLabel('导出图片', {exact: true}),'translation'); await inspect();
  const pdfBlob = await generate('translated.pdf');
  const pdf = await PDFDocument.load(await pdfBlob.arrayBuffer()); assert.equal(pdf.getPageCount(), 3); assert.deepEqual(pdf.getPage(0).getSize(), {width: 270, height: 405});
  const rendered = await page.evaluate(async base64 => {
    const pdfjs = await import('/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const task = pdfjs.getDocument({data, isEvalSupported: false});
    const doc = await task.promise;
    const colors = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n), viewport = p.getViewport({scale: 1});
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
      await p.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
      colors.push(Array.from(canvas.getContext('2d').getImageData(20, 250, 1, 1).data));
      if (n === 1) { canvas.id = 'pdf-proof'; document.querySelector('.nc-export-preview').append(canvas); }
      p.cleanup();
    }
    const attachments = await doc.getAttachments(); await task.destroy();
    return {colors, attachments: [...attachments.keys()]};
  }, Buffer.from(await pdfBlob.arrayBuffer()).toString('base64'));
  assert.deepEqual(rendered.attachments, ['export-manifest.json']);
  for (const [i, color] of [[240, 194, 68], [64, 181, 139], [66, 124, 221]].entries()) for (let n = 0; n < 3; n++) assert(Math.abs(rendered.colors[i][n] - color[n]) <= 4);
  await page.locator('#pdf-proof').screenshot({path: path.join(output, 'pdf-rendered.png')}); await page.locator('#pdf-proof').evaluate(node => node.remove());
  checks.push({pdf: true, decodedByPdfJs: true, pages: 3, pageColors: rendered.colors, manifestAttached: true});
  await page.setViewportSize({width: 390, height: 844});
  await dialog.getByRole('button', {name: '重新检查清单', exact: true}).click();
  await dialog.locator('.nc-export-book').waitFor();
  const overflow = await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1); assert.equal(overflow, false);
  await dialog.evaluate(node => { node.scrollTop = 0; }); await page.screenshot({path: path.join(output, 'export-mobile.png'), fullPage: true});
  await page.setViewportSize({width: 1440, height: 1100});
  await dialog.getByRole('button', {name: '返回选择', exact: true}).click();
  await dialog.getByRole('button', {name: '清空选择', exact: true}).click();
  await dialog.locator('.nc-export-copy').filter({hasText: '第 02 话'}).getByRole('checkbox').check();
  await selectOption(dialog.getByLabel('导出格式', {exact: true}),'zip'); await inspect();
  assert(await dialog.getByRole('button', {name: '开始导出', exact: true}).isDisabled());
  await dialog.getByRole('checkbox', {name: /允许导出不完整内容/}).check();
  await dialog.getByRole('button', {name: '开始导出', exact: true}).click();
  await dialog.getByRole('alert').filter({hasText: /第 2 页导出失败/}).waitFor();
  assert.equal(await dialog.getByRole('link', {name: '下载文件', exact: true}).count(), 0);
  await page.screenshot({path: path.join(output, 'download-failure.png'), fullPage: true});
  checks.push({missingBlocksUntilSelected: true, remoteFailureStopsDownload: true});
  remote = 'success';
  const restored = await unzip(await generate('restored-translation.zip'));
  const restoredNames = [...restored.keys()].filter(n => n.endsWith('.png'));
  assert.equal(restoredNames.length, 2); assert(restoredNames[1].endsWith('/00002.png'));
  assert.equal(await digest(restored.get(restoredNames[1])), originalHashes[3]);
  checks.push({remoteImageDownloadedAndDecoded: true, restoredPageKeepsOrdinal: true});
  await inspect(); await dialog.getByRole('checkbox', {name: /允许导出不完整内容/}).check();
  remote = 'slow'; await dialog.getByRole('button', {name: '开始导出', exact: true}).click();
  await dialog.getByRole('button', {name: '取消导出', exact: true}).click();
  await dialog.getByRole('alert').filter({hasText: '已取消'}).waitFor();
  await dialog.getByRole('button', {name: '开始导出', exact: true}).waitFor();
  assert.equal(await dialog.getByRole('link', {name: '下载文件', exact: true}).count(), 0); checks.push({cancelled: true});
  await dialog.getByRole('button', {name: '返回选择', exact: true}).click();
  await selectOption(dialog.getByLabel('导出图片', {exact: true}),'original'); await inspect();
  await dialog.getByRole('checkbox', {name: /允许导出不完整内容/}).check();
  const partial = await unzip(await generate('partial.zip'));
  assert.equal([...partial.keys()].filter(n => n.endsWith('.png')).length, 1);
  const partialManifest = JSON.parse(await partial.get('导出说明.json').text());
  assert.equal(partialManifest.books[0].complete, false); assert.equal(partialManifest.books[0].expectedPages, 4); assert.equal(partialManifest.books[0].pages.filter(p => p.kind === 'missing').length, 2);
  checks.push({partialExportExplicit: true, knownMissingPages: 2, expectedPages: 4});
  await dialog.getByRole('button', {name: '返回选择', exact: true}).click();
  await dialog.getByRole('button', {name: '清空选择', exact: true}).click();
  await dialog.locator('.nc-export-copy').filter({hasText: '两部作品合订册'}).getByRole('checkbox').check(); await inspect();
  assert(await dialog.getByRole('button', {name: '开始导出', exact: true}).isDisabled());
  await dialog.getByRole('checkbox', {name: /按整份副本导出/}).check(); assert(await dialog.getByRole('button', {name: '开始导出', exact: true}).isEnabled());
  checks.push({sharedCopyRequiresExplicitScope: true});
  await dialog.getByRole('button', {name: '关闭弹窗', exact: true}).click();
  const after = await page.evaluate(async () => { const {readCopies} = await import('/src/library/store.ts'); return (await readCopies()).map(c => ({id: c.id, pageId: c.pageId, relativeOffset: c.relativeOffset, pages: c.pages.map(p => p.id)})); });
  assert.deepEqual(after, initial); assert.deepEqual(errors, []); assert(!requests.some(r => r.startsWith('POST')));
  checks.push({readingPositionAndLibraryPreserved: true, noNewTranslationRequests: true, mobileNoHorizontalOverflow: true});
  await context.close();
} finally { await browser.close(); }
await writeFile(path.join(output, 'results.json'), JSON.stringify({checkedAt: new Date().toISOString(), checks, errors, requests}, null, 2));
console.log('Passed ' + checks.length + ' comic export browser scenarios.');
