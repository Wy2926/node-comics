import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { catalog, idbCompleted, openCatalog } from '../src/comics/repositories';

it.runIf(process.env.NC_CATALOG_SCALE === '1')('pages a 1000-document / 100000-page catalog without full-table reads or whole-library writes', async () => {
  const db = await openCatalog();
  const tx = db.transaction(['works', 'units', 'documents', 'revisions', 'pageDescriptors'], 'readwrite'), done = idbCompleted(tx);
  const prefix = crypto.randomUUID();
  // Fixture creation deliberately uses a single atomic metadata-only transaction.
  for (let index = 0; index < 1000; index++) {
    const suffix = String(index).padStart(4, '0'), workId = `${prefix}:work:${suffix}`, unitId = `${prefix}:unit:${suffix}`, documentId = `${prefix}:doc:${suffix}`, revisionId = `${prefix}:revision:${suffix}`;
    tx.objectStore('works').put({ id: workId, title: `Work ${index}`, updatedAt: index, createdAt: index, documentCount: 1 });
    tx.objectStore('units').put({ id: unitId, workId, title: 'Chapter', order: 0, kind: 'chapter', role: 'main', createdAt: 1, updatedAt: 1 });
    tx.objectStore('documents').put({ id: documentId, unitId, sourceBindingId: `${prefix}:source:${suffix}`, title: 'Document', format: 'zip', revisionId, generation: 1, indexState: 'ready', pageCount: 100, createdAt: 1, updatedAt: 1 });
    tx.objectStore('revisions').put({ id: revisionId, documentId, status: 'ready', generation: 1, parserVersion: 'test', indexVersion: 1, createdAt: 1 });
    for (let ordinal = 0; ordinal < 100; ordinal++) tx.objectStore('pageDescriptors').put({ revisionId, pageId: `${prefix}:page:${suffix}:${ordinal}`, ordinal, name: String(ordinal), formatLocator: String(ordinal), locator: { entryIndex: ordinal } });
  }
  await done;
  const fullReads = vi.spyOn(IDBObjectStore.prototype, 'getAll'), writes = vi.spyOn(IDBObjectStore.prototype, 'put');
  expect((await catalog.listWorks({ offset: 480, limit: 48 })).length).toBe(48);
  const pages = await catalog.listPages(`${prefix}:revision:0999`, { offset: 70, limit: 20 });
  expect(pages.map(page => page.ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index + 70));
  await catalog.patch('documents', `${prefix}:doc:0999`, { title: 'Updated one document' });
  expect(fullReads).not.toHaveBeenCalled(); expect(writes).toHaveBeenCalledTimes(1);
  fullReads.mockRestore(); writes.mockRestore();
}, 180000);
