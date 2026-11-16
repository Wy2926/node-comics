import assert from 'node:assert/strict';
import path from 'node:path';
import {BlobReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js/index-native.js';

async function epub(source, identity) {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book.opf': `<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${identity}</dc:identifier><dc:title>KOOBONE import fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml"/><item id="image" href="page.png" media-type="image/png"/></manifest><spine><itemref idref="page"/></spine></package>`,
    'page.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page</title></head><body style="margin:0"><img src="page.png" style="width:100%;height:auto"/></body></html>',
    'page.png': source,
    'padding.bin': new Uint8Array(1100000),
  };
  for (const [name, bytes] of Object.entries(files)) await zip.add(name, new BlobReader(new Blob([bytes])), {level: 0});
  return Buffer.from(await zip.close()).toString('base64');
}

export async function verifyFile({browser, page, worker, source, out, check}) {
  const books = await Promise.all(['a', 'b'].map(async id => ({id: id.repeat(32), bytes: await epub(source, id)})));
  await page.evaluate(async books => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('KOOBONE', 10);
      request.onupgradeneeded = () => request.result.createObjectStore('book_vol', {keyPath: 'file_md5'});
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('book_vol', 'readwrite');
        for (const book of books) tx.objectStore('book_vol').put({file_md5: book.id, vol_name: 'KOOBONE import fixture',
          file_blob: new Blob([Uint8Array.from(atob(book.bytes), c => c.charCodeAt(0))], {type: 'application/epub+zip'})});
        tx.oncomplete = () => {db.close(); resolve();};
      };
    });
    window.vol_open = () => {};
    for (const [i, book] of books.entries()) {
      const link = document.createElement('button'); link.id = 'open-book-' + i; link.textContent = 'Open fixture ' + i;
      link.setAttribute('onclick', `vol_open('${book.id}');`); document.querySelector('nav').append(link);
    }
  }, books);
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content-scripts/content.js']});
  }, page.url());
  const open = async index => {
    await page.locator('#open-book-' + index).click();
    const next = browser.waitForEvent('page');
    await page.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}).click();
    const reader = await next; await reader.waitForLoadState();
    try {
      await reader.locator('.nc-epub-viewport[aria-busy="false"]').waitFor({timeout: 30000});
      await reader.waitForFunction(() => [...document.querySelectorAll('.nc-epub-viewport iframe')].some(frame =>
        [...(frame.contentDocument?.images ?? [])].some(image => image.complete && image.naturalWidth > 0)), null, {timeout: 30000});
    } catch (error) {
      await reader.screenshot({path: path.join(out, 'koobone-import-failed.png')});
      throw Error(error.message + '\n' + (await reader.locator('body').innerText()).slice(0, 3000));
    }
    return reader;
  };
  const catalog = reader => reader.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('node-comics-reading-v2-catalog');
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['comics', 'entries']), comics = tx.objectStore('comics').getAll(), entries = tx.objectStore('entries').getAll();
      tx.oncomplete = () => {db.close(); resolve({comics: comics.result, entries: entries.result});};
    };
  }));
  const first = await open(0), firstState = await catalog(first);
  assert.equal(firstState.comics.length, 1); assert.equal(firstState.entries[0].format, 'epub');
  const duplicate = await open(0); assert.equal((await catalog(duplicate)).comics.length, 1); await duplicate.close();
  const second = await open(1), state = await catalog(second);
  assert.equal(state.comics.length, 2); assert.notEqual(state.comics[0].sourceKey, state.comics[1].sourceKey);
  await page.goto('about:blank');
  await second.reload();
  const secondId = state.comics.find(comic => comic.id !== firstState.comics[0].id).id;
  await second.locator(`[data-comic-id="${secondId}"] .nc-book-cover`).click();
  await second.locator('.nc-epub-viewport[aria-busy="false"]').waitFor({timeout: 20000});
  await second.waitForFunction(() => [...document.querySelectorAll('.nc-epub-viewport iframe')].some(frame =>
    [...(frame.contentDocument?.images ?? [])].some(image => image.complete && image.naturalWidth > 0)), null, {timeout: 20000});
  await second.screenshot({path: path.join(out, 'koobone-imported.png')});
  await first.close(); await second.close();
  check('KOOBONE file import: unchanged source URL and identical titles keep separate books; duplicate files reuse the saved comic; EPUB renders after the source tab leaves and the reader reloads.');
}
