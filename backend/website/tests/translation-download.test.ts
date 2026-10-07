import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js/index-native.js';
import { translationArchive, translationFilename } from '../src/lib/translation-download';

test('download names use actual image types and safe, localized basenames', () => {
  assert.equal(translationFilename('../../第1页.jpg', 'zh-Hans', 'image/png'), '第1页-zh-Hans.png');
  assert.equal(translationFilename('C:\\images\\page?.png', 'en', 'image/webp'), 'page_-en.webp');
  assert.equal(translationFilename('.png', 'ja', 'image/jpeg'), 'image-ja.jpg');
});

test('batch ZIP preserves order, duplicate names and exact result bytes without recompression', async () => {
  const files = ['first-result', 'second-result', '第三张'];
  let reading = false;
  const seen: string[] = [];
  const blob = await translationArchive(files, async (text) => {
    assert.equal(reading, false, 'result reads must be sequential');
    reading = true;
    await Promise.resolve();
    seen.push(text);
    reading = false;
    return { name: translationFilename('漫画.png', 'en', 'image/png'), blob: new Blob([text]) };
  });
  assert.deepEqual(seen, files);
  const zip = new ZipReader(new BlobReader(blob), { useWebWorkers: false, checkSignature: true });
  try {
    const entries = await zip.getEntries();
    assert.deepEqual(entries.map((entry) => entry.filename), ['001-漫画-en.png', '002-漫画-en.png', '003-漫画-en.png']);
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.compressionMethod, 0);
      assert.ok(!entry.directory);
      assert.equal(await (await entry.getData!(new BlobWriter())).text(), files[index]);
    }
  } finally { await zip.close(); }
});

test('missing result rejects the archive instead of silently returning a partial download', async () => {
  await assert.rejects(translationArchive([1, 2], async (id) => {
    if (id === 2) throw Error('LOCAL_INPUT_MISSING');
    return { name: 'one.png', blob: new Blob(['result']) };
  }), /LOCAL_INPUT_MISSING/);
  await assert.rejects(translationArchive([], async () => { throw Error('not reached'); }), /INPUT_MISSING/);
});
