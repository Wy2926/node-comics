import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DatabaseSchema} from '../src/storage/database';

// Frozen pre-tracking v1 schema: do not derive it from the current implementation.
const legacySchema: DatabaseSchema = {
  comics: {keyPath: 'id', indexes: [{name: 'sourceKey', keyPath: 'sourceKey', unique: true}, {name: 'connectionId', keyPath: 'source.connectionId'}, {name: 'updatedAt', keyPath: 'updatedAt'}, {name: 'lastReadAt', keyPath: 'lastReadAt'}]},
  entries: {keyPath: 'id', indexes: [{name: 'comicId', keyPath: 'comicId'}, {name: 'comicOrder', keyPath: ['comicId', 'order']}, {name: 'sourceEntry', keyPath: ['comicId', 'sourceEntryId'], unique: true}, {name: 'contentId', keyPath: 'contentId', unique: true}]},
  connections: {keyPath: 'id', indexes: [{name: 'provider', keyPath: 'provider'}]},
  pageDescriptors: {keyPath: ['contentId', 'pageId'], indexes: [{name: 'contentId', keyPath: 'contentId'}, {name: 'contentOrdinal', keyPath: ['contentId', 'ordinal']}, {name: 'contentLocator', keyPath: ['contentId', 'formatLocator'], unique: true}]},
  materializations: {keyPath: 'id', indexes: [{name: 'contentId', keyPath: 'contentId'}, {name: 'pageId', keyPath: 'pageId'}, {name: 'imageSha256', keyPath: 'imageSha256'}]},
  positions: {keyPath: 'id', indexes: [{name: 'entryId', keyPath: 'entryId', unique: true}, {name: 'comicId', keyPath: 'comicId'}, {name: 'updatedAt', keyPath: 'updatedAt'}]},
  catalogs: {keyPath: 'id', indexes: [{name: 'comicId', keyPath: 'comicId'}]},
  tasks: {keyPath: 'id', indexes: [{name: 'entryId', keyPath: 'entryId'}, {name: 'status', keyPath: 'status'}, {name: 'statusNextRun', keyPath: ['status', 'nextRunAt']}]},
  metadata: {keyPath: 'id'}, tombstones: {keyPath: 'id'},
};
const databaseName = 'node-comics-reading-v2-catalog';
const records = {
  comics: {id: 'comic', sourceKey: 'source:comic', source: {connectionId: 'website:mangadex'}, title: 'Existing comic', lastReadAt: 10},
  entries: {id: 'entry', comicId: 'comic', sourceEntryId: 'source:entry', contentId: 'content', order: 0, generation: 7, readAt: 10},
  connections: {id: 'website:mangadex', provider: 'website', status: 'connected'},
  pageDescriptors: {contentId: 'content', pageId: 'page', ordinal: 0, formatLocator: 'retained-source-key'},
  materializations: {id: 'image', contentId: 'content', pageId: 'page', imageSha256: 'hash'},
  positions: {id: 'entry', entryId: 'entry', comicId: 'comic', pageId: 'page', relativeOffset: .5, updatedAt: 10},
  catalogs: {id: 'source:comic', comicId: 'comic', entries: [{id: 'source:entry'}]},
  tasks: {id: 'download', entryId: 'entry', status: 'paused', completed: 1, total: 10, nextRunAt: 20},
  metadata: {id: 'reading-preferences:comic', language: 'es'},
  tombstones: {id: 'entries:removed', deletedAt: 9},
};
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const opened: IDBDatabase[] = [];
beforeEach(() => {vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());});
afterEach(() => {for (const db of opened.splice(0)) db.close(); vi.unstubAllGlobals();});

async function seedLegacy(invalidIndex = false) {
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    for (const [name, definition] of Object.entries(legacySchema)) {
      const store = opening.result.createObjectStore(name, {keyPath: definition.keyPath!});
      for (const index of definition.indexes ?? []) store.createIndex(index.name, index.keyPath, {
        unique: invalidIndex && name === 'comics' && index.name === 'sourceKey' ? false : !!index.unique,
      });
      store.put(records[name as keyof typeof records]);
    }
  };
  const db = await request(opening); db.close();
}

async function assertExistingRecords(db: IDBDatabase) {
  const tx = db.transaction(Object.keys(records));
  const stored = await Promise.all(Object.keys(records).map(name => request(tx.objectStore(name).getAll())));
  expect(stored).toEqual(Object.values(records).map(value => [value]));
}

describe('additive tracker catalog migration', () => {
  it('upgrades real v1 stores in place without changing local reads, download tasks, source records or indexes', async () => {
    await seedLegacy();
    const {openCatalog} = await import('../src/comics/repositories');
    const db = await openCatalog(); opened.push(db);
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames].sort()).toEqual([...Object.keys(legacySchema), 'trackingBindings', 'trackingJobs'].sort());
    await assertExistingRecords(db);
    expect(await request(db.transaction('trackingBindings').objectStore('trackingBindings').count())).toBe(0);
    const queue = db.transaction('trackingJobs').objectStore('trackingJobs');
    expect(await request(queue.count())).toBe(0);
    expect([...queue.indexNames]).toEqual(['blocked', 'due', 'scope']);
    expect(queue.index('due').keyPath).toEqual(['scope', 'nextRunAt']);
    const tx = db.transaction(Object.keys(legacySchema));
    for (const [name, definition] of Object.entries(legacySchema)) {
      const store = tx.objectStore(name);
      expect(store.keyPath).toEqual(definition.keyPath);
      for (const index of definition.indexes ?? []) {
        expect(store.index(index.name).keyPath).toEqual(index.keyPath);
        expect(store.index(index.name).unique).toBe(!!index.unique);
      }
    }
  });

  it('aborts a mismatched v1 schema without discarding old data or leaving a partial tracking upgrade', async () => {
    await seedLegacy(true);
    const {openCatalog} = await import('../src/comics/repositories');
    await expect(openCatalog()).rejects.toThrow('索引不匹配');
    const db = await request(indexedDB.open(databaseName)); opened.push(db);
    expect(db.version).toBe(1);
    expect(db.objectStoreNames.contains('trackingBindings')).toBe(false);
    expect(db.objectStoreNames.contains('trackingJobs')).toBe(false);
    await assertExistingRecords(db);
  });
});
