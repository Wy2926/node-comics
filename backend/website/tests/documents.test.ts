import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DocumentError, documentSourceType, signedObjectUrl, transferDocumentParts } from '../src/lib/document-api';
import { HASH_CHUNK_BYTES, hashDocumentBlob } from '../src/lib/document-hash';
import { documentCopy, documentError, documentFormat } from '../src/i18n/documents';
import { locales } from '../src/i18n/locales';

test('file SHA-256 matches crypto with bounded slice reads and no whole-file buffer', async () => {
  const bytes = new Uint8Array(HASH_CHUNK_BYTES * 2 + 117).map((_, index) => index % 253);
  let largest = 0, count = 0;
  class BoundedBlob extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> { throw Error('Whole-file allocation is forbidden'); }
    override slice(start?: number, end?: number) {
      const chunk = super.slice(start, end); largest = Math.max(largest, chunk.size); count++;
      return chunk;
    }
  }
  const progress: number[] = [];
  assert.equal(await hashDocumentBlob(new BoundedBlob([bytes]), size => progress.push(size)), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(largest, HASH_CHUNK_BYTES); assert.equal(count, 3);
  assert.equal(progress.at(-1), bytes.byteLength);
});

test('multipart has two bounded uploads and retries only the failed part with a fresh signature', async () => {
  const file = new Blob(['abcdefghijklmnopq']), completed = new Set<number>();
  const signed: number[] = [], bodies = new Map<number, string>(), progress: number[] = [];
  let active = 0, peak = 0, failed = false;
  await transferDocumentParts(file, 5, completed, new AbortController().signal, async part => {
    signed.push(part); return { part_number: part, url: 'https://r2.invalid/' + signed.length, headers: {}, expires_in: 300 };
  }, async (part, blob) => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (part.part_number === 2 && !failed) { failed = true; throw new DocumentError('EXPIRED_SIGNATURE', 403); }
      bodies.set(part.part_number, await blob.text());
    } finally { active--; }
  }, bytes => progress.push(bytes), 0);
  assert.equal(peak, 2);
  assert.equal(signed.filter(part => part === 2).length, 2);
  assert.deepEqual(signed.filter(part => part !== 2).sort(), [1, 3, 4]);
  assert.deepEqual([...bodies.entries()].sort(), [[1, 'abcde'], [2, 'fghij'], [3, 'klmno'], [4, 'pq']]);
  assert.equal(progress.at(-1), file.size);
});

test('resuming an interrupted upload does not resend completed parts', async () => {
  const sent: number[] = [], completed = new Set([1, 2]);
  await transferDocumentParts(new Blob(['123456789']), 3, completed, new AbortController().signal, async part => ({
    part_number: part, url: 'https://r2.invalid/', headers: {}, expires_in: 300,
  }), async part => { sent.push(part.part_number); });
  assert.deepEqual(sent, [3]); assert.deepEqual([...completed], [1, 2, 3]);
});

test('account cancellation aborts both workers without starting later parts', async () => {
  const controller = new AbortController(), completed = new Set<number>(), signed: number[] = [];
  await assert.rejects(transferDocumentParts(new Blob(['123456789012']), 3, completed, controller.signal, async part => {
    signed.push(part); return { part_number: part, url: 'https://r2.invalid/', headers: {}, expires_in: 300 };
  }, async (_part, _blob, signal) => { controller.abort(new Error('account changed')); signal.throwIfAborted(); }), /account changed/);
  assert.ok(signed.length <= 2); assert.equal(completed.size, 0);
});

test('invalid multipart layouts and client formats are rejected before allocation or network', async () => {
  const unused = async (): Promise<never> => { throw Error('must not run'); };
  await assert.rejects(transferDocumentParts(new Blob(['x'.repeat(41)]), 1, new Set(), new AbortController().signal, unused, unused), /DOCUMENT_PART_INVALID/);
  assert.equal(documentSourceType('book.CBZ'), 'zip'); assert.equal(documentSourceType('book.PDF'), 'pdf');
  assert.throws(() => documentSourceType('book.pdf.exe'), /UNSUPPORTED_FORMAT/);
  assert.throws(() => signedObjectUrl('http://r2.invalid/file'), /STORAGE_UNAVAILABLE/);
  assert.throws(() => signedObjectUrl('https://token@r2.invalid/file'), /STORAGE_UNAVAILABLE/);
});

test('Chinese copy and explicit English fallback preserve manual resume and cancellation rules', () => {
  assert.match(documentCopy('zh-CN').quotaRule, /预占后不可取消/);
  assert.match(documentCopy('zh-TW').manualResume, /不會自動啟動/);
  for (const locale of locales) {
    const copy = documentCopy(locale);
    assert.ok(copy.output && copy.errors.generic && documentError('DOCUMENT_NOT_CANCELLABLE', copy));
    if (!locale.startsWith('zh-')) assert.equal(copy.lang, 'en');
  }
  assert.equal(documentFormat('{needed}/{difference}', { needed: 200, difference: 3 }), '200/3');
});
