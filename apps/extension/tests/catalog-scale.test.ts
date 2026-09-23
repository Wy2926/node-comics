import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { catalog, idbCompleted, openCatalog } from '../src/comics/repositories';

it.runIf(process.env.NC_CATALOG_SCALE === '1')('pages a 1000-document / 100000-page catalog without full-table reads or whole-library writes', async () => {
  const db = await openCatalog();
  const tx = db.transaction(['comics', 'entries', 'pageDescriptors'], 'readwrite'), done = idbCompleted(tx);
  const prefix = crypto.randomUUID();
  // Fixture creation deliberately uses a single atomic metadata-only transaction.
  for (let index = 0; index < 1000; index++) {
    const suffix = String(index).padStart(4, '0'), comicId = `${prefix}:work:${suffix}`, entryId = `${prefix}:doc:${suffix}`, contentId = `${prefix}:revision:${suffix}`;
    tx.objectStore('comics').put({ id: comicId, title: `Work ${index}`, updatedAt: index, createdAt: index, sourceKey:comicId,sourceName:'Local',source:{connectionId:'local',providerItemId:comicId,locator:{},generation:1,status:'active'} });
    tx.objectStore('entries').put({ id: entryId, comicId,order:0, title: 'Document', format: 'zip', contentId, generation: 1, indexState: 'ready', pageCount: 100, createdAt: 1, updatedAt: 1 });
    for (let ordinal = 0; ordinal < 100; ordinal++) tx.objectStore('pageDescriptors').put({ contentId, pageId: `${prefix}:page:${suffix}:${ordinal}`, ordinal, name: String(ordinal), formatLocator: String(ordinal), locator: { entryIndex: ordinal } });
  }
  await done;
  const fullReads = vi.spyOn(IDBObjectStore.prototype, 'getAll'), writes = vi.spyOn(IDBObjectStore.prototype, 'put');
  expect((await catalog.list('comics',{ offset: 480, limit: 48 })).length).toBe(48);
  const pages = await catalog.listPages(`${prefix}:revision:0999`, { offset: 70, limit: 20 });
  expect(pages.map(page => page.ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index + 70));
  await catalog.patch('entries', `${prefix}:doc:0999`, { title: 'Updated one document' });
  expect(fullReads).not.toHaveBeenCalled(); expect(writes).toHaveBeenCalledTimes(1);
  fullReads.mockRestore(); writes.mockRestore();
}, 180000);
