import type { CatalogTable, CatalogTables, PageDescriptor } from '../domain';
import { openSourceDatabase, sourceDatabaseName, type DatabaseSchema } from '../../storage/database';

export const CATALOG_DATABASE = sourceDatabaseName('catalog');
export interface CatalogChange { table: CatalogTable; ids: IDBValidKey[] }
export type CatalogWrite = { [T in CatalogTable]: { table: T; value: CatalogTables[T] } }[CatalogTable];
export interface ListOptions {
  index?: string; range?: IDBValidKey | IDBKeyRange; offset?: number; limit?: number;
  direction?: IDBCursorDirection;
}
export interface CatalogMutation {
  get<T extends CatalogTable>(table: T, id: IDBValidKey): Promise<CatalogTables[T] | undefined>;
  list<T extends CatalogTable>(table: T, options?: ListOptions): Promise<CatalogTables[T][]>;
  put<T extends CatalogTable>(table: T, record: CatalogTables[T]): Promise<void>;
  remove(table: CatalogTable, id: IDBValidKey): Promise<void>;
}
const schema: Record<CatalogTable, [string, string | string[], boolean?][]> = {
  works: [['updatedAt', 'updatedAt'], ['lastReadAt', 'lastReadAt']],
  units: [['workId', 'workId'], ['workOrder', ['workId', 'order']]],
  documents: [['unitId', 'unitId'], ['sourceKey', 'sourceKey', true], ['sourceBindingId', 'sourceBindingId']],
  connections: [['provider', 'provider']],
  bindings: [['connectionId', 'connectionId'], ['providerItem', ['connectionId', 'providerItemId'], true]],
  revisions: [['documentId', 'documentId'], ['containerId', 'containerId']],
  pageDescriptors: [['revisionId', 'revisionId'], ['revisionOrdinal', ['revisionId', 'ordinal']], ['revisionLocator', ['revisionId', 'formatLocator'], true]],
  materializations: [['revisionId', 'revisionId'], ['pageId', 'pageId'], ['imageSha256', 'imageSha256']],
  positions: [['documentId', 'documentId', true], ['workId', 'workId'], ['updatedAt', 'updatedAt']],
  translationBindings: [['imageSha256', 'imageSha256'], ['account', ['apiOrigin', 'userId']]],
  acquisitionTasks: [['documentId', 'documentId'], ['status', 'status'], ['statusNextRun', ['status', 'nextRunAt']]],
  translationOperations: [['documentId', 'documentId'], ['status', 'status']],
  catalogs: [['connectionId', 'connectionId']],
  tasks: [['documentId', 'documentId'], ['status', 'status'], ['statusNextRun', ['status', 'nextRunAt']]],
  metadata: [], tombstones: [],
};
export const idbRequest = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
export const idbCompleted = (tx: IDBTransaction): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('Catalog transaction aborted'));
    tx.onerror = () => reject(tx.error ?? Error('Catalog transaction failed'));
  });
  void done.catch(() => {}); return done;
};
let opening: Promise<IDBDatabase> | undefined;
const databaseSchema: DatabaseSchema = Object.fromEntries(Object.entries(schema).map(([name, indices]) => [name, {
  keyPath: name === 'pageDescriptors' ? ['revisionId', 'pageId'] : 'id',
  indexes: indices.map(([name, keyPath, unique]) => ({ name, keyPath, unique })),
}]));
export function openCatalog(): Promise<IDBDatabase> {
  if (!opening) opening = openSourceDatabase('catalog', databaseSchema, () => { opening = undefined; }).catch(error => { opening = undefined; throw error; });
  return opening;
}
const listeners = new Set<(change: CatalogChange) => void>();
let channel: BroadcastChannel | undefined;
function broadcast(): BroadcastChannel | undefined {
  // A service worker has no window; it still sends invalidations to reader tabs.
  if (!channel && typeof BroadcastChannel !== 'undefined' && typeof navigator !== 'undefined' && typeof indexedDB !== 'undefined') {
    channel = new BroadcastChannel(sourceDatabaseName('catalog-changes'));
    channel.onmessage = event => { const change = event.data as CatalogChange; if (change?.table in schema && Array.isArray(change.ids)) for (const listener of listeners) listener(change); };
  }
  return channel;
}
function changed(table: CatalogTable, ids: IDBValidKey[]) {
  const change = { table, ids }; for (const listener of listeners) listener(change); broadcast()?.postMessage(change);
}
async function cursorValues<T>(source: IDBObjectStore | IDBIndex, options: ListOptions, matches?: (value: T) => boolean): Promise<T[]> {
  const offset = Math.max(0, options.offset ?? 0), limit = Math.max(0, options.limit ?? 100);
  if (!limit) return [];
  return new Promise((resolve, reject) => {
    const values: T[] = []; let skipped = false, matched = 0;
    const request = source.openCursor(options.range, options.direction ?? 'next');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || values.length >= limit) { resolve(values); return; }
      if (matches) {
        if (!matches(cursor.value) || matched++ < offset) { cursor.continue(); return; }
      } else if (!skipped && offset) { skipped = true; cursor.advance(offset); return; }
      values.push(cursor.value as T);
      if (values.length >= limit) resolve(values); else cursor.continue();
    };
  });
}
export class StaleCatalogWriteError extends Error { constructor() { super('The document was removed or its revision changed.'); this.name = 'StaleCatalogWriteError'; } }

export const catalog = {
  /** Keep all reads and writes for an association change in one IDB transaction. */
  async mutate<T>(tables: CatalogTable[], edit: (records: CatalogMutation) => Promise<T>): Promise<T> {
    const db = await openCatalog(), tx = db.transaction([...new Set([...tables, 'tombstones'])], 'readwrite'), done = idbCompleted(tx);
    const writes = new Map<CatalogTable, IDBValidKey[]>();
    const records: CatalogMutation = {
      get: (table, id) => idbRequest(tx.objectStore(table).get(id)),
      list: (table, options = {}) => {
        const store = tx.objectStore(table); return cursorValues(options.index ? store.index(options.index) : store, options);
      },
      async put(table, record) {
        const key = table === 'pageDescriptors' ? [(record as PageDescriptor).revisionId, (record as PageDescriptor).pageId] : (record as {id: string}).id;
        if (await idbRequest(tx.objectStore('tombstones').get([table, key].join(':')))) throw new StaleCatalogWriteError();
        tx.objectStore(table).put(record); writes.set(table, [...writes.get(table) ?? [], key]);
      },
      async remove(table, id) {
        tx.objectStore(table).delete(id); tx.objectStore('tombstones').put({id: [table, id].join(':'), deletedAt: Date.now()});
        writes.set(table, [...writes.get(table) ?? [], id]);
      },
    };
    try {
      const result = await edit(records); await done;
      for (const [table, ids] of writes) changed(table, ids);
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* A failed request may already have aborted the transaction. */ }
      await done.catch(() => {}); throw error;
    }
  },
  async finishIndex(documentId: string, revisionId: string, generation: number, summary: Pick<CatalogTables['documents'], 'pageCount' | 'knownTotal' | 'discoveryComplete' | 'coverPageId'>): Promise<boolean> {
    const db = await openCatalog(), tx = db.transaction(['documents', 'revisions'], 'readwrite'), done = idbCompleted(tx);
    const document = await idbRequest(tx.objectStore('documents').get(documentId)) as CatalogTables['documents'] | undefined;
    const revision = await idbRequest(tx.objectStore('revisions').get(revisionId)) as CatalogTables['revisions'] | undefined;
    if (!document || document.generation !== generation || document.revisionId !== revisionId || revision?.documentId !== documentId) { await done; return false; }
    tx.objectStore('documents').put({ ...document, ...summary, indexState: 'ready', error: undefined });
    tx.objectStore('revisions').put({ ...revision, status: 'ready', pageCount: summary.pageCount, error: undefined });
    await done; changed('documents', [documentId]); changed('revisions', [revisionId]); return true;
  },
  async editTranslationBinding(id: string, edit: (previous: CatalogTables['translationBindings'] | undefined) => CatalogTables['translationBindings'] | undefined): Promise<CatalogTables['translationBindings'] | undefined> {
    const db = await openCatalog(), tx = db.transaction('translationBindings', 'readwrite'), done = idbCompleted(tx);
    const store = tx.objectStore('translationBindings'), previous = await idbRequest(store.get(id)) as CatalogTables['translationBindings'] | undefined;
    const next = edit(previous); if (next) store.put(next); await done;
    if (next) changed('translationBindings', [id]); return next ?? previous;
  },
  async commit(records: CatalogWrite[], options: { require?: { table: CatalogTable; id: IDBValidKey }[]; incrementWorkDocuments?: string } = {}): Promise<void> {
    if (!records.length) return;
    const tables = [...new Set<CatalogTable>([...records.map(record => record.table), ...(options.require ?? []).map(record => record.table), ...(options.incrementWorkDocuments ? ['works' as const] : []), 'tombstones'])];
    const db = await openCatalog(), tx = db.transaction(tables, 'readwrite'), done = idbCompleted(tx);
    for (const { table, value } of records) {
      const key = table === 'pageDescriptors' ? [(value as PageDescriptor).revisionId, (value as PageDescriptor).pageId] : (value as { id: string }).id;
      if (table !== 'tombstones' && await idbRequest(tx.objectStore('tombstones').get([table, key].join(':')))) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
      tx.objectStore(table).put(value);
    }
    for (const required of options.require ?? []) if (!await idbRequest(tx.objectStore(required.table).get(required.id))) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    if (options.incrementWorkDocuments) {
      const work = await idbRequest(tx.objectStore('works').get(options.incrementWorkDocuments)) as CatalogTables['works'] | undefined;
      if (!work) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
      tx.objectStore('works').put({ ...work, documentCount: (work.documentCount ?? 0) + 1, updatedAt: Date.now() });
    }
    await done;
    for (const table of tables) if (table !== 'tombstones') changed(table, records.filter(record => record.table === table).map(({ value }) => 'id' in value ? value.id : [value.revisionId, value.pageId]) as IDBValidKey[]);
  },
  async get<T extends CatalogTable>(table: T, id: IDBValidKey): Promise<CatalogTables[T] | undefined> {
    const db = await openCatalog(); return idbRequest(db.transaction(table).objectStore(table).get(id));
  },
  async put<T extends CatalogTable>(table: T, record: CatalogTables[T]): Promise<void> {
    const db = await openCatalog(), tx = db.transaction([table, 'tombstones'], 'readwrite'), done = idbCompleted(tx);
    const key = table === 'pageDescriptors' ? [(record as PageDescriptor).revisionId, (record as PageDescriptor).pageId] : (record as { id: string }).id;
    if (table !== 'tombstones' && await idbRequest(tx.objectStore('tombstones').get([table, key].join(':')))) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    tx.objectStore(table).put(record); await done; changed(table, [key]);
  },
  async patch<T extends CatalogTable>(table: T, id: IDBValidKey, patch: Partial<CatalogTables[T]>, options: { expectedGeneration?: number } = {}): Promise<CatalogTables[T] | undefined> {
    const db = await openCatalog(), tx = db.transaction(table, 'readwrite'), done = idbCompleted(tx), store = tx.objectStore(table);
    const value = await idbRequest(store.get(id)) as CatalogTables[T] | undefined;
    if (!value) { await done; return undefined; }
    if (options.expectedGeneration !== undefined && (value as unknown as { generation: number }).generation !== options.expectedGeneration) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    const next = { ...value, ...patch }; store.put(next); await done; changed(table, [id]); return next;
  },
  async remove(table: CatalogTable, id: IDBValidKey): Promise<void> {
    const db = await openCatalog(), tx = db.transaction([table, 'tombstones'], 'readwrite'), done = idbCompleted(tx);
    tx.objectStore(table).delete(id);
    if (table !== 'tombstones') tx.objectStore('tombstones').put({ id: [table, id].join(':'), deletedAt: Date.now() });
    await done; changed(table, [id]);
  },
  async list<T extends CatalogTable>(table: T, options: ListOptions = {}): Promise<CatalogTables[T][]> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return cursorValues(options.index ? store.index(options.index) : store, options);
  },
  async search<T extends CatalogTable>(table: T, matches: (value: CatalogTables[T]) => boolean, options: ListOptions = {}): Promise<CatalogTables[T][]> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return cursorValues(options.index ? store.index(options.index) : store, options, matches);
  },
  async count(table: CatalogTable, options: Pick<ListOptions, 'index' | 'range'> = {}): Promise<number> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return idbRequest((options.index ? store.index(options.index) : store).count(options.range));
  },
  listWorks(options: { offset?: number; limit?: number } = {}) { return catalog.list('works', { ...options, index: 'updatedAt', direction: 'prev' }); },
  listUnits(workId: string, options: { offset?: number; limit?: number } = {}) {
    return catalog.list('units', { limit: 1000, ...options, index: 'workOrder', range: IDBKeyRange.bound([workId, -Infinity], [workId, Infinity]) });
  },
  listDocuments(unitId: string, options: { offset?: number; limit?: number } = {}) { return catalog.list('documents', { limit: 100, ...options, index: 'unitId', range: unitId }); },
  listPages(revisionId: string, options: { offset?: number; limit?: number } = {}) {
    return catalog.list('pageDescriptors', { ...options, index: 'revisionOrdinal', range: IDBKeyRange.bound([revisionId, -Infinity], [revisionId, Infinity]) });
  },
  async putPages(documentId: string, revisionId: string, pages: PageDescriptor[], expectedGeneration: number): Promise<void> {
    const db = await openCatalog(), tx = db.transaction(['documents', 'revisions', 'pageDescriptors'], 'readwrite'), done = idbCompleted(tx);
    const document = await idbRequest(tx.objectStore('documents').get(documentId)) as CatalogTables['documents'] | undefined;
    const revision = await idbRequest(tx.objectStore('revisions').get(revisionId)) as CatalogTables['revisions'] | undefined;
    if (!document || document.generation !== expectedGeneration || document.revisionId !== revisionId || revision?.documentId !== documentId) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    const store = tx.objectStore('pageDescriptors');
    for (const page of pages) {
      if (page.revisionId !== revisionId) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
      const previous = await idbRequest(store.index('revisionLocator').get([revisionId, page.formatLocator])) as PageDescriptor | undefined;
      store.put({ ...page, pageId: previous?.pageId ?? page.pageId });
    }
    await done; changed('pageDescriptors', [revisionId]);
  },
  async savePosition(position: CatalogTables['positions']): Promise<void> {
    const db = await openCatalog(), tx = db.transaction(['documents', 'positions', 'works', 'units', 'pageDescriptors'], 'readwrite'), done = idbCompleted(tx);
    const document = await idbRequest(tx.objectStore('documents').get(position.documentId)) as CatalogTables['documents'] | undefined;
    const previous = await idbRequest(tx.objectStore('positions').get(position.documentId)) as CatalogTables['positions'] | undefined;
    if (!document || document.revisionId !== position.revisionId || (previous && previous.updatedAt > position.updatedAt)) { await done; return; }
    const unit = await idbRequest(tx.objectStore('units').get(document.unitId)) as CatalogTables['units'] | undefined;
    const page = await idbRequest(tx.objectStore('pageDescriptors').get([position.revisionId, position.pageId]));
    if (!unit || unit.workId !== position.workId || !page || previous && previous.pageId === position.pageId && previous.revisionId === position.revisionId && previous.relativeOffset === position.relativeOffset && previous.updatedAt === position.updatedAt) { await done; return; }
    tx.objectStore('positions').put({ ...position, id: position.documentId });
    const work = await idbRequest(tx.objectStore('works').get(position.workId)) as CatalogTables['works'] | undefined;
    if (work) tx.objectStore('works').put({ ...work, lastReadAt: Math.max(work.lastReadAt ?? 0, position.updatedAt) });
    await done; changed('positions', [position.documentId]); changed('works', [position.workId]);
  },
  async putMaterialization(value: CatalogTables['materializations'], expectedGeneration?: number): Promise<boolean> {
    const db = await openCatalog(), tx = db.transaction(['documents', 'revisions', 'pageDescriptors', 'materializations', 'bindings', 'connections'], 'readwrite'), done = idbCompleted(tx);
    const revision = await idbRequest(tx.objectStore('revisions').get(value.revisionId)) as CatalogTables['revisions'] | undefined;
    const document = revision ? await idbRequest(tx.objectStore('documents').get(revision.documentId)) as CatalogTables['documents'] | undefined : undefined;
    const page = await idbRequest(tx.objectStore('pageDescriptors').get([value.revisionId, value.pageId]));
    if (!document || !page || document.revisionId !== value.revisionId || (expectedGeneration !== undefined && document.generation !== expectedGeneration)) { await done; return false; }
    const binding = await idbRequest(tx.objectStore('bindings').get(document.sourceBindingId)) as CatalogTables['bindings'] | undefined;
    const connection = binding ? await idbRequest(tx.objectStore('connections').get(binding.connectionId)) as CatalogTables['connections'] | undefined : undefined;
    if (!binding || !connection || binding.status === 'revoked' || binding.status === 'disconnected' || connection.status === 'revoked' || connection.status === 'disconnected') { await done; return false; }
    tx.objectStore('materializations').put(value); await done; changed('materializations', [value.id]); return true;
  },
  async editTask(id: string, documentId: string, edit: (task: CatalogTables['tasks'] | undefined, document: CatalogTables['documents']) => CatalogTables['tasks'] | undefined): Promise<CatalogTables['tasks'] | undefined> {
    const db = await openCatalog(), tx = db.transaction(['tasks', 'documents'], 'readwrite'), done = idbCompleted(tx);
    const document = await idbRequest(tx.objectStore('documents').get(documentId)) as CatalogTables['documents'] | undefined;
    if (!document) { await done; return undefined; }
    const previous = await idbRequest(tx.objectStore('tasks').get(id)) as CatalogTables['tasks'] | undefined;
    const next = edit(previous, document);
    if (next) tx.objectStore('tasks').put({ ...next, id, documentId }); await done;
    if (next) changed('tasks', [id]); return next;
  },
  deleteDocument(documentId: string, options: {expectedUnitId?:string} = {}) { return deleteEntities({ documentId, expectedUnitId:options.expectedUnitId }); },
  deleteWork(workId: string) { return deleteEntities({ workId }); },
  subscribe(listener: (change: CatalogChange) => void) { listeners.add(listener); broadcast(); return () => { listeners.delete(listener); }; },
};

/** Returns immutable revision/container references for the byte owner to release after commit. */
async function deleteEntities(target: { documentId?: string; workId?: string; expectedUnitId?:string }): Promise<{ revisionIds: string[]; containerIds: string[]; documentIds: string[]; revisions: CatalogTables['revisions'][] }> {
  const tables = Object.keys(schema) as CatalogTable[], db = await openCatalog(), tx = db.transaction(tables, 'readwrite'), done = idbCompleted(tx);
  const allBy = async <T>(table: CatalogTable, index: string, key: string): Promise<T[]> => idbRequest(tx.objectStore(table).index(index).getAll(key));
  const remove = (table: CatalogTable, id: IDBValidKey) => { tx.objectStore(table).delete(id); tx.objectStore('tombstones').put({ id: [table, id].join(':'), deletedAt: Date.now() }); };
  const units = target.workId ? await allBy<CatalogTables['units']>('units', 'workId', target.workId) : [];
  const documents: CatalogTables['documents'][] = [];
  if (target.documentId) {
    const doc = await idbRequest(tx.objectStore('documents').get(target.documentId)) as CatalogTables['documents']|undefined;
    if(doc&&target.expectedUnitId!==undefined&&doc.unitId!==target.expectedUnitId){tx.abort();await done.catch(()=>{});throw Error('版本归属已变化，请刷新后重新选择。');}
    if (doc) documents.push(doc);
  }
  for (const unit of units) documents.push(...await allBy<CatalogTables['documents']>('documents', 'unitId', unit.id));
  const revisionIds: string[] = [], containerIds: string[] = [], removedRevisions: CatalogTables['revisions'][] = [];
  const updatedWorkIds = new Set<string>();
  for (const document of documents) {
    const revisions = await allBy<CatalogTables['revisions']>('revisions', 'documentId', document.id);
    removedRevisions.push(...revisions);
    for (const revision of revisions) {
      revisionIds.push(revision.id); if (revision.containerId) containerIds.push(revision.containerId);
      for (const table of ['pageDescriptors', 'materializations'] as const) {
        const keys = await idbRequest(tx.objectStore(table).index('revisionId').getAllKeys(revision.id));
        for (const key of keys) tx.objectStore(table).delete(key);
      }
      remove('revisions', revision.id);
    }
    for (const table of ['positions', 'tasks', 'acquisitionTasks', 'translationOperations'] as const) {
      const keys = await idbRequest(tx.objectStore(table).index('documentId').getAllKeys(document.id));
      for (const key of keys) remove(table, key);
    }
    remove('documents', document.id);
    const unit = await idbRequest(tx.objectStore('units').get(document.unitId)) as CatalogTables['units'] | undefined;
    if (unit && !target.workId) {
      const remaining = await allBy<CatalogTables['documents']>('documents', 'unitId', unit.id);
      if (!remaining.length) remove('units', unit.id);
      else if (unit.preferredDocumentId === document.id) {
        const replacement = remaining.find(value => value.indexState === 'ready') ?? remaining[0];
        tx.objectStore('units').put({ ...unit, preferredDocumentId: replacement.id, updatedAt: Date.now() });
      }
      const work = await idbRequest(tx.objectStore('works').get(unit.workId)) as CatalogTables['works'] | undefined;
      if (work) { tx.objectStore('works').put({ ...work, documentCount: Math.max(0, (work.documentCount ?? 1) - 1), cover: work.cover?.documentId === document.id ? undefined : work.cover, updatedAt: Date.now() }); updatedWorkIds.add(work.id); }
    }
    const otherReferences = await idbRequest(tx.objectStore('documents').index('sourceBindingId').count(document.sourceBindingId));
    if (!otherReferences) remove('bindings', document.sourceBindingId);
  }
  for (const unit of units) remove('units', unit.id);
  if (target.workId) remove('works', target.workId);
  await done;
  for (const document of documents) changed('documents', [document.id]);
  for (const document of documents) changed('units', [document.unitId]);
  for (const workId of updatedWorkIds) changed('works', [workId]);
  if (target.workId) changed('works', [target.workId]);
  return { revisionIds, containerIds: [...new Set(containerIds)], documentIds: documents.map(item => item.id), revisions: removedRevisions };
}
