import assert from 'node:assert/strict';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';

/** Inspect the actual archive, including copied assets that bypass Vite minify. */
export async function checkStorePackage(bytes, version) {
  const archive = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await archive.getEntries(), names = new Set();
    let manifest, pdfWorker = false, scriptFiles = 0;
    for (const entry of entries) {
      assert(!names.has(entry.filename), `Duplicate ZIP entry: ${entry.filename}`);
      names.add(entry.filename);
      if (entry.directory) continue;
      // Read every entry with CRC checking, not just the files under review.
      const data = await entry.getData(new Uint8ArrayWriter(), {checkSignature: true});
      const code = /\.(?:m?js|json)$/.test(entry.filename) ? new TextDecoder().decode(data) : '';
      if (entry.filename === 'manifest.json') manifest = JSON.parse(code);
      if (!/\.m?js$/.test(entry.filename)) continue;
      scriptFiles++;
      assert(!/pdf\.worker\.min[.-]/.test(entry.filename), `Pre-minified PDF worker: ${entry.filename}`);
      assert(!/ActiveXObject|NullProtoObject|document\.F\s*=\s*Object/.test(code), `Obsolete PDF fallback: ${entry.filename}`);
      if (entry.filename === 'import-assets/pdf/pdf.worker.mjs') {
        assert(code.includes('module.exports = Object.create;'), 'PDF worker must use native Object.create');
        assert(code.includes('class WorkerMessageHandler'), 'PDF worker must retain readable upstream names');
        pdfWorker = true;
      }
    }
    assert.equal(manifest?.manifest_version, 3, 'Store archive must be MV3');
    assert.equal(manifest?.version, version, 'Store archive version differs from package.json');
    assert(!Object.hasOwn(manifest, 'key'), 'Store archive must not include manifest.key');
    assert(pdfWorker, 'Readable local PDF worker is missing');
    return {version, files: entries.length, scriptFiles, bytes: bytes.byteLength};
  } finally {
    await archive.close();
  }
}
