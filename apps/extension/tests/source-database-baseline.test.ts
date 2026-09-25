import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteCache } from '../src/storage/cache';
import { openSourceDatabase, sourceDatabaseName, SourceDatabaseSchemaError, type DatabaseSchema } from '../src/storage/database';
import type { Job } from '../src/types';

const opened = new Set<IDBDatabase>();
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
const track = (database: IDBDatabase) => { opened.add(database); return database; };
async function rawDatabase(name: string, initialize?: (database: IDBDatabase) => void) {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => initialize?.(opening.result);
  return track(await request(opening));
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => { for (const database of opened) database.close(); opened.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('source database baseline isolation', () => {
  it('opens all final databases beside incomplete development v1 databases without changing old records', async () => {
    const names = ['catalog', 'container-bytes', 'source-pages', 'source-ranges', 'downloads', 'thumbnails', 'translations', 'translation-requests'];
    for (const name of names) {
      const database = await rawDatabase('node-comics-' + name, db => db.createObjectStore('sentinel', { keyPath: 'id' }));
      const tx = database.transaction('sentinel', 'readwrite'), done = completed(tx);
      tx.objectStore('sentinel').put({ id: 'keep', label: name, bytes: new Uint8Array([7, 8, 9]) }); await done; database.close();
    }
    const { catalog, openCatalog } = await import('../src/comics/repositories');
    const currentCatalog=track(await openCatalog());expect(currentCatalog.name).toBe(sourceDatabaseName('catalog'));
    expect(currentCatalog.objectStoreNames.contains('translationOperations')).toBe(false);
    expect(await catalog.list('tasks')).toEqual([]); expect(await catalog.list('metadata')).toEqual([]);
    const { byteDatabase, BYTE_BACKEND } = await import('../src/storage/bytes/database');
    const bytes = track(await byteDatabase()); expect(bytes.name).toBe(sourceDatabaseName('container-bytes'));
    expect(bytes.transaction('references').objectStore('references').indexNames.contains('referenceId')).toBe(true);
    expect(await request(bytes.transaction('settings').objectStore('settings').get('backend'))).toEqual({ id: 'backend', value: BYTE_BACKEND });
    const [{ sourcePageCache }, { sourceRangeCache }, { downloadStore }, { thumbnailCache }, { translationCache }] = await Promise.all([
      import('../src/storage/source-pages'), import('../src/storage/source-ranges'), import('../src/storage/downloads'), import('../src/storage/thumbnails'), import('../src/storage/translations'),
    ]);
    for (const cache of [sourcePageCache, sourceRangeCache, downloadStore, thumbnailCache, translationCache]) {
      expect(await cache.put('new', new Blob(['new bytes']))).toBe(true);
      expect(await (await cache.get('new'))?.text()).toBe('new bytes');
    }
    const { saveSync, readSync } = await import('../src/translation/channels/adapters/nodelane/store');
    await saveSync({ id: 'new-account-scope', jobs: [] }); expect(await readSync('new-account-scope')).toEqual({ id: 'new-account-scope', jobs: [] });
    for (const name of names) {
      const old = await rawDatabase('node-comics-' + name);
      expect(old.version).toBe(1); expect([...old.objectStoreNames]).toEqual(['sentinel']);
      expect(await request(old.transaction('sentinel').objectStore('sentinel').get('keep'))).toEqual({ id: 'keep', label: name, bytes: new Uint8Array([7, 8, 9]) });
    }
    const actual = new Set((await indexedDB.databases()).map(database => database.name));
    for (const name of names) { expect(actual.has('node-comics-' + name)).toBe(true); expect(actual.has(sourceDatabaseName(name))).toBe(true); }
  });

  it('rejects a partial current catalog before the first catalog transaction can throw NotFoundError', async () => {
    const database = await rawDatabase(sourceDatabaseName('catalog'), db => db.createObjectStore('comics', { keyPath: 'id' })); database.close();
    const { catalog, openCatalog } = await import('../src/comics/repositories');
    await expect(openCatalog()).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError', message: expect.stringContaining('缺少 entries') });
    await expect(catalog.list('tasks')).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError' });
    const untouched = await rawDatabase(sourceDatabaseName('catalog')); expect(untouched.version).toBe(1); expect([...untouched.objectStoreNames]).toEqual(['comics']);
  });
});

const sampleSchema: DatabaseSchema = {
  records: { keyPath: 'id', indexes: [{ name: 'scope', keyPath: 'scope', unique: true }] },
  objects: { keyPath: null },
};
type BrokenSchema = 'missing-store' | 'missing-index' | 'primary-key' | 'auto-increment' | 'index-key' | 'unique' | 'multi-entry';
function seedBroken(database: IDBDatabase, kind: BrokenSchema) {
  database.createObjectStore('objects').put('preserved bytes', 'keep');
  if (kind === 'missing-store') return;
  const store = database.createObjectStore('records', { keyPath: kind === 'primary-key' ? ['id'] : 'id', autoIncrement: kind === 'auto-increment' });
  if (kind !== 'missing-index') store.createIndex('scope', kind === 'index-key' ? 'owner' : 'scope', { unique: kind !== 'unique', multiEntry: kind === 'multi-entry' });
}
describe('same-version structure validation', () => {
  it.each<BrokenSchema>(['missing-store', 'missing-index', 'primary-key', 'auto-increment', 'index-key', 'unique', 'multi-entry'])('rejects %s without altering the existing database', async kind => {
    const name = 'schema-' + kind, database = await rawDatabase(sourceDatabaseName(name), db => seedBroken(db, kind));
    const tables = [...database.objectStoreNames]; database.close();
    const opening = openSourceDatabase(name, sampleSchema, () => {});
    await expect(opening).rejects.toBeInstanceOf(SourceDatabaseSchemaError);
    await expect(opening).rejects.toThrow('已有资料未被清除');
    const unchanged = await rawDatabase(sourceDatabaseName(name)); expect(unchanged.version).toBe(1); expect([...unchanged.objectStoreNames]).toEqual(tables);
    expect(await request(unchanged.transaction('objects').objectStore('objects').get('keep'))).toBe('preserved bytes');
  });

  it('checks populated valid structures without reading stored Blob records or scanning data', async () => {
    const name = 'validate-metadata-only', initial = track(await openSourceDatabase(name, sampleSchema, () => {}));
    const tx = initial.transaction('objects', 'readwrite'), done = completed(tx); tx.objectStore('objects').put(new Blob(['original bytes']), 'keep'); await done; initial.close();
    const get = vi.spyOn(IDBObjectStore.prototype, 'get'), all = vi.spyOn(IDBObjectStore.prototype, 'getAll'), keys = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys'), cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    track(await openSourceDatabase(name, sampleSchema, () => {}));
    for (const spy of [get, all, keys, cursor]) expect(spy).not.toHaveBeenCalled();
  });
});

describe('cache and complete-source baseline errors', () => {
  it('surfaces a real malformed result database through concurrent result loaders without a remote download', async () => {
    const database = await rawDatabase(sourceDatabaseName('translations'), db => db.createObjectStore('objects').put(new Blob(['saved result']), 'keep')); database.close();
    const { loadResultBlob, resultBlobKey, resultInMemory } = await import('../src/storage/translations/results');
    const job: Job = { id: 'result-job', input_asset_id: 'original', output_asset_id: 'output', result:{key:'output',recoverable:true}, status: 'succeeded', phase: 'completed', mode: 'classic', target_language: 'zh-Hans', created_at: '2026-09-22T00:00:00Z', version: 1, quota_pages: 1, cache_hit: false };
    const input = { scope:{key:JSON.stringify(['https://api.example','account'])}, job, isCurrent: () => true, download: vi.fn(async () => new Blob(['remote result'])) };
    await Promise.all([loadResultBlob(input), loadResultBlob(input)].map(pending => expect(pending).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError', message: expect.stringContaining('缺少 metadata') })));
    expect(input.download).not.toHaveBeenCalled(); expect(resultInMemory(resultBlobKey(input.scope, job))).toBeUndefined();
    await expect(loadResultBlob(input)).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError' }); expect(input.download).not.toHaveBeenCalled();
    const unchanged = await rawDatabase(sourceDatabaseName('translations')); expect([...unchanged.objectStoreNames]).toEqual(['objects']);
    expect(await (await request(unchanged.transaction('objects').objectStore('objects').get('keep')) as Blob).text()).toBe('saved result');
  });

  it.each([false, true])('propagates an actionable schema error from cache reads and writes (retained=%s)', async retained => {
    const name = retained ? 'downloads' : 'source-pages';
    const database = await rawDatabase(sourceDatabaseName(name), db => {
      const metadata = db.createObjectStore('metadata', { keyPath: 'key' });
      for (const index of ['usedAt', 'owner', 'connectionId', 'contentId']) metadata.createIndex(index, index);
      metadata.put({ key: 'keep', size: 4, usedAt: 1 }); db.createObjectStore('objects').put(new Blob(['keep']), 'keep');
      db.createObjectStore('state', { keyPath: 'id' }); // Earlier partial baseline has no reservations store.
    }); database.close();
    const cache = new ByteCache({ name, budgetBytes: 1024, retained });
    for (const action of [() => cache.usage(), () => cache.get('keep'), () => cache.has('keep'), () => cache.put('late', new Blob(['late']))]) {
      await expect(action()).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError', message: expect.stringContaining('缺少 reservations') });
    }
    const unchanged = await rawDatabase(sourceDatabaseName(name)); expect(unchanged.objectStoreNames.contains('reservations')).toBe(false);
    expect(await (await request(unchanged.transaction('objects').objectStore('objects').get('keep')) as Blob).text()).toBe('keep');
  });

  it.each(['missing', 'different'] as const)('rejects a %s immutable byte backend marker without replacing it', async variant => {
    const { byteDatabase } = await import('../src/storage/bytes/database');
    const database = track(await byteDatabase()), tx = database.transaction('settings', 'readwrite'), done = completed(tx);
    if (variant === 'missing') tx.objectStore('settings').delete('backend'); else tx.objectStore('settings').put({ id: 'backend', value: 'different-backend' });
    await done; database.close(); vi.resetModules();
    const fresh = await import('../src/storage/bytes/database');
    await expect(fresh.byteDatabase()).rejects.toMatchObject({ name: 'SourceDatabaseSchemaError' });
    const unchanged = await rawDatabase(sourceDatabaseName('container-bytes'));
    expect(await request(unchanged.transaction('settings').objectStore('settings').get('backend'))).toEqual(variant === 'missing' ? undefined : { id: 'backend', value: 'different-backend' });
  });
});
