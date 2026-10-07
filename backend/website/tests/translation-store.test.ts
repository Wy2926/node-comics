import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRecords, readImages, removeRecord, removeRecords, saveRecord, storageBytes, type RecordMeta } from '../src/lib/translation-store';
import { translationCacheCopy } from '../src/i18n/translation-cache';
import { locales } from '../src/i18n/locales';

async function seed(id: string, scope: string) {
  const source = new Blob(['source']), input = new Blob(['input']), result = new Blob(['translation']);
  const meta: RecordMeta = { id, scope, name: id, created: 1, updated: 1, state: 'succeeded', mode: 'classic', language: 'en', bytes: source.size + input.size + result.size };
  await saveRecord(meta, { id, source, input, result });
  return meta.bytes;
}

test('bulk clearing removes metadata and every image blob, preserves other histories, and is repeatable', async () => {
  await seed('draft', 'draft:local');
  await seed('mine', 'user:one');
  const kept = await seed('other', 'user:two') + await seed('guest', 'guest:one');
  const selected = await listRecords(['draft:local', 'user:one']);
  await removeRecords(selected.map(row => row.id));
  assert.deepEqual(await listRecords(['draft:local', 'user:one']), []);
  for (const id of ['draft', 'mine']) assert.equal(await readImages(id), undefined);
  for (const id of ['other', 'guest']) assert.ok((await readImages(id))?.result);
  assert.equal(await storageBytes(), kept);
  await removeRecords(['draft', 'mine', 'mine']);
  await removeRecords([]);
  assert.equal(await storageBytes(), kept);
  await removeRecord('other');
  await removeRecord('guest');
  assert.equal(await storageBytes(), 0);
});

test('a failed clearing transaction rolls back records and images together', async () => {
  const bytes = await seed('rollback', 'user:test');
  const original = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    const request = original.call(this, key);
    if (this.name === 'images') this.transaction.abort();
    return request;
  };
  try { await assert.rejects(removeRecords(['rollback'])); }
  finally { IDBObjectStore.prototype.delete = original; }
  assert.equal((await listRecords(['user:test'])).length, 1);
  assert.ok((await readImages('rollback'))?.result);
  assert.equal(await storageBytes(), bytes);
  await removeRecord('rollback');
});

test('all 17 locales explain local-only cache clearing and supply success feedback', () => {
  assert.deepEqual(Object.keys(translationCacheCopy).sort(), [...locales].sort());
  for (const copy of Object.values(translationCacheCopy)) {
    assert.ok(copy.clear && copy.confirm && copy.cleared);
    assert.ok(copy.confirm.length > copy.clear.length);
  }
});
